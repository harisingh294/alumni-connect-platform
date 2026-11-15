# AlumVerse — Alumni Network & Mentorship Platform for Colleges and Schools

A focused B2B SaaS platform for educational institutions to maintain a verified alumni network, track career outcomes, and enable students to connect with alumni through an institution-approved, structured mentorship system.

---

## Authoritative Core Value Loop

$$\text{Institution Onboards Roster} \longrightarrow \text{Alumni Maintain Profile \& Set Mentorship} \longrightarrow \text{Student Discovers \& Sends Structured Inquiry} \longrightarrow \text{Alumni Accepts \& Exchanges Coordinates} \longrightarrow \text{Institution Observes Engagement}$$

---

## Tech Stack & Architecture

* **Backend**: Node.js v24 + Express ESM REST API
* **Database**: Native `node:sqlite` (SQLite WAL mode, indexed relational schema)
* **Authentication**: Token-based session management, cryptographically salted password hashing (`crypto.scryptSync`)
* **CSV Processing**: Native multipart/buffered parser with column mapping, format sanitization, and duplicate checking
* **Frontend**: Pure modern ES Modules, responsive layout shell, AlumVerse design system tokens, 7-dimension search filter, accessible modal dialogs, and SVG icons
* **Testing**: Native `node:test` automated test suite with full end-to-end closed-loop verification

---

## Quick Start & Verification

### 0. Configure the JWT Secret

Before starting the server, set `JWT_SECRET` in your local environment. Use a long, randomly generated secret and keep it private. Do not commit the secret or share it in chat.

For a temporary PowerShell session, set it before running `npm start`:

```powershell
$env:JWT_SECRET = [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
```

This example is suitable for local development only. For a persistent setup, use your operating system or deployment platform's secret-management mechanism. Every environment must provide `JWT_SECRET`; the server intentionally refuses to start without it.

### 1. Install & Seed
```bash
npm install
npm run seed
```
`npm run seed` wipes and rebuilds the local database, so it never runs silently. Without a confirmation it prints the exact path of the database it would destroy and stops, **without opening or creating that database**. To go ahead, repeat that path: `npm run seed -- --confirm-wipe=<that exact path>`. It is refused unconditionally in production (`NODE_ENV=production` or `RENDER=true`); no flag overrides this.

`npm run seed:sandbox` adds the **fictional** reviewer institutions, accounts and activity data. It is never silent either: `npm run seed:sandbox -- --confirm-sandbox=<that exact path>`. In production it is refused unless `SANDBOX=on` is set, so a production database that does not opt in never receives fictional data from the command line. (The Platform console's "Rebuild sandbox" button and the `SANDBOX=on` start-up seed are separate, deliberate features and are unchanged.) See `DEPLOYMENT.md` for hosting.

### 2. Run Automated Test Suite
```bash
npm test
```
49 API tests run in about 5 seconds. `npm test` loads `tests/preload.js` into every test process, which gives each process its own brand-new temporary database in your operating system's temp folder and deletes it afterwards. Your real database is never touched, whatever `DATA_DIR`, `DB_FILE` or `DATABASE_URL` are set to. To run one file: `node --import ./tests/preload.js tests/api.test.js`. Running a test file with plain `node` fails immediately instead of risking a real database.

### 3. Start the Server
```bash
npm start
```
Open **http://localhost:3000** in any browser.

---

## Seed Test Accounts

> **SANDBOX ACCOUNTS:** These belong to **fictional** institutions that use the reserved `.example` domain. Sandbox accounts see only sandbox institutions, and real users never see them. Sandbox activity is excluded from revenue, usage evidence and the feedback log.

The sandbox has 3 fictional colleges and 1 fictional school, about 190 users, institution subscriptions in different states, and six months of mentorship, messaging, internship and event activity. Every sandbox account shares one password: **`Sandbox@2026`**.

| Role | Name | Email | Pre-seeded state |
| :--- | :--- | :--- | :--- |
| **Student** | Ishita Rao | `ishita@example.com` | Westbridge Tech, accepted and pending requests |
| **Alumnus** | Rohan Deshpande | `rohan@example.com` | Staff Engineer at Stripe, open to mentoring |
| **Institution owner (Growth, annual)** | Priya Menon | `admin@westbridge.example` | Pending claims, a mentorship program, events |
| **Institution admin** | Rahul Iyer | `alumni.office@westbridge.example` | Non-owner admin |
| **Institution owner (Starter)** | Sunita Bhatt | `admin@lakeview.example` | Starter plan feature limits |
| **Institution owner (trial)** | Arvind Khanna | `admin@meridian.example` | 12 trial days left |
| **School owner (lapsed)** | Dr. Lata Kulkarni | `principal@greenfield.example` | Trial expired, private sharing |
| **Visiting student (free)** | Aarav Khanna | `aarav.school@example.com` | Class 12 |
| **Visiting student (Premium)** | Meera Joshi | `meera.premium@example.com` | Active annual plan |
| **Platform team (local only)** | Operations Team | `superadmin@alumniplatform.com` / `superadmin123` | Created only by the local full seed. In production the platform account comes from `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`. |

Each account type logs in through its own portal (`#/login/student`, `#/login/alumni`, `#/login/external`, `#/login/admin`, `#/login/platform`). Logging in through the wrong portal is refused with a link to the right one. One-click demo login is shown on the login pages unless `NODE_ENV=production` (override with `ENABLE_DEMO_LOGIN=true|false`).

## User Types & Access

| | Current student | Alumni | Visiting student (free) | Visiting student (Premium) |
| :--- | :--- | :--- | :--- | :--- |
| Signup | College, roll no., college email | College, batch, job | School/college, interests | — |
| Verification | Instant with college email domain, otherwise admin review | Instant on roster match, otherwise admin review | None | None |
| College courses, placements, network stats | ✅ | ✅ | ✅ | ✅ |
| Browse alumni profiles | ✅ | ✅ | ✅ (no LinkedIn) | ✅ |
| Mentorship requests | Free, own college's alumni | Receives them | ❌ | Alumni who opted in to mentor other colleges |
| Internships | Own college's + open-to-all | Posts them, reviews applicants | ❌ | Open-to-all only |

Access rules are enforced on the server in `server/access.js`; the UI only mirrors them.

## Institution Subscriptions (B2B)

Colleges and schools self-register at `#/register-institution`. The registering owner must use an email on the institution's own domain, and each domain can register only once. Every new institution starts a 30-day trial with **private** data sharing. It appears in the public college list only after the platform team verifies it.

| Plan | Monthly | Annual | Members | Admin seats | Extras |
| :--- | ---: | ---: | ---: | ---: | :--- |
| Starter | ₹4,999 | ₹49,990 | 1,000 | 2 | Core features |
| Growth | ₹12,999 | ₹1,29,990 | 5,000 | 5 | + mentorship programs, events, value report |
| Enterprise | ₹29,999 | ₹2,99,990 | Unlimited | 15 | + priority support |

Schools pay 40% less. Plans live in `server/billing.js`. When a subscription lapses, community features pause for that institution's members. Admins keep access to billing, export, the audit log and deletion.

**Institution admin dashboard** covers these areas:
- **Overview:** onboarding checklist and usage against plan limits.
- **Students & Alumni:** verify, edit records, deactivate, CSV export, and student and alumni roster import.
- **Mentorship:** demand by topic, top mentors, and programs with one-click matching.
- **Internships:** post and moderate listings, and review applicants.
- **Announcements & Events:** posts and events with RSVPs.
- **Analytics & Value:** monthly trends, response times, a community health score and outcome analytics.
- **Profile & Courses**, **Admin Team** (owner-managed), **Plan & Billing** and **Data & Privacy**.

## Data Protection

These rules are enforced in code (`server/access.js`, `server/routes/*`) and covered by tests:

- **Tenant isolation:** every admin query is scoped to the admin's own institution, and an admin cannot browse another institution's community.
- **Private by default:** a community is visible outside its institution only when that institution sets data sharing to `PLATFORM`.
- **No platform-staff access to member data:** the platform console shows accounts, billing and counts only. Platform staff are blocked from admin, member, discovery and internship APIs.
- **Institution control:** admins get a full JSON export, a members CSV and an audit log of every administrative action. The owner can delete the institution with name and password confirmation, which cascades to all of its data.
- **Member control:** students and alumni can edit their profile, change their password, export their data and delete their account. Mentorship messages are visible only to the two participants and are excluded from institution exports.
- **Security:** login and signup rate limiting, security headers, and immediate lockout of deactivated accounts.

The data-protection commitments still need a formal Data Processing Agreement reviewed by legal counsel before launch. That includes alignment with India's DPDP Act, 2023. Production also needs email verification, ideally by one-time code, so that domain-based verification can be trusted.

## Premium Payments

Institution checkout (`/api/billing/checkout`) and visiting-student checkout are both **simulated**: neither collects card details.

Visiting-student checkout is **simulated**: it records a subscription with a `DEMO-` reference and never collects card details. To charge real money, replace `POST /api/subscriptions/checkout` with a payment-gateway flow (for example Razorpay Orders plus webhook signature verification) and activate the plan only from the verified webhook.

---

## Core Features Implemented

1. **Authentication & Hybrid Roster Match**:
   * Admin imports CSV roster.
   * Alumni who register with a matching roster email are **instantly auto-verified**.
   * Alumni who register without a pre-existing roster entry enter the **Verification Queue** for admin review.
2. **Institution Admin Workspace**:
   * Dashboard with real-time KPI metrics (Total alumni, Verified percentage, Awaiting review, Active mentors, Request outcomes).
   * Verification Queue with one-click **Approve & Publish** or **Reject with Reason**.
   * Full searchable Alumni Directory with status filters.
   * Outcome Analytics (Cohort distributions, top employers, industries, cities, and data freshness panel).
3. **Alumni Profile & Mentorship Management**:
   * Comprehensive career details and verified career trajectory steps.
   * Mentorship Availability switch (`ON` / `OFF`) and topics selector (*Resume Review*, *Career Guidance*, *Mock Interview*).
   * Data Freshness confirmation ("Still correct" button).
   * Inbound Mentorship Requests Inbox with Accept/Decline actions.
4. **Student Discovery & Mentorship Handshake**:
   * 7-dimension search & filter (Institution, Batch, Industry, Company, Role, Location, Mentorship Availability).
   * Structured Mentorship Request modal enforcing topic selection and $\ge 30$-character question length.
   * Contact details stay private until accepted.
   * **Closed-loop Contact Reveal**: Once an alumnus accepts, their meeting link (e.g. Google Meet) or email is unlocked and displayed on the student's request dashboard.

## Phase 2 tooling (design partners)

- **Usage evidence.** Platform console → Usage evidence shows each real institution's account creation date, active users, records created and week-by-week activity for the last 4 weeks. It holds counts only and downloads as CSV. Institution admins get the same report for their own institution under Analytics & Value. Daily activity is recorded in `activity_daily`.
- **Feedback log.** Every signed-in user has a **Feedback** button. The platform team can log feedback from calls and visits, and record decisions. A shipped item needs a date and evidence, and a "won't do" needs a reason. The log exports as CSV with the brief's exact columns, newest first.
- **Reviewer sandbox.** Fictional institutions with realistic data for faculty test logins. Rebuild them from Platform console → Reviewer sandbox, or with `npm run seed:sandbox`. Real data is never touched.
- **Submission pack.** `../Phase2_Submission/` holds the demo script, MVP access doc, partner templates, pricing worksheet, post-mortem template and checklist.

### Phase 2 test data (sandbox only)

The sandbox seed also loads data for testing every Phase 2 tool. None of it is design-partner evidence:
- **Realistic account ages,** with no activity dated before an institution joined.
- **Usage covering every "weeks used" case:** Westbridge and Lakeview 3 of 3, Meridian 2 of 3, Greenfield 0 of 3.
- **A brand-new empty institution,** `principal@northgate.example`.
- **A 12-entry feedback log** covering every type and decision. It is hidden by default and labelled `[SANDBOX TEST DATA]` in CSV exports.
- **Sample roster files** in `sample-data/`, each with its expected import result.
