// Institution admin API. Every query is scoped to req.user.institution_id —
// an admin can never read or change another institution's data.
import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { getInstitutionAccess, countMembers, requireActiveInstitution, requireFeature, memberLimitReached } from '../billing.js';
import { audit } from '../audit.js';
import { usageReport, usageCsv } from '../usage.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth, requireRole('ADMIN'));

const instOf = (req) => req.user.institution_id;
const one = (sql, ...p) => db.prepare(sql).get(...p);
const n = (sql, ...p) => db.prepare(sql).get(...p).n || 0;

// ---------- Overview ----------

function metricsFor(instId) {
  const alumni = one(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN verification_status = 'VERIFIED' AND is_active = 1 THEN 1 ELSE 0 END) as verified,
      SUM(CASE WHEN verification_status = 'PENDING' THEN 1 ELSE 0 END) as pending
    FROM users WHERE institution_id = ? AND role = 'ALUMNI'
  `, instId);
  const students = one(`
    SELECT SUM(CASE WHEN verification_status = 'VERIFIED' AND is_active = 1 THEN 1 ELSE 0 END) as verified,
      SUM(CASE WHEN verification_status = 'PENDING' THEN 1 ELSE 0 END) as pending
    FROM users WHERE institution_id = ? AND role = 'STUDENT'
  `, instId);
  const reqs = one(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'DECLINED' THEN 1 ELSE 0 END) as declined
    FROM mentorship_requests WHERE institution_id = ?
  `, instId);
  const roster = one(`
    SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) as claimed
    FROM roster_records WHERE institution_id = ?
  `, instId);
  const mentorJoin = `FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1 AND ap.is_open_to_mentoring = 1`;

  return {
    institution_id: instId,
    total_alumni: alumni.total || 0,
    verified_alumni: alumni.verified || 0,
    pending_review: alumni.pending || 0,
    current_students: students.verified || 0,
    pending_students: students.pending || 0,
    open_to_mentoring: n(`SELECT COUNT(*) as n ${mentorJoin}`, instId),
    open_to_external: n(`SELECT COUNT(*) as n ${mentorJoin} AND ap.open_to_external = 1`, instId),
    external_requests: n('SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND is_external = 1', instId),
    internships_open: n("SELECT COUNT(*) as n FROM internships WHERE institution_id = ? AND status = 'OPEN'", instId),
    interested_external_students: n('SELECT COUNT(*) as n FROM external_profiles WHERE interested_institution_id = ?', instId),
    active_members_30d: n(`SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role IN ('STUDENT','ALUMNI') AND is_active = 1 AND last_active_at > datetime('now', '-30 days')`, instId),
    requests: { total: reqs.total || 0, accepted: reqs.accepted || 0, pending: reqs.pending || 0, declined: reqs.declined || 0 },
    roster: { total: roster.total || 0, claimed: roster.claimed || 0 }
  };
}

router.get('/metrics', (req, res) => res.json(metricsFor(instOf(req))));

// GET /api/admin/overview — dashboard header: subscription, usage, onboarding checklist.
router.get('/overview', (req, res) => {
  const instId = instOf(req);
  const metrics = metricsFor(instId);
  const access = getInstitutionAccess(instId);
  const inst = one('SELECT id, name, short_name, kind, data_sharing, public_profile, platform_verified, about FROM institutions WHERE id = ?', instId);

  const checklist = [
    { key: 'profile', label: 'Complete your institution profile', done: Boolean(inst.about), href: '#/admin/institution' },
    { key: 'courses', label: 'Add your courses', done: n('SELECT COUNT(*) as n FROM courses WHERE institution_id = ?', instId) > 0, href: '#/admin/institution' },
    { key: 'roster', label: 'Import a student or alumni roster', done: metrics.roster.total > 0, href: '#/admin/members' },
    { key: 'members', label: 'Verify your first 10 members', done: metrics.verified_alumni + metrics.current_students >= 10, href: '#/admin/members' },
    { key: 'announce', label: 'Post a welcome announcement', done: n('SELECT COUNT(*) as n FROM announcements WHERE institution_id = ?', instId) > 0, href: '#/admin/engagement' },
    { key: 'sharing', label: 'Review data-sharing settings', done: n("SELECT COUNT(*) as n FROM audit_logs WHERE institution_id = ? AND action = 'SETTINGS_UPDATED'", instId) > 0 || inst.data_sharing === 'PLATFORM', href: '#/admin/privacy' }
  ];

  res.json({
    institution: inst,
    metrics,
    subscription: {
      active: access.active, state: access.state, plan: access.plan, days_left: access.days_left, ends_at: access.ends_at,
      billing_cycle: access.subscription?.billing_cycle, features: [...access.features]
    },
    usage: {
      members: countMembers(instId),
      member_limit: access.member_limit,
      admins: n("SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ADMIN'", instId),
      admin_seats: access.admin_seats
    },
    checklist
  });
});

// ---------- Members (students & alumni) ----------

router.get('/members', (req, res) => {
  const instId = instOf(req);
  const type = String(req.query.type || 'STUDENT').toUpperCase() === 'ALUMNI' ? 'ALUMNI' : 'STUDENT';
  const status = String(req.query.status || '').toUpperCase();
  const q = String(req.query.q || '').trim().toLowerCase();

  let sql = `
    SELECT u.id, u.full_name, u.email, u.role, u.verification_status, u.reject_reason, u.verified_at, u.is_active,
           u.last_active_at, u.created_at,
           COALESCE(sp.graduation_year, ap.graduation_year) as graduation_year,
           COALESCE(sp.degree, ap.degree) as degree, COALESCE(sp.branch, ap.branch) as branch,
           sp.roll_number, ap.current_company, ap.current_role, ap.industry, ap.location, ap.is_open_to_mentoring, ap.stale_months,
           (SELECT COUNT(*) FROM mentorship_requests r WHERE r.student_id = u.id OR r.alumni_id = u.id) as mentorship_count
    FROM users u
    LEFT JOIN student_profiles sp ON sp.user_id = u.id
    LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.role = ?
  `;
  const params = [instId, type];
  if (['VERIFIED', 'PENDING', 'REJECTED'].includes(status)) { sql += ' AND u.verification_status = ?'; params.push(status); }
  if (status === 'DEACTIVATED') sql += ' AND u.is_active = 0';
  if (q) {
    sql += ` AND (LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR LOWER(COALESCE(sp.roll_number, '')) LIKE ? OR CAST(COALESCE(sp.graduation_year, ap.graduation_year) AS TEXT) LIKE ? OR LOWER(COALESCE(ap.current_company, '')) LIKE ?)`;
    const t = `%${q}%`;
    params.push(t, t, t, t, t);
  }
  sql += ' ORDER BY u.created_at DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  res.json({ rows, count: rows.length });
});

function getMember(req) {
  return one(`SELECT id, role, full_name, is_active FROM users WHERE id = ? AND institution_id = ? AND role IN ('STUDENT', 'ALUMNI')`, req.params.id, instOf(req));
}

// PATCH /api/admin/members/:id — correct academic record fields.
router.patch('/members/:id', (req, res) => {
  const m = getMember(req);
  if (!m) return res.status(404).json({ error: 'Member not found in your institution' });
  const b = req.body;
  const year = b.graduation_year ? parseInt(b.graduation_year, 10) : null;
  const s = (v, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  if (year && (year < 1950 || year > new Date().getFullYear() + 8)) return res.status(400).json({ error: 'Invalid year' });

  if (m.role === 'STUDENT') {
    db.prepare(`UPDATE student_profiles SET graduation_year = COALESCE(?, graduation_year), degree = COALESCE(?, degree),
      branch = COALESCE(?, branch), roll_number = COALESCE(?, roll_number) WHERE user_id = ?`)
      .run(year, s(b.degree), s(b.branch), s(b.roll_number, 40), m.id);
  } else {
    db.prepare(`UPDATE alumni_profiles SET graduation_year = COALESCE(?, graduation_year), degree = COALESCE(?, degree),
      branch = COALESCE(?, branch) WHERE user_id = ?`).run(year, s(b.degree), s(b.branch), m.id);
  }
  if (s(b.full_name, 80)) db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(s(b.full_name, 80), m.id);
  audit(req, instOf(req), 'MEMBER_RECORD_UPDATED', { targetType: m.role.toLowerCase(), targetId: m.id, details: { fields: Object.keys(b) } });
  res.json({ success: true });
});

router.post('/members/:id/deactivate', (req, res) => {
  const m = getMember(req);
  if (!m) return res.status(404).json({ error: 'Member not found in your institution' });
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(m.id);
  audit(req, instOf(req), 'MEMBER_DEACTIVATED', { targetType: m.role.toLowerCase(), targetId: m.id, details: req.body?.reason || null });
  res.json({ success: true });
});

router.post('/members/:id/reactivate', (req, res) => {
  const m = getMember(req);
  if (!m) return res.status(404).json({ error: 'Member not found in your institution' });
  db.prepare('UPDATE users SET is_active = 1 WHERE id = ?').run(m.id);
  audit(req, instOf(req), 'MEMBER_REACTIVATED', { targetType: m.role.toLowerCase(), targetId: m.id });
  res.json({ success: true });
});

// GET /api/admin/members.csv — the institution's own member list.
router.get('/members.csv', (req, res) => {
  const instId = instOf(req);
  const rows = db.prepare(`
    SELECT u.full_name, u.email, u.role, u.verification_status, u.is_active,
           COALESCE(sp.graduation_year, ap.graduation_year) as year, COALESCE(sp.degree, ap.degree) as degree,
           COALESCE(sp.branch, ap.branch) as branch, sp.roll_number, ap.current_company, ap.current_role, ap.location
    FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.role IN ('STUDENT', 'ALUMNI') ORDER BY u.role, u.full_name
  `).all(instId);
  const cols = ['full_name', 'email', 'role', 'verification_status', 'is_active', 'year', 'degree', 'branch', 'roll_number', 'current_company', 'current_role', 'location'];
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // prevent spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n');
  audit(req, instId, 'MEMBERS_EXPORTED', { details: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
  res.send(csv);
});

// ---------- Alumni directory (legacy table on the overview page) ----------

router.get('/directory', (req, res) => {
  const instId = instOf(req);
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toUpperCase();
  let query = `
    SELECT u.id, u.full_name, u.email, u.verification_status, u.reject_reason, u.verified_at, u.is_active,
           ap.graduation_year, ap.degree, ap.branch, ap.current_company, ap.current_role,
           ap.industry, ap.location, ap.is_open_to_mentoring, ap.visibility, ap.stale_months
    FROM users u LEFT JOIN alumni_profiles ap ON u.id = ap.user_id
    WHERE u.institution_id = ? AND u.role = 'ALUMNI'
  `;
  const params = [instId];
  if (['VERIFIED', 'PENDING', 'REJECTED'].includes(status)) { query += ' AND u.verification_status = ?'; params.push(status); }
  if (q) {
    query += ' AND (LOWER(u.full_name) LIKE ? OR LOWER(ap.current_company) LIKE ? OR LOWER(ap.current_role) LIKE ? OR CAST(ap.graduation_year AS TEXT) LIKE ?)';
    const t = `%${q}%`;
    params.push(t, t, t, t);
  }
  query += ' ORDER BY ap.graduation_year DESC, u.full_name ASC LIMIT 100';
  const rows = db.prepare(query).all(...params);
  res.json({ rows, count: rows.length });
});

// ---------- Verification ----------

router.get('/verification-queue', (req, res) => {
  const instId = instOf(req);
  const pending = db.prepare(`
    SELECT u.id, u.role, u.full_name, u.email, u.created_at,
           COALESCE(ap.graduation_year, sp.graduation_year) as graduation_year,
           COALESCE(ap.degree, sp.degree) as degree, COALESCE(ap.branch, sp.branch) as branch,
           ap.current_company, ap.current_role, ap.industry, ap.location, ap.linkedin_url, ap.bio, sp.roll_number
    FROM users u
    LEFT JOIN alumni_profiles ap ON u.id = ap.user_id
    LEFT JOIN student_profiles sp ON u.id = sp.user_id
    WHERE u.institution_id = ? AND u.role IN ('ALUMNI', 'STUDENT') AND u.verification_status = 'PENDING'
    ORDER BY u.created_at ASC
  `).all(instId);
  const recent = db.prepare(`
    SELECT u.id, u.role, u.full_name, u.verification_status, u.verified_at, u.reject_reason
    FROM users u WHERE u.institution_id = ? AND u.role IN ('ALUMNI', 'STUDENT') AND u.verification_status IN ('VERIFIED', 'REJECTED')
    ORDER BY u.verified_at DESC LIMIT 10
  `).all(instId);
  res.json({ pending, recent_decisions: recent });
});

router.post('/verification/:id/decide', requireActiveInstitution, (req, res) => {
  const instId = instOf(req);
  const { decision, reject_reason } = req.body;
  if (!['VERIFIED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: "Decision must be 'VERIFIED' or 'REJECTED'" });
  }
  if (decision === 'REJECTED' && (!reject_reason || String(reject_reason).trim().length < 5)) {
    return res.status(400).json({ error: 'A specific reason is required to reject (at least 5 characters)' });
  }
  const user = one('SELECT id, institution_id, role, verification_status FROM users WHERE id = ?', req.params.id);
  if (!user || user.institution_id !== instId || !['ALUMNI', 'STUDENT'].includes(user.role)) {
    return res.status(404).json({ error: 'Alumnus or student not found in your institution' });
  }
  if (decision === 'VERIFIED' && user.verification_status !== 'VERIFIED' && memberLimitReached(instId)) {
    return res.status(402).json({ error: 'You have reached the member limit of your plan. Upgrade from Billing to verify more members.', code: 'MEMBER_LIMIT' });
  }

  const now = new Date().toISOString().slice(0, 10);
  if (decision === 'VERIFIED') {
    db.prepare("UPDATE users SET verification_status = 'VERIFIED', verified_at = ?, reject_reason = NULL WHERE id = ?").run(now, user.id);
  } else {
    db.prepare("UPDATE users SET verification_status = 'REJECTED', verified_at = ?, reject_reason = ? WHERE id = ?").run(now, String(reject_reason).trim().slice(0, 300), user.id);
  }
  audit(req, instId, decision === 'VERIFIED' ? 'MEMBER_VERIFIED' : 'MEMBER_REJECTED', { targetType: user.role.toLowerCase(), targetId: user.id });
  res.json({ success: true, user_id: user.id, verification_status: decision, verified_at: now });
});

// ---------- Rosters ----------

// Minimal CSV line parser supporting quoted fields with commas and "" escapes.
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

router.post('/roster/upload', requireActiveInstitution, upload.single('file'), (req, res) => {
  const instId = instOf(req);
  const recordType = String(req.body.record_type || 'ALUMNI').toUpperCase() === 'STUDENT' ? 'STUDENT' : 'ALUMNI';
  let csvContent = '';
  if (req.file) csvContent = req.file.buffer.toString('utf8');
  else if (req.body.csv_text) csvContent = String(req.body.csv_text);
  else return res.status(400).json({ error: 'Please upload a CSV file or provide csv_text' });

  // Keep each line's original number so error messages point at the right row of the file.
  const numbered = csvContent.replace(/^﻿/, '').split(/\r?\n/)
    .map((text, idx) => ({ text: text.trim(), line: idx + 1 })).filter(l => l.text);
  const lines = numbered.map(l => l.text);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV file must contain a header line and at least one data row' });
  if (lines.length > 20001) return res.status(400).json({ error: 'Please import at most 20,000 rows at a time' });

  const header = parseCsvLine(lines[0].toLowerCase());
  const nameIdx = header.findIndex(h => h.includes('name'));
  const emailIdx = header.findIndex(h => h.includes('email'));
  const batchIdx = header.findIndex(h => h.includes('batch') || h.includes('year'));
  const degreeIdx = header.findIndex(h => h.includes('degree') || h.includes('class') || h.includes('course'));
  const branchIdx = header.findIndex(h => h.includes('branch') || h.includes('major') || h.includes('stream'));
  if (nameIdx === -1 || emailIdx === -1) {
    return res.status(400).json({ error: 'CSV must contain at least "name" and "email" columns (e.g. name, email, batch, degree, branch)' });
  }

  const insertRoster = db.prepare(`
    INSERT INTO roster_records (id, institution_id, record_type, email, full_name, graduation_year, degree, branch, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNCLAIMED')
  `);
  const checkExisting = db.prepare('SELECT id FROM roster_records WHERE institution_id = ? AND record_type = ? AND LOWER(email) = ?');
  const defaultYear = new Date().getFullYear();

  let imported = 0;
  let skipped = 0;
  const errors = [];
  db.exec('BEGIN');
  try {
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const fullName = (cols[nameIdx] || '').slice(0, 80);
      const email = (cols[emailIdx] || '').toLowerCase().slice(0, 120);
      const batch = batchIdx !== -1 ? parseInt(cols[batchIdx], 10) || defaultYear : defaultYear;
      const degree = (degreeIdx !== -1 && cols[degreeIdx]) ? cols[degreeIdx].slice(0, 60) : 'General';
      const branch = (branchIdx !== -1 && cols[branchIdx]) ? cols[branchIdx].slice(0, 60) : 'General';
      if (!fullName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (errors.length < 50) errors.push(`Row ${numbered[i].line}: invalid name or email`);
        continue;
      }
      if (checkExisting.get(instId, recordType, email)) { skipped++; continue; }
      insertRoster.run('rr_' + crypto.randomUUID().slice(0, 10), instId, recordType, email, fullName, batch, degree, branch);
      imported++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  audit(req, instId, 'ROSTER_IMPORTED', { details: { record_type: recordType, imported, skipped, errors: errors.length } });
  res.json({ success: true, record_type: recordType, total_rows: lines.length - 1, imported_count: imported, skipped_duplicates: skipped, errors });
});

router.get('/roster', (req, res) => {
  const records = db.prepare(`
    SELECT id, record_type, email, full_name, graduation_year, degree, branch, status, imported_at
    FROM roster_records WHERE institution_id = ? ORDER BY imported_at DESC LIMIT 200
  `).all(instOf(req));
  res.json({ records, count: records.length });
});

// ---------- Outcome analytics ----------

router.get('/analytics', (req, res) => {
  const instId = instOf(req);
  const base = `FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1`;
  res.json({
    by_batch: db.prepare(`SELECT ap.graduation_year as batch, COUNT(*) as count ${base} GROUP BY ap.graduation_year ORDER BY ap.graduation_year DESC`).all(instId),
    by_employer: db.prepare(`SELECT ap.current_company as company, COUNT(*) as count ${base} AND ap.current_company != '' GROUP BY ap.current_company ORDER BY count DESC LIMIT 8`).all(instId),
    by_industry: db.prepare(`SELECT ap.industry, COUNT(*) as count ${base} AND ap.industry != '' GROUP BY ap.industry ORDER BY count DESC LIMIT 8`).all(instId),
    by_location: db.prepare(`SELECT ap.location, COUNT(*) as count ${base} AND ap.location != '' GROUP BY ap.location ORDER BY count DESC LIMIT 8`).all(instId),
    mentor_by_batch: db.prepare(`SELECT ap.graduation_year as batch, COUNT(*) as count ${base} AND ap.is_open_to_mentoring = 1 GROUP BY ap.graduation_year ORDER BY ap.graduation_year DESC`).all(instId),
    freshness: one(`SELECT
        SUM(CASE WHEN ap.stale_months < 12 THEN 1 ELSE 0 END) as fresh,
        SUM(CASE WHEN ap.stale_months >= 12 AND ap.stale_months < 24 THEN 1 ELSE 0 END) as aging,
        SUM(CASE WHEN ap.stale_months >= 24 THEN 1 ELSE 0 END) as stale,
        COUNT(*) as total ${base}`, instId)
  });
});

// ---------- Usage report (counts only, every plan) ----------

router.get('/usage', (req, res) => res.json(usageReport(instOf(req))));

router.get('/usage.csv', (req, res) => {
  const report = usageReport(instOf(req));
  audit(req, instOf(req), 'USAGE_REPORT_EXPORTED');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usage-report-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(usageCsv(report));
});

// ---------- Value report (Growth & Enterprise) ----------

function lastMonths(count) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(m.toISOString().slice(0, 7));
  }
  return out;
}

router.get('/value-report', requireFeature('value_report'), (req, res) => {
  const instId = instOf(req);
  const months = lastMonths(6);
  const since = months[0] + '-01';

  const monthly = (sql) => {
    const rows = db.prepare(sql).all(instId, since);
    const map = new Map(rows.map(r => [r.month, r.n]));
    return months.map(m => map.get(m) || 0);
  };

  const series = {
    new_members: monthly(`SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as n FROM users
      WHERE institution_id = ? AND role IN ('STUDENT','ALUMNI') AND created_at >= ? GROUP BY month`),
    mentorship_requests: monthly(`SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as n FROM mentorship_requests
      WHERE institution_id = ? AND created_at >= ? GROUP BY month`),
    mentorships_accepted: monthly(`SELECT strftime('%Y-%m', responded_at) as month, COUNT(*) as n FROM mentorship_requests
      WHERE institution_id = ? AND status = 'ACCEPTED' AND responded_at >= ? GROUP BY month`),
    internship_applications: monthly(`SELECT strftime('%Y-%m', a.created_at) as month, COUNT(*) as n FROM internship_applications a
      JOIN internships n ON a.internship_id = n.id WHERE n.institution_id = ? AND a.created_at >= ? GROUP BY month`),
    event_rsvps: monthly(`SELECT strftime('%Y-%m', r.created_at) as month, COUNT(*) as n FROM event_rsvps r
      JOIN events e ON r.event_id = e.id WHERE e.institution_id = ? AND r.created_at >= ? GROUP BY month`),
    messages: monthly(`SELECT strftime('%Y-%m', m.created_at) as month, COUNT(*) as n FROM messages m
      JOIN mentorship_requests r ON m.request_id = r.id WHERE r.institution_id = ? AND m.created_at >= ? GROUP BY month`)
  };

  const window = (sql) => ({
    current: n(sql.replace('$RANGE', "> datetime('now', '-30 days')"), instId),
    previous: n(sql.replace('$RANGE', "BETWEEN datetime('now', '-60 days') AND datetime('now', '-30 days')"), instId)
  });
  const last30 = {
    mentorship_requests: window('SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND created_at $RANGE'),
    mentorships_accepted: window("SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND status = 'ACCEPTED' AND responded_at $RANGE"),
    internship_applications: window('SELECT COUNT(*) as n FROM internship_applications a JOIN internships n ON a.internship_id = n.id WHERE n.institution_id = ? AND a.created_at $RANGE'),
    event_rsvps: window('SELECT COUNT(*) as n FROM event_rsvps r JOIN events e ON r.event_id = e.id WHERE e.institution_id = ? AND r.created_at $RANGE'),
    messages: window('SELECT COUNT(*) as n FROM messages m JOIN mentorship_requests r ON m.request_id = r.id WHERE r.institution_id = ? AND m.created_at $RANGE'),
    new_members: window("SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role IN ('STUDENT','ALUMNI') AND created_at $RANGE")
  };

  // Responsiveness of alumni
  const responded = db.prepare(`
    SELECT (julianday(responded_at) - julianday(created_at)) * 24 as hours FROM mentorship_requests
    WHERE institution_id = ? AND responded_at IS NOT NULL ORDER BY hours
  `).all(instId).map(r => r.hours).filter(h => h >= 0);
  const totalRequests = n('SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ?', instId);
  const medianHours = responded.length ? Math.round(responded[Math.floor(responded.length / 2)]) : null;
  const responseRate = totalRequests ? Math.round((responded.length / totalRequests) * 100) : 0;

  const members = countMembers(instId);
  const active30 = n(`SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role IN ('STUDENT','ALUMNI') AND is_active = 1 AND verification_status = 'VERIFIED' AND last_active_at > datetime('now', '-30 days')`, instId);
  const alumniVerified = n(`SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ALUMNI' AND verification_status = 'VERIFIED' AND is_active = 1`, instId);
  const mentors = n(`SELECT COUNT(*) as n FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1 AND ap.is_open_to_mentoring = 1`, instId);
  const fresh = n(`SELECT COUNT(*) as n FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1 AND ap.stale_months < 12`, instId);
  const roster = one("SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) as claimed FROM roster_records WHERE institution_id = ?", instId);
  const stale = n(`SELECT COUNT(*) as n FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1 AND ap.stale_months >= 12`, instId);

  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const components = [
    { key: 'active', label: 'Members active in the last 30 days', value: pct(active30, members), weight: 30 },
    { key: 'response', label: 'Mentorship requests answered', value: responseRate, weight: 25 },
    { key: 'fresh', label: 'Alumni profiles confirmed in the last year', value: pct(fresh, alumniVerified), weight: 20 },
    { key: 'mentors', label: 'Alumni offering mentorship', value: pct(mentors, alumniVerified), weight: 15 },
    { key: 'roster', label: 'Roster records claimed', value: pct(roster.claimed || 0, roster.total || 0), weight: 10 }
  ];
  const healthScore = Math.round(components.reduce((s, c) => s + (c.value * c.weight) / 100, 0));

  res.json({
    months,
    series,
    last_30_days: last30,
    responsiveness: { response_rate_pct: responseRate, median_response_hours: medianHours },
    community: { verified_members: members, active_members_30d: active30, verified_alumni: alumniVerified, mentors, stale_alumni_profiles: stale },
    health: { score: healthScore, components }
  });
});

export default router;
