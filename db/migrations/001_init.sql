-- Alumni Connect Platform: PostgreSQL schema, migration 001.
--
-- Translated from the SQLite schema in server/db.js (SCHEMA_VERSION 4). This file is NOT applied by
-- the application yet: nothing in the app loads it. It is the target for the SQLite -> PostgreSQL
-- migration and is checked against server/db.js by tests/ddl-parity.test.js.
--
-- Deliberate, behavior-preserving choices:
--   * Dates and timestamps stay TEXT in 'YYYY-MM-DD HH24:MI:SS' / 'YYYY-MM-DD' UTC format, exactly as
--     SQLite stored them, so string comparisons and parsing in the app keep working unchanged.
--     Defaults use statement_timestamp(), the match for SQLite's per-statement datetime('now').
--   * Flags stay INTEGER 0/1 and JSON stays TEXT (the app searches skills_json with LIKE).
--   * REAL becomes DOUBLE PRECISION (PostgreSQL REAL is only 32-bit).
--   * SQLite INTEGER is 64-bit, PostgreSQL INTEGER is 32-bit. Columns that hold money, or that are written
--     from user input with no upper bound (parseInt in the routes), are BIGINT: annual_fee_inr, amount_inr,
--     stipend_inr_month, founded, seats, capacity, mentee_capacity, students_eligible, students_placed and
--     the graduation_year of roster_records and alumni_profiles. The remaining INTEGER columns are flags or
--     values the app range-checks (see db/README.md for the data preflight).
--   * current_role is a reserved word in PostgreSQL, so it is quoted: "current_role".
--   * messages and audit_logs get an identity column, seq, because SQLite code orders by rowid
--     to break ties and PostgreSQL has no rowid. The facade never returns it (db/README.md).
--   * No data is inserted here. schema_migrations is created empty; the migration runner records it.
--   * Plain CREATE TABLE / CREATE INDEX on purpose: if any object already exists the migration FAILS,
--     instead of silently accepting a table of a different shape.
--
-- Run it in one transaction against an EMPTY disposable database, for example: psql -1 -f 001_init.sql
-- Then apply 002_sqlite_compat_functions.sql.

-- Each institution is an isolated tenant. Its community data belongs to it.
CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  abbr TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'COLLEGE' CHECK(kind IN ('COLLEGE', 'SCHOOL')),
  domain TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  type TEXT NOT NULL,
  founded BIGINT NOT NULL,
  hue INTEGER NOT NULL DEFAULT 214,
  about TEXT,
  email_domain TEXT,
  website TEXT,
  contact_email TEXT,
  -- PRIVATE: community visible only to its own members.
  -- PLATFORM: public alumni profiles, opted-in mentors and open internships are
  --           visible to members of other institutions and visiting students.
  data_sharing TEXT NOT NULL DEFAULT 'PRIVATE' CHECK(data_sharing IN ('PRIVATE', 'PLATFORM')),
  -- Courses, placements and aggregate outcome stats shown on the public college page.
  public_profile INTEGER NOT NULL DEFAULT 1,
  -- Set by the platform team after checking the institution is genuine.
  platform_verified INTEGER NOT NULL DEFAULT 0,
  -- Fictional demo institutions for reviewers. Excluded from revenue and usage totals.
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- institution_id is NULL for external (other college / school) students and platform staff.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  institution_id TEXT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ALUMNI', 'STUDENT', 'EXTERNAL', 'SUPERADMIN')),
  admin_level TEXT CHECK(admin_level IN ('OWNER', 'ADMIN')),
  full_name TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('VERIFIED', 'PENDING', 'REJECTED')),
  reject_reason TEXT,
  verified_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  -- Sandbox (reviewer/demo) accounts see only sandbox institutions, and real users never see sandbox data.
  is_sandbox INTEGER NOT NULL DEFAULT 0,
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  name TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('SCHOOL', 'UG', 'PG', 'DOCTORAL', 'DIPLOMA')),
  duration_years DOUBLE PRECISION NOT NULL,
  seats BIGINT,
  annual_fee_inr BIGINT,
  eligibility TEXT,
  description TEXT,
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE placement_stats (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  students_eligible BIGINT NOT NULL,
  students_placed BIGINT NOT NULL,
  median_ctc_lpa DOUBLE PRECISION,
  average_ctc_lpa DOUBLE PRECISION,
  highest_ctc_lpa DOUBLE PRECISION,
  top_recruiters_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(institution_id, year),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

-- Admin-imported records. Members who sign up with a matching email are verified automatically.
CREATE TABLE roster_records (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  record_type TEXT NOT NULL DEFAULT 'ALUMNI' CHECK(record_type IN ('ALUMNI', 'STUDENT')),
  email TEXT NOT NULL,
  full_name TEXT NOT NULL,
  graduation_year BIGINT NOT NULL,
  degree TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNCLAIMED' CHECK(status IN ('UNCLAIMED', 'CLAIMED')),
  imported_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE alumni_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  graduation_year BIGINT NOT NULL,
  degree TEXT NOT NULL,
  branch TEXT NOT NULL,
  current_company TEXT NOT NULL,
  "current_role" TEXT NOT NULL,
  industry TEXT NOT NULL,
  location TEXT NOT NULL,
  linkedin_url TEXT,
  bio TEXT,
  headline TEXT,
  is_open_to_mentoring INTEGER NOT NULL DEFAULT 0,
  open_to_external INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK(visibility IN ('PUBLIC', 'STUDENTS_ONLY', 'HIDDEN')),
  details_confirmed_at TEXT DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  stale_months INTEGER NOT NULL DEFAULT 0,
  skills_json TEXT NOT NULL DEFAULT '[]',
  mentorship_topics_json TEXT NOT NULL DEFAULT '[]',
  higher_ed TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE career_steps (
  id TEXT PRIMARY KEY,
  alumni_profile_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  role TEXT NOT NULL,
  company TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (alumni_profile_id) REFERENCES alumni_profiles(id) ON DELETE CASCADE
);

CREATE TABLE student_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  graduation_year INTEGER NOT NULL,
  degree TEXT NOT NULL,
  branch TEXT NOT NULL,
  roll_number TEXT,
  target_industry TEXT,
  target_role TEXT,
  bio TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE external_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  education_level TEXT NOT NULL CHECK(education_level IN ('SCHOOL', 'COLLEGE')),
  current_institution TEXT NOT NULL,
  current_year TEXT,
  field_of_interest TEXT,
  interested_institution_id TEXT,
  city TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (interested_institution_id) REFERENCES institutions(id) ON DELETE SET NULL
);

-- Premium subscriptions bought by visiting students (B2C).
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  amount_inr BIGINT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  payment_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One current subscription per institution (B2B). History lives in institution_invoices.
CREATE TABLE institution_subscriptions (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY' CHECK(billing_cycle IN ('MONTHLY', 'ANNUAL')),
  status TEXT NOT NULL CHECK(status IN ('TRIALING', 'ACTIVE', 'CANCELLED')),
  trial_ends_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE institution_invoices (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  billing_cycle TEXT NOT NULL,
  amount_inr BIGINT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PAID' CHECK(status IN ('PAID', 'VOID')),
  payment_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

-- Every administrative action on an institution's data, visible to that institution's admins.
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  seq BIGINT GENERATED BY DEFAULT AS IDENTITY,
  institution_id TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

-- Platform-level events that must survive an institution's deletion. No personal data.
CREATE TABLE platform_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE mentorship_programs (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  topic TEXT NOT NULL,
  starts_on TEXT,
  ends_on TEXT,
  mentee_capacity BIGINT,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE program_participants (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('MENTOR', 'MENTEE')),
  matched_with TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(program_id, user_id),
  FOREIGN KEY (program_id) REFERENCES mentorship_programs(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE mentorship_requests (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  alumni_id TEXT NOT NULL,
  program_id TEXT,
  is_external INTEGER NOT NULL DEFAULT 0,
  topic TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  response_note TEXT,
  meeting_info TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (alumni_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (program_id) REFERENCES mentorship_programs(id) ON DELETE SET NULL
);

-- Private conversation on an accepted mentorship. Only the two participants can read it.
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  seq BIGINT GENERATED BY DEFAULT AS IDENTITY,
  request_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (request_id) REFERENCES mentorship_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE saved_alumni (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  alumni_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(user_id, alumni_profile_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (alumni_profile_id) REFERENCES alumni_profiles(id) ON DELETE CASCADE
);

CREATE TABLE internships (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  posted_by TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('REMOTE', 'ONSITE', 'HYBRID')),
  stipend_inr_month BIGINT,
  duration_weeks INTEGER,
  description TEXT NOT NULL,
  skills_json TEXT NOT NULL DEFAULT '[]',
  audience TEXT NOT NULL DEFAULT 'OWN_COLLEGE' CHECK(audience IN ('OWN_COLLEGE', 'ALL')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'CLOSED')),
  deadline TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE,
  FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE internship_applications (
  id TEXT PRIMARY KEY,
  internship_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'APPLIED' CHECK(status IN ('APPLIED', 'SHORTLISTED', 'REJECTED')),
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(internship_id, applicant_id),
  FOREIGN KEY (internship_id) REFERENCES internships(id) ON DELETE CASCADE,
  FOREIGN KEY (applicant_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  author_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'ALL' CHECK(audience IN ('ALL', 'STUDENTS', 'ALUMNI')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  institution_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('ONLINE', 'IN_PERSON')),
  location TEXT,
  audience TEXT NOT NULL DEFAULT 'ALL' CHECK(audience IN ('ALL', 'STUDENTS', 'ALUMNI')),
  capacity BIGINT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

CREATE TABLE event_rsvps (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE(event_id, user_id),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- One row per user per day they used the product: weekly-active history for usage evidence.
CREATE TABLE activity_daily (
  user_id TEXT NOT NULL,
  institution_id TEXT,
  day TEXT NOT NULL,
  PRIMARY KEY (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
);

-- Product feedback from institutions and members, plus entries the team logs by hand
-- (calls, visits). Mirrors the Phase 2 feedback-log columns.
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  institution_id TEXT,
  partner_name TEXT,
  person TEXT NOT NULL,
  person_role TEXT,
  user_id TEXT,
  source TEXT NOT NULL DEFAULT 'IN_APP' CHECK(source IN ('IN_APP', 'LOGGED_BY_TEAM')),
  channel TEXT,
  what_they_said TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('Bug', 'Feature', 'Usability', 'Data or integration', 'Pricing or business')),
  decision TEXT NOT NULL DEFAULT 'New' CHECK(decision IN ('New', 'Shipped', 'In progress', 'Planned', 'Won''t do')),
  decision_reason TEXT,
  shipped_on TEXT,
  evidence TEXT,
  partner_reaction TEXT,
  received_on TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD')),
  created_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at TEXT,
  FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_activity_inst_day ON activity_daily(institution_id, day);
CREATE INDEX idx_feedback_received ON feedback(received_on);
CREATE INDEX idx_users_inst_role ON users(institution_id, role);
CREATE INDEX idx_users_verif ON users(verification_status);
CREATE INDEX idx_roster_email ON roster_records(institution_id, email);
CREATE INDEX idx_alumni_search ON alumni_profiles(industry, current_company, location, is_open_to_mentoring);
CREATE INDEX idx_requests_student ON mentorship_requests(student_id);
CREATE INDEX idx_requests_alumni ON mentorship_requests(alumni_id);
CREATE INDEX idx_requests_inst ON mentorship_requests(institution_id, status);
CREATE INDEX idx_subs_user ON subscriptions(user_id, expires_at);
CREATE INDEX idx_courses_inst ON courses(institution_id);
CREATE INDEX idx_internships_inst ON internships(institution_id, status);
CREATE INDEX idx_audit_inst ON audit_logs(institution_id, created_at);
CREATE INDEX idx_messages_req ON messages(request_id, created_at);
CREATE INDEX idx_events_inst ON events(institution_id, starts_at);
CREATE INDEX idx_ann_inst ON announcements(institution_id, created_at);

-- Applied migrations. Left empty here; the migration runner (a later phase) records versions in it.
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);
