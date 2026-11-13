// Institution profile, data-sharing settings, admin team, audit log, export and deletion.
// These stay available even when the subscription has lapsed, so an institution
// can always take its data out or remove it.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
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

// ---------- Profile ----------

router.get('/', (req, res) => {
  const instId = instOf(req);
  const institution = db.prepare(`
    SELECT id, name, short_name, abbr, kind, type, city, state, founded, about, website, email_domain, contact_email,
           data_sharing, public_profile, platform_verified, created_at
    FROM institutions WHERE id = ?
  `).get(instId);
  const courses = db.prepare('SELECT * FROM courses WHERE institution_id = ? ORDER BY level, name').all(instId);
  const placements = db.prepare('SELECT * FROM placement_stats WHERE institution_id = ? ORDER BY year DESC').all(instId)
    .map(p => ({ ...p, top_recruiters: JSON.parse(p.top_recruiters_json || '[]') }));
  res.json({ institution, courses, placements });
});

router.put('/', (req, res) => {
  const b = req.body;
  const website = s(b.website, 200);
  if (website && !/^https?:\/\//i.test(website)) return res.status(400).json({ error: 'Website must start with http:// or https://' });
  const contact = s(b.contact_email, 120);
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) return res.status(400).json({ error: 'Invalid contact email' });
  const founded = b.founded ? parseInt(b.founded, 10) : null;

  db.prepare(`
    UPDATE institutions SET
      short_name = COALESCE(?, short_name), type = COALESCE(?, type), city = COALESCE(?, city), state = COALESCE(?, state),
      founded = COALESCE(?, founded), about = COALESCE(?, about), website = COALESCE(?, website), contact_email = COALESCE(?, contact_email)
    WHERE id = ?
  `).run(s(b.short_name, 40), s(b.type, 60), s(b.city, 60), s(b.state, 60), founded, s(b.about, 1200), website, contact, instOf(req));
  audit(req, instOf(req), 'PROFILE_UPDATED', { details: { fields: Object.keys(b) } });
  res.json({ success: true });
});

// PUT /api/admin/institution/settings — what leaves the institution's community.
router.put('/settings', (req, res) => {
  const { data_sharing, public_profile } = req.body;
  if (data_sharing !== undefined && !['PRIVATE', 'PLATFORM'].includes(data_sharing)) {
    return res.status(400).json({ error: 'data_sharing must be PRIVATE or PLATFORM' });
  }
  db.prepare(`UPDATE institutions SET data_sharing = COALESCE(?, data_sharing), public_profile = COALESCE(?, public_profile) WHERE id = ?`)
    .run(data_sharing ?? null, public_profile === undefined ? null : (public_profile ? 1 : 0), instOf(req));
  clearInstCache(instOf(req));
  audit(req, instOf(req), 'SETTINGS_UPDATED', { details: { data_sharing, public_profile } });
  res.json({ success: true });
});

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

router.post('/courses', (req, res) => {
  const c = courseFields(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const id = newId('co');
  db.prepare(`INSERT INTO courses (id, institution_id, name, level, duration_years, seats, annual_fee_inr, eligibility, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, instOf(req), c.name, c.level, c.duration, c.seats, c.fee, c.eligibility, c.description);
  audit(req, instOf(req), 'COURSE_ADDED', { targetType: 'course', targetId: id, details: c.name });
  res.status(201).json({ success: true, id });
});

router.put('/courses/:id', (req, res) => {
  const c = courseFields(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const r = db.prepare(`UPDATE courses SET name = ?, level = ?, duration_years = ?, seats = ?, annual_fee_inr = ?, eligibility = ?, description = ?
    WHERE id = ? AND institution_id = ?`).run(c.name, c.level, c.duration, c.seats, c.fee, c.eligibility, c.description, req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Course not found' });
  audit(req, instOf(req), 'COURSE_UPDATED', { targetType: 'course', targetId: req.params.id });
  res.json({ success: true });
});

router.delete('/courses/:id', (req, res) => {
  const r = db.prepare('DELETE FROM courses WHERE id = ? AND institution_id = ?').run(req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Course not found' });
  audit(req, instOf(req), 'COURSE_DELETED', { targetType: 'course', targetId: req.params.id });
  res.json({ success: true });
});

// ---------- Placement records ----------

router.post('/placements', (req, res) => {
  const b = req.body;
  const year = parseInt(b.year, 10);
  const eligible = parseInt(b.students_eligible, 10);
  const placed = parseInt(b.students_placed, 10);
  if (!year || year < 1990 || year > new Date().getFullYear()) return res.status(400).json({ error: 'Invalid year' });
  if (!(eligible > 0) || !(placed >= 0) || placed > eligible) return res.status(400).json({ error: 'Placed students must be between 0 and the number eligible' });
  const num = (v) => (v === '' || v == null ? null : Math.max(0, parseFloat(v) || 0));
  const recruiters = String(b.top_recruiters || '').split(',').map(x => x.trim().slice(0, 60)).filter(Boolean).slice(0, 10);

  db.prepare(`
    INSERT INTO placement_stats (id, institution_id, year, students_eligible, students_placed, median_ctc_lpa, average_ctc_lpa, highest_ctc_lpa, top_recruiters_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(institution_id, year) DO UPDATE SET students_eligible = excluded.students_eligible, students_placed = excluded.students_placed,
      median_ctc_lpa = excluded.median_ctc_lpa, average_ctc_lpa = excluded.average_ctc_lpa, highest_ctc_lpa = excluded.highest_ctc_lpa,
      top_recruiters_json = excluded.top_recruiters_json
  `).run(newId('pl'), instOf(req), year, eligible, placed, num(b.median_ctc_lpa), num(b.average_ctc_lpa), num(b.highest_ctc_lpa), JSON.stringify(recruiters));
  audit(req, instOf(req), 'PLACEMENT_RECORD_SAVED', { details: { year } });
  res.status(201).json({ success: true });
});

router.delete('/placements/:year', (req, res) => {
  const r = db.prepare('DELETE FROM placement_stats WHERE institution_id = ? AND year = ?').run(instOf(req), parseInt(req.params.year, 10));
  if (!r.changes) return res.status(404).json({ error: 'Record not found' });
  audit(req, instOf(req), 'PLACEMENT_RECORD_DELETED', { details: { year: req.params.year } });
  res.json({ success: true });
});

// ---------- Admin team ----------

router.get('/team', (req, res) => {
  const team = db.prepare(`SELECT id, full_name, email, admin_level, last_active_at, created_at FROM users
    WHERE institution_id = ? AND role = 'ADMIN' ORDER BY admin_level DESC, created_at`).all(instOf(req));
  res.json({ team, seats: getInstitutionAccess(instOf(req)).admin_seats });
});

// The owner creates a colleague's admin account and shares the initial password with them directly.
router.post('/team', requireOwner, (req, res) => {
  const instId = instOf(req);
  const name = s(req.body.full_name, 80);
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (password.length < 10) return res.status(400).json({ error: 'Initial password must be at least 10 characters' });
  const domain = db.prepare('SELECT email_domain FROM institutions WHERE id = ?').get(instId).email_domain;
  if (domain && !email.endsWith('@' + domain)) return res.status(400).json({ error: `Admins must use an @${domain} email address` });
  if (db.prepare('SELECT 1 FROM users WHERE LOWER(email) = ?').get(email)) return res.status(409).json({ error: 'An account with this email already exists' });

  const seats = getInstitutionAccess(instId).admin_seats;
  const used = db.prepare("SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ADMIN'").get(instId).n;
  if (used >= seats) return res.status(402).json({ error: `Your plan includes ${seats} admin seats. Upgrade to add more admins.`, code: 'SEAT_LIMIT' });

  const id = newId('u');
  db.prepare(`INSERT INTO users (id, institution_id, email, password_hash, role, admin_level, full_name, verification_status, verified_at)
    VALUES (?, ?, ?, ?, 'ADMIN', 'ADMIN', ?, 'VERIFIED', date('now'))`).run(id, instId, email, hashPassword(password), name);
  audit(req, instId, 'ADMIN_ADDED', { targetType: 'admin', targetId: id, details: email });
  res.status(201).json({ success: true, id });
});

router.delete('/team/:id', requireOwner, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  const r = db.prepare("DELETE FROM users WHERE id = ? AND institution_id = ? AND role = 'ADMIN' AND admin_level = 'ADMIN'").run(req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Admin not found' });
  audit(req, instOf(req), 'ADMIN_REMOVED', { targetType: 'admin', targetId: req.params.id });
  res.json({ success: true });
});

// ---------- Audit log ----------

router.get('/audit', (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const rows = db.prepare(`SELECT id, actor_name, actor_role, action, target_type, target_id, details, created_at
    FROM audit_logs WHERE institution_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(instOf(req), limit);
  res.json({ entries: rows });
});

// ---------- Full data export ----------

router.get('/export', (req, res) => {
  const instId = instOf(req);
  const all = (sql) => db.prepare(sql).all(instId);
  const data = {
    exported_at: new Date().toISOString(),
    format_version: 1,
    note: 'Complete export of your institution’s data. Password hashes are never exported.',
    institution: db.prepare('SELECT * FROM institutions WHERE id = ?').get(instId),
    subscription: db.prepare('SELECT * FROM institution_subscriptions WHERE institution_id = ?').get(instId),
    invoices: all('SELECT * FROM institution_invoices WHERE institution_id = ?'),
    users: all(`SELECT id, email, role, admin_level, full_name, verification_status, reject_reason, verified_at, is_active, last_active_at, created_at
      FROM users WHERE institution_id = ?`),
    student_profiles: all('SELECT sp.* FROM student_profiles sp JOIN users u ON sp.user_id = u.id WHERE u.institution_id = ?'),
    alumni_profiles: all('SELECT ap.* FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ?'),
    career_steps: all('SELECT cs.* FROM career_steps cs JOIN alumni_profiles ap ON cs.alumni_profile_id = ap.id JOIN users u ON ap.user_id = u.id WHERE u.institution_id = ?'),
    roster_records: all('SELECT * FROM roster_records WHERE institution_id = ?'),
    courses: all('SELECT * FROM courses WHERE institution_id = ?'),
    placement_stats: all('SELECT * FROM placement_stats WHERE institution_id = ?'),
    mentorship_requests: all('SELECT * FROM mentorship_requests WHERE institution_id = ?'),
    mentorship_programs: all('SELECT * FROM mentorship_programs WHERE institution_id = ?'),
    program_participants: all('SELECT pp.* FROM program_participants pp JOIN mentorship_programs p ON pp.program_id = p.id WHERE p.institution_id = ?'),
    internships: all('SELECT * FROM internships WHERE institution_id = ?'),
    internship_applications: all('SELECT a.* FROM internship_applications a JOIN internships n ON a.internship_id = n.id WHERE n.institution_id = ?'),
    announcements: all('SELECT * FROM announcements WHERE institution_id = ?'),
    events: all('SELECT * FROM events WHERE institution_id = ?'),
    event_rsvps: all('SELECT r.* FROM event_rsvps r JOIN events e ON r.event_id = e.id WHERE e.institution_id = ?'),
    audit_log: all('SELECT * FROM audit_logs WHERE institution_id = ? ORDER BY created_at')
  };
  // Message contents are private between the student and the mentor, so only counts are exported.
  data.message_counts = all(`SELECT m.request_id, COUNT(*) as messages FROM messages m JOIN mentorship_requests r ON m.request_id = r.id
    WHERE r.institution_id = ? GROUP BY m.request_id`);

  audit(req, instId, 'DATA_EXPORTED', { details: { tables: Object.keys(data).length } });
  res.setHeader('Content-Disposition', `attachment; filename="${instId}-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(data);
});

// ---------- Delete institution ----------

// POST /api/admin/institution/delete { confirm_name, password } — permanent, owner only.
router.post('/delete', requireOwner, (req, res) => {
  const instId = instOf(req);
  const inst = db.prepare('SELECT id, name, kind FROM institutions WHERE id = ?').get(instId);
  const owner = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (String(req.body.confirm_name || '').trim() !== inst.name) {
    return res.status(400).json({ error: 'Type the full institution name exactly to confirm' });
  }
  if (!verifyPassword(String(req.body.password || ''), owner.password_hash)) {
    return res.status(403).json({ error: 'Password is incorrect' });
  }

  db.exec('BEGIN');
  try {
    // Mentorship requests sent by visiting students to this institution's alumni go with the alumni.
    db.prepare('DELETE FROM institutions WHERE id = ?').run(instId); // cascades to every tenant table
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  clearInstCache(instId);
  platformLog('INSTITUTION_DELETED', { institution_id: instId, kind: inst.kind });
  res.json({ success: true, deleted: instId });
});

export default router;
