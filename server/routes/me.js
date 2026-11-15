// Self-service for every member: profile, password, personal data export, account deletion.
import express from 'express';
import { db } from '../app-db.js';
import { requireAuth, hashPassword, verifyPassword } from '../auth.js';
import { audit } from '../audit.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAuth);

const s = (v, max = 120) => (v === undefined || v === null ? null : String(v).trim().slice(0, max));

// PUT /api/me/profile — students and visiting students edit their own details.
// (Alumni use /api/alumni/profile, which has career fields.)
router.put('/profile', asyncRoute(async (req, res) => {
  const u = req.user;
  const b = req.body;
  if (s(b.full_name, 80) && s(b.full_name, 80).length >= 2) {
    await db.run('UPDATE users SET full_name = ? WHERE id = ?', s(b.full_name, 80), u.id);
  }

  if (u.role === 'STUDENT') {
    // Academic fields are part of the institution's record; students can change them only before verification.
    const editableAcademic = u.verification_status !== 'VERIFIED';
    await db.run(`
      UPDATE student_profiles SET target_industry = COALESCE(?, target_industry), target_role = COALESCE(?, target_role),
        bio = COALESCE(?, bio),
        degree = CASE WHEN ? THEN COALESCE(?, degree) ELSE degree END,
        branch = CASE WHEN ? THEN COALESCE(?, branch) ELSE branch END
      WHERE user_id = ?
    `, s(b.target_industry, 60), s(b.target_role, 60), s(b.bio, 1000),
      editableAcademic ? 1 : 0, s(b.degree, 60) || null, editableAcademic ? 1 : 0, s(b.branch, 60) || null, u.id);
  } else if (u.role === 'EXTERNAL') {
    let interested;
    if (b.interested_institution_id !== undefined) {
      interested = b.interested_institution_id ? (await db.get('SELECT id FROM institutions WHERE id = ?', b.interested_institution_id))?.id : null;
    }
    await db.run(`
      UPDATE external_profiles SET current_institution = COALESCE(?, current_institution), current_year = COALESCE(?, current_year),
        field_of_interest = COALESCE(?, field_of_interest), city = COALESCE(?, city),
        interested_institution_id = CASE WHEN ? THEN ? ELSE interested_institution_id END
      WHERE user_id = ?
    `, s(b.current_institution, 120) || null, s(b.current_year, 40), s(b.field_of_interest, 80), s(b.city, 60),
      b.interested_institution_id !== undefined ? 1 : 0, interested ?? null, u.id);
  }
  res.json({ success: true });
}));

// POST /api/me/password { current_password, new_password }
router.post('/password', asyncRoute(async (req, res) => {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!row || !verifyPassword(String(req.body.current_password || ''), row.password_hash)) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }
  const next = String(req.body.new_password || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
  if (req.user.role === 'ADMIN') await audit(req, req.user.institution_id, 'PASSWORD_CHANGED', { targetType: 'admin', targetId: req.user.id });
  res.json({ success: true });
}));

// GET /api/me/export — everything the platform holds about me.
router.get('/export', asyncRoute(async (req, res) => {
  const id = req.user.id;
  const all = (sql, ...p) => db.all(sql, ...p);
  const data = {
    exported_at: new Date().toISOString(),
    account: await db.get(`SELECT id, email, role, full_name, institution_id, verification_status, verified_at, created_at, last_active_at FROM users WHERE id = ?`, id),
    student_profile: (await db.get('SELECT * FROM student_profiles WHERE user_id = ?', id)) || null,
    alumni_profile: (await db.get('SELECT * FROM alumni_profiles WHERE user_id = ?', id)) || null,
    external_profile: (await db.get('SELECT * FROM external_profiles WHERE user_id = ?', id)) || null,
    career_steps: await all('SELECT cs.* FROM career_steps cs JOIN alumni_profiles ap ON cs.alumni_profile_id = ap.id WHERE ap.user_id = ?', id),
    mentorship_requests: await all('SELECT * FROM mentorship_requests WHERE student_id = ? OR alumni_id = ?', id, id),
    messages_sent: await all('SELECT id, request_id, body, created_at FROM messages WHERE sender_id = ?', id),
    internship_applications: await all('SELECT * FROM internship_applications WHERE applicant_id = ?', id),
    internships_posted: await all('SELECT * FROM internships WHERE posted_by = ?', id),
    saved_alumni: await all('SELECT * FROM saved_alumni WHERE user_id = ?', id),
    event_rsvps: await all('SELECT * FROM event_rsvps WHERE user_id = ?', id),
    program_participation: await all('SELECT * FROM program_participants WHERE user_id = ?', id),
    premium_subscriptions: await all('SELECT id, plan_id, amount_inr, started_at, expires_at, payment_ref FROM subscriptions WHERE user_id = ?', id)
  };
  res.setHeader('Content-Disposition', 'attachment; filename="my-data.json"');
  res.json(data);
}));

// POST /api/me/delete { password } — permanently delete my account and personal data.
router.post('/delete', asyncRoute(async (req, res) => {
  const u = req.user;
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', u.id);
  if (!row || !verifyPassword(String(req.body.password || ''), row.password_hash)) {
    return res.status(403).json({ error: 'Password is incorrect' });
  }
  if (u.role === 'ADMIN' && u.admin_level === 'OWNER') {
    return res.status(400).json({ error: 'The institution owner cannot delete their account. Delete the institution from Data & Privacy instead.' });
  }
  if (u.role === 'SUPERADMIN') return res.status(400).json({ error: 'Platform accounts are managed separately' });

  if (u.institution_id && ['STUDENT', 'ALUMNI', 'ADMIN'].includes(u.role)) {
    await audit(req, u.institution_id, 'ACCOUNT_SELF_DELETED', { targetType: u.role.toLowerCase(), targetId: u.id });
  }
  await db.run('DELETE FROM users WHERE id = ?', u.id);
  res.json({ success: true });
}));

export default router;
