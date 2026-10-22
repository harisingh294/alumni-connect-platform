# Alumni Connect Platform — B2B SaaS MVP

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

### 2. Run Automated Test Suite
```bash
npm test
```
All 9 automated integration and end-to-end tests run in ~1-2 seconds with 0 failures.

### 3. Start the Server
```bash
npm start
```
Open **http://localhost:3000** in any browser.

---

## Seed Test Accounts

> **LOCAL DEMO ACCOUNTS:** The credentials below are for local development/demo use only. Never reuse these passwords or accounts in production.

The database comes pre-populated with deterministic seed data (3 institutions, 119 users, 100+ verified alumni across diverse batches, industries, and cities). You can quickly switch personas using the dropdown in the top-right corner of the web UI:

| Role | Name | Email | Password | Pre-seeded State |
| :--- | :--- | :--- | :--- | :--- |
| **Student** | Ishita Rao | `ishita@example.com` | `student123` | Class of 2027, CS, 1 accepted request, 1 pending request |
| **Alumnus** | Rohan Deshpande | `rohan@example.com` | `alumni123` | Stripe Staff Engineer, verified, open to mentoring |
| **Institution Admin** | Priya Menon | `admin@iitb.ac.in` | `admin123` | IIT Bombay admin, 5 pending claims in queue |
| **Platform Ops** | Operations Team | `superadmin@alumniplatform.com` | `superadmin123` | SuperAdmin oversight |

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
