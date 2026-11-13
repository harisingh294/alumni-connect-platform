// Self-service for every member: profile, password, personal data export, account deletion.
import express from 'express';
import { db } from '../db.js';
import { requireAuth, hashPassword, verifyPassword } from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth);

const s = (v, max = 120) => (v === undefined || v === null ? null : String(v).trim().slice(0, max));

// PUT /api/me/profile — students and visiting students edit their own details.
// (Alumni use /api/alumni/profile, which has career fields.)
router.put('/profile', (req, res) => {
  const u = req.user;
  const b = req.body;
  if (s(b.full_name, 80) && s(b.full_name, 80).length >= 2) {
    db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(s(b.full_name, 80), u.id);
  }

  if (u.role === 'STUDENT') {
    // Academic fields are part of the institution's record; students can change them only before verification.
    const editableAcademic = u.verification_status !== 'VERIFIED';
    db.prepare(`
      UPDATE student_profiles SET target_industry = COALESCE(?, target_industry), target_role = COALESCE(?, target_role),
        bio = COALESCE(?, bio),
        degree = CASE WHEN ? THEN COALESCE(?, degree) ELSE degree END,
        branch = CASE WHEN ? THEN COALESCE(?, branch) ELSE branch END
      WHERE user_id = ?
    `).run(s(b.target_industry, 60), s(b.target_role, 60), s(b.bio, 1000),
      editableAcademic ? 1 : 0, s(b.degree, 60) || null, editableAcademic ? 1 : 0, s(b.branch, 60) || null, u.id);
  } else if (u.role === 'EXTERNAL') {
    let interested;
    if (b.interested_institution_id !== undefined) {
      interested = b.interested_institution_id ? db.prepare('SELECT id FROM institutions WHERE id = ?').get(b.interested_institution_id)?.id : null;
    }
    db.prepare(`
      UPDATE external_profiles SET current_institution = COALESCE(?, current_institution), current_year = COALESCE(?, current_year),
        field_of_interest = COALESCE(?, field_of_interest), city = COALESCE(?, city),
        interested_institution_id = CASE WHEN ? THEN ? ELSE interested_institution_id END
      WHERE user_id = ?
    `).run(s(b.current_institution, 120) || null, s(b.current_year, 40), s(b.field_of_interest, 80), s(b.city, 60),
      b.interested_institution_id !== undefined ? 1 : 0, interested ?? null, u.id);
  }
  res.json({ success: true });
});

// POST /api/me/password { current_password, new_password }
router.post('/password', (req, res) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(req.body.current_password || ''), row.password_hash)) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }
  const next = String(req.body.new_password || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
  if (req.user.role === 'ADMIN') audit(req, req.user.institution_id, 'PASSWORD_CHANGED', { targetType: 'admin', targetId: req.user.id });
  res.json({ success: true });
});

// GET /api/me/export — everything the platform holds about me.
router.get('/export', (req, res) => {
  const id = req.user.id;
  const all = (sql) => db.prepare(sql).all(id);
  const data = {
    exported_at: new Date().toISOString(),
    account: db.prepare(`SELECT id, email, role, full_name, institution_id, verification_status, verified_at, created_at, last_active_at FROM users WHERE id = ?`).get(id),
    student_profile: db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(id) || null,
    alumni_profile: db.prepare('SELECT * FROM alumni_profiles WHERE user_id = ?').get(id) || null,
    external_profile: db.prepare('SELECT * FROM external_profiles WHERE user_id = ?').get(id) || null,
    career_steps: all('SELECT cs.* FROM career_steps cs JOIN alumni_profiles ap ON cs.alumni_profile_id = ap.id WHERE ap.user_id = ?'),
    mentorship_requests: db.prepare('SELECT * FROM mentorship_requests WHERE student_id = ? OR alumni_id = ?').all(id, id),
    messages_sent: all('SELECT id, request_id, body, created_at FROM messages WHERE sender_id = ?'),
    internship_applications: all('SELECT * FROM internship_applications WHERE applicant_id = ?'),
    internships_posted: all('SELECT * FROM internships WHERE posted_by = ?'),
    saved_alumni: all('SELECT * FROM saved_alumni WHERE user_id = ?'),
    event_rsvps: all('SELECT * FROM event_rsvps WHERE user_id = ?'),
    program_participation: all('SELECT * FROM program_participants WHERE user_id = ?'),
    premium_subscriptions: all('SELECT id, plan_id, amount_inr, started_at, expires_at, payment_ref FROM subscriptions WHERE user_id = ?')
  };
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(data);
});

// POST /api/me/delete { password } — permanently delete my account and personal data.
router.post('/delete', (req, res) => {
  const u = req.user;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id);
  if (!verifyPassword(String(req.body.password || ''), row.password_hash)) {
    return res.status(403).json({ error: 'Password is incorrect' });
  }
  if (u.role === 'ADMIN' && u.admin_level === 'OWNER') {
    return res.status(400).json({ error: 'The institution owner cannot delete their account. Delete the institution from Data & Privacy instead.' });
  }
  if (u.role === 'SUPERADMIN') return res.status(400).json({ error: 'Platform accounts are managed separately' });

  if (u.institution_id && ['STUDENT', 'ALUMNI', 'ADMIN'].includes(u.role)) {
    audit(req, u.institution_id, 'ACCOUNT_SELF_DELETED', { targetType: u.role.toLowerCase(), targetId: u.id });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  res.json({ success: true });
});

export default router;
