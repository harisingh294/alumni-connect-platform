// Institution profile, data-sharing settings, admin team, audit log, export and deletion.
// These stay available even when the subscription has lapsed, so an institution
// can always take its data out or remove it.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole, requireOwner, hashPassword, verifyPassword } from '../auth.js';
import { getInstitutionAccess } from '../billing.js';
import { clearInstCache } from '../access.js';
import { audit, platformLog } from '../audit.js';

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

const instOf = (req) => req.user.institution_id;
const s = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const newId = (p) => `${p}_${crypto.randomUUID().slice(0, 10)}`;
const LEVELS = ['SCHOOL', 'UG', 'PG', 'DOCTORAL', 'DIPLOMA'];
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Profile ----------

router.get('/', asyncRoute(async (req, res) => {
  const instId = instOf(req);
  const institution = await db.get(`
    SELECT id, name, short_name, abbr, kind, type, city, state, founded, about, website, email_domain, contact_email,
           data_sharing, public_profile, platform_verified, created_at
    FROM institutions WHERE id = ?
  `, instId);
  const courses = await db.all('SELECT * FROM courses WHERE institution_id = ? ORDER BY level, name', instId);
  const placementRows = await db.all('SELECT * FROM placement_stats WHERE institution_id = ? ORDER BY year DESC', instId);
  const placements = placementRows.map(p => ({ ...p, top_recruiters: JSON.parse(p.top_recruiters_json || '[]') }));
  res.json({ institution, courses, placements });
}));

router.put('/', asyncRoute(async (req, res) => {
  const b = req.body;
  const website = s(b.website, 200);
  if (website && !/^https?:\/\//i.test(website)) return res.status(400).json({ error: 'Website must start with http:// or https://' });
  const contact = s(b.contact_email, 120);
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return res.status(400).json({ error: 'Invalid contact email' });
  const founded = b.founded ? parseInt(b.founded, 10) : null;

  await db.run(`
    UPDATE institutions SET
      short_name = COALESCE(?, short_name), type = COALESCE(?, type), city = COALESCE(?, city), state = COALESCE(?, state),
      founded = COALESCE(?, founded), about = COALESCE(?, about), website = COALESCE(?, website), contact_email = COALESCE(?, contact_email)
    WHERE id = ?
  `, s(b.short_name, 40), s(b.type, 60), s(b.city, 60), s(b.state, 60), founded, s(b.about, 1200), website, contact, instOf(req));
  await audit(req, instOf(req), 'PROFILE_UPDATED', { details: { fields: Object.keys(b) } });
  res.json({ success: true });
}));

// PUT /api/admin/institution/settings — what leaves the institution's community.
router.put('/settings', asyncRoute(async (req, res) => {
  const { data_sharing, public_profile } = req.body;
  if (data_sharing !== undefined && !['PRIVATE', 'PLATFORM'].includes(data_sharing)) {
    return res.status(400).json({ error: 'data_sharing must be PRIVATE or PLATFORM' });
  }
  await db.run(`UPDATE institutions SET data_sharing = COALESCE(?, data_sharing), public_profile = COALESCE(?, public_profile) WHERE id = ?`,
    data_sharing ?? null, public_profile === undefined ? null : (public_profile ? 1 : 0), instOf(req));
  clearInstCache(instOf(req));
  await audit(req, instOf(req), 'SETTINGS_UPDATED', { details: { data_sharing, public_profile } });
  res.json({ success: true });
}));

// ---------- Courses ----------

function courseFields(b) {
  const name = s(b.name, 120);
  const level = String(b.level || '').toUpperCase();
  const duration = parseFloat(b.duration_years);
  if (!name) return { error: 'Course name is required' };
  if (!LEVELS.includes(level)) return { error: 'Invalid course level' };
  if (!duration || duration <= 0 || duration > 10) return { error: 'Duration must be between 0 and 10 years' };
  const int = (v) => (v === '' || v == null ? null : Math.max(0, parseInt(v, 10) || 0));
  return { name, level, duration, seats: int(b.seats), fee: int(b.annual_fee_inr), eligibility: s(b.eligibility, 200), description: s(b.description, 400) };
}

router.post('/courses', asyncRoute(async (req, res) => {
  const c = courseFields(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const id = newId('co');
  await db.run(`INSERT INTO courses (id, institution_id, name, level, duration_years, seats, annual_fee_inr, eligibility, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, instOf(req), c.name, c.level, c.duration, c.seats, c.fee, c.eligibility, c.description);
  await audit(req, instOf(req), 'COURSE_ADDED', { targetType: 'course', targetId: id, details: c.name });
  res.status(201).json({ success: true, id });
}));

router.put('/courses/:id', asyncRoute(async (req, res) => {
  const c = courseFields(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const r = await db.run(`UPDATE courses SET name = ?, level = ?, duration_years = ?, seats = ?, annual_fee_inr = ?, eligibility = ?, description = ?
    WHERE id = ? AND institution_id = ?`, c.name, c.level, c.duration, c.seats, c.fee, c.eligibility, c.description, req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Course not found' });
  await audit(req, instOf(req), 'COURSE_UPDATED', { targetType: 'course', targetId: req.params.id });
  res.json({ success: true });
}));

router.delete('/courses/:id', asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM courses WHERE id = ? AND institution_id = ?', req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Course not found' });
  await audit(req, instOf(req), 'COURSE_DELETED', { targetType: 'course', targetId: req.params.id });
  res.json({ success: true });
}));

// ---------- Placement records ----------

router.post('/placements', asyncRoute(async (req, res) => {
  const b = req.body;
  const year = parseInt(b.year, 10);
  const eligible = parseInt(b.students_eligible, 10);
  const placed = parseInt(b.students_placed, 10);
  if (!year || year < 1990 || year > new Date().getFullYear()) return res.status(400).json({ error: 'Invalid year' });
  if (!(eligible > 0) || !(placed >= 0) || placed > eligible) return res.status(400).json({ error: 'Placed students must be between 0 and the number eligible' });
  const num = (v) => (v === '' || v == null ? null : Math.max(0, parseFloat(v) || 0));
  const recruiters = String(b.top_recruiters || '').split(',').map(x => x.trim().slice(0, 60)).filter(Boolean).slice(0, 10);

  await db.run(`
    INSERT INTO placement_stats (id, institution_id, year, students_eligible, students_placed, median_ctc_lpa, average_ctc_lpa, highest_ctc_lpa, top_recruiters_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(institution_id, year) DO UPDATE SET students_eligible = excluded.students_eligible, students_placed = excluded.students_placed,
      median_ctc_lpa = excluded.median_ctc_lpa, average_ctc_lpa = excluded.average_ctc_lpa, highest_ctc_lpa = excluded.highest_ctc_lpa,
      top_recruiters_json = excluded.top_recruiters_json
  `, newId('pl'), instOf(req), year, eligible, placed, num(b.median_ctc_lpa), num(b.average_ctc_lpa), num(b.highest_ctc_lpa), JSON.stringify(recruiters));
  await audit(req, instOf(req), 'PLACEMENT_RECORD_SAVED', { details: { year } });
  res.status(201).json({ success: true });
}));

router.delete('/placements/:year', asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM placement_stats WHERE institution_id = ? AND year = ?', instOf(req), parseInt(req.params.year, 10));
  if (!r.changes) return res.status(404).json({ error: 'Record not found' });
  await audit(req, instOf(req), 'PLACEMENT_RECORD_DELETED', { details: { year: req.params.year } });
  res.json({ success: true });
}));

// ---------- Admin team ----------

router.get('/team', asyncRoute(async (req, res) => {
  const team = await db.all(`SELECT id, full_name, email, admin_level, last_active_at, created_at FROM users
    WHERE institution_id = ? AND role = 'ADMIN' ORDER BY admin_level DESC NULLS LAST, created_at, id`, instOf(req));
  const access = await getInstitutionAccess(instOf(req));
  res.json({ team, seats: access.admin_seats });
}));

// The owner creates a colleague's admin account and shares the initial password with them directly.
router.post('/team', requireOwner, asyncRoute(async (req, res) => {
  const instId = instOf(req);
  const name = s(req.body.full_name, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (password.length < 10) return res.status(400).json({ error: 'Initial password must be at least 10 characters' });
  const instRow = await db.get('SELECT email_domain FROM institutions WHERE id = ?', instId);
  const domain = instRow?.email_domain;
  if (domain && !email.endsWith('@' + domain)) return res.status(400).json({ error: `Admins must use an @${domain} email address` });
  const existingUser = await db.get('SELECT 1 FROM users WHERE LOWER(email) = ?', email);
  if (existingUser) return res.status(409).json({ error: 'An account with this email already exists' });

  const access = await getInstitutionAccess(instId);
  const seats = access.admin_seats;
  const countRow = await db.get("SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ADMIN'", instId);
  const used = countRow?.n || 0;
  if (used >= seats) return res.status(402).json({ error: `Your plan includes ${seats} admin seats. Upgrade to add more admins.`, code: 'SEAT_LIMIT' });

  const id = newId('u');
  await db.run(`INSERT INTO users (id, institution_id, email, password_hash, role, admin_level, full_name, verification_status, verified_at)
    VALUES (?, ?, ?, ?, 'ADMIN', 'ADMIN', ?, 'VERIFIED', date('now'))`, id, instId, email, hashPassword(password), name);
  await audit(req, instId, 'ADMIN_ADDED', { targetType: 'admin', targetId: id, details: email });
  res.status(201).json({ success: true, id });
}));

router.delete('/team/:id', requireOwner, asyncRoute(async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  const r = await db.run("DELETE FROM users WHERE id = ? AND institution_id = ? AND role = 'ADMIN' AND admin_level = 'ADMIN'", req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Admin not found' });
  await audit(req, instOf(req), 'ADMIN_REMOVED', { targetType: 'admin', targetId: req.params.id });
  res.json({ success: true });
}));

// ---------- Audit log ----------

router.get('/audit', asyncRoute(async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const rows = await db.all(`SELECT id, actor_name, actor_role, action, target_type, target_id, details, created_at
    FROM audit_logs WHERE institution_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, instOf(req), limit);
  res.json({ entries: rows });
}));

// ---------- Full data export ----------

router.get('/export', asyncRoute(async (req, res) => {
  const instId = instOf(req);
  const all = (sql) => db.all(sql, instId);
  const [
    institution,
    subscription,
    invoices,
    users,
    student_profiles,
    alumni_profiles,
    career_steps,
    roster_records,
    courses,
    placement_stats,
    mentorship_requests,
    mentorship_programs,
    program_participants,
    internships,
    internship_applications,
    announcements,
    events,
    event_rsvps,
    audit_log,
    message_counts
  ] = await Promise.all([
    db.get('SELECT * FROM institutions WHERE id = ?', instId),
    db.get('SELECT * FROM institution_subscriptions WHERE institution_id = ?', instId),
    all('SELECT * FROM institution_invoices WHERE institution_id = ?'),
    all(`SELECT id, email, role, admin_level, full_name, verification_status, reject_reason, verified_at, is_active, last_active_at, created_at
      FROM users WHERE institution_id = ?`),
    all('SELECT sp.* FROM student_profiles sp JOIN users u ON sp.user_id = u.id WHERE u.institution_id = ?'),
    all('SELECT ap.* FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ?'),
    all('SELECT cs.* FROM career_steps cs JOIN alumni_profiles ap ON cs.alumni_profile_id = ap.id JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ?'),
    all('SELECT * FROM roster_records WHERE institution_id = ?'),
    all('SELECT * FROM courses WHERE institution_id = ?'),
    all('SELECT * FROM placement_stats WHERE institution_id = ?'),
    all('SELECT * FROM mentorship_requests WHERE institution_id = ?'),
    all('SELECT * FROM mentorship_programs WHERE institution_id = ?'),
    all('SELECT pp.* FROM program_participants pp JOIN mentorship_programs p ON pp.program_id = p.id WHERE p.institution_id = ?'),
    all('SELECT * FROM internships WHERE institution_id = ?'),
    all('SELECT a.* FROM internship_applications a JOIN internships n ON a.internship_id = n.id WHERE n.institution_id = ?'),
    all('SELECT * FROM announcements WHERE institution_id = ?'),
    all('SELECT * FROM events WHERE institution_id = ?'),
    all('SELECT r.* FROM event_rsvps r JOIN events e ON r.event_id = e.id WHERE e.institution_id = ?'),
    all('SELECT id, institution_id, actor_id, actor_name, actor_role, action, target_type, target_id, details, created_at FROM audit_logs WHERE institution_id = ? ORDER BY created_at'),
    all(`SELECT m.request_id, COUNT(*) as messages FROM messages m JOIN mentorship_requests r ON m.request_id = r.id
      WHERE r.institution_id = ? GROUP BY m.request_id`)
  ]);

  const data = {
    exported_at: new Date().toISOString(),
    format_version: 1,
    note: 'Complete export of your institution’s data. Password hashes are never exported.',
    institution,
    subscription,
    invoices,
    users,
    student_profiles,
    alumni_profiles,
    career_steps,
    roster_records,
    courses,
    placement_stats,
    mentorship_requests,
    mentorship_programs,
    program_participants,
    internships,
    internship_applications,
    announcements,
    events,
    event_rsvps,
    audit_log,
    message_counts
  };

  await audit(req, instId, 'DATA_EXPORTED', { details: { tables: Object.keys(data).length } });
  res.setHeader('Content-Disposition', `attachment; filename="${instId}-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
}));

// ---------- Delete institution ----------

// POST /api/admin/institution/delete { confirm_name, password } — permanent, owner only.
router.post('/delete', requireOwner, asyncRoute(async (req, res) => {
  const instId = instOf(req);
  const inst = await db.get('SELECT id, name, kind FROM institutions WHERE id = ?', instId);
  const owner = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (String(req.body.confirm_name || '').trim() !== inst.name) {
    return res.status(400).json({ error: 'Type the full institution name exactly to confirm' });
  }
  if (!verifyPassword(String(req.body.password || ''), owner.password_hash)) {
    return res.status(403).json({ error: 'Password is incorrect' });
  }

  await db.transaction(async (tx) => {
    // Mentorship requests sent by visiting students to this institution's alumni go with the alumni.
    await tx.run('DELETE FROM institutions WHERE id = ?', instId); // cascades to every tenant table
  });
  clearInstCache(instId);
  await platformLog('INSTITUTION_DELETED', { institution_id: instId, kind: inst.kind });
  res.json({ success: true, deleted: instId });
}));

export default router;
