import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'alumni_platform.db');
export const db = new DatabaseSync(dbPath);

// Enable WAL mode and foreign keys for high performance and integrity
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
`);

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS institutions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      abbr TEXT NOT NULL,
      domain TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      type TEXT NOT NULL,
      founded INTEGER NOT NULL,
      hue INTEGER NOT NULL DEFAULT 214,
      about TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'ALUMNI', 'STUDENT', 'SUPERADMIN')),
      full_name TEXT NOT NULL,
      verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('VERIFIED', 'PENDING', 'REJECTED')),
      reject_reason TEXT,
      verified_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS roster_records (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      email TEXT NOT NULL,
      full_name TEXT NOT NULL,
      graduation_year INTEGER NOT NULL,
      degree TEXT NOT NULL,
      branch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNCLAIMED' CHECK(status IN ('UNCLAIMED', 'CLAIMED')),
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS alumni_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      graduation_year INTEGER NOT NULL,
      degree TEXT NOT NULL,
      branch TEXT NOT NULL,
      current_company TEXT NOT NULL,
      current_role TEXT NOT NULL,
      industry TEXT NOT NULL,
      location TEXT NOT NULL,
      linkedin_url TEXT,
      bio TEXT,
      headline TEXT,
      is_open_to_mentoring INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK(visibility IN ('PUBLIC', 'STUDENTS_ONLY', 'HIDDEN')),
      details_confirmed_at TEXT DEFAULT (datetime('now')),
      stale_months INTEGER NOT NULL DEFAULT 0,
      skills_json TEXT NOT NULL DEFAULT '[]',
      mentorship_topics_json TEXT NOT NULL DEFAULT '[]',
      higher_ed TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS career_steps (
      id TEXT PRIMARY KEY,
      alumni_profile_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      role TEXT NOT NULL,
      company TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      display_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (alumni_profile_id) REFERENCES alumni_profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS student_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      graduation_year INTEGER NOT NULL,
      degree TEXT NOT NULL,
      branch TEXT NOT NULL,
      target_industry TEXT,
      target_role TEXT,
      bio TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mentorship_requests (
      id TEXT PRIMARY KEY,
      institution_id TEXT NOT NULL,
      student_id TEXT NOT NULL,
      alumni_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
      response_note TEXT,
      meeting_info TEXT,
      responded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (alumni_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS saved_alumni (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      alumni_profile_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, alumni_profile_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (alumni_profile_id) REFERENCES alumni_profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_users_inst_role ON users(institution_id, role);
    CREATE INDEX IF NOT EXISTS idx_users_verif ON users(verification_status);
    CREATE INDEX IF NOT EXISTS idx_roster_email ON roster_records(institution_id, email);
    CREATE INDEX IF NOT EXISTS idx_alumni_search ON alumni_profiles(industry, current_company, location, is_open_to_mentoring);
    CREATE INDEX IF NOT EXISTS idx_requests_student ON mentorship_requests(student_id);
    CREATE INDEX IF NOT EXISTS idx_requests_alumni ON mentorship_requests(alumni_id);
    CREATE INDEX IF NOT EXISTS idx_requests_inst ON mentorship_requests(institution_id, status);
  `);
}

initSchema();
