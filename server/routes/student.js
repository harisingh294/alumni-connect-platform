import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { mentorshipAccess, sendBlocked, MENTORSHIP_TOPICS, canViewAlumnus } from '../access.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAuth, requireRole('STUDENT', 'EXTERNAL'));

// POST /api/student/save/:alumni_profile_id
router.post('/save/:alumni_profile_id', asyncRoute(async (req, res) => {
  const profId = req.params.alumni_profile_id;

  const alum = await db.get(`
    SELECT ap.id, ap.user_id, ap.visibility, u.institution_id, u.verification_status
    FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE ap.id = ?
  `, profId);

  if (!alum || !(await canViewAlumnus(req.user, alum))) {
    return res.status(404).json({ error: 'Alumnus not found' });
  }

  const existing = await db.get(
    'SELECT id FROM saved_alumni WHERE user_id = ? AND alumni_profile_id = ?',
    req.user.id,
    profId
  );

  if (existing) {
    await db.run('DELETE FROM saved_alumni WHERE id = ?', existing.id);
    return res.json({ saved: false, message: 'Removed from saved' });
  }

  await db.run(
    'INSERT INTO saved_alumni (id, user_id, alumni_profile_id) VALUES (?, ?, ?)',
    'sa_' + crypto.randomUUID().slice(0, 8),
    req.user.id,
    profId
  );

  return res.json({ saved: true, message: 'Alumnus saved' });
}));

// GET /api/student/saved
router.get('/saved', asyncRoute(async (req, res) => {
  const saved = await db.all(`
    SELECT sa.id as save_id, ap.id, ap.user_id, ap.graduation_year, ap.current_company, ap."current_role",
           u.full_name, i.short_name as institution_short, i.abbr as institution_abbr
    FROM saved_alumni sa
    JOIN alumni_profiles ap ON sa.alumni_profile_id = ap.id
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE sa.user_id = ?
    ORDER BY sa.created_at DESC
  `, req.user.id);

  res.json({ saved });
}));

// POST /api/student/requests
router.post('/requests', asyncRoute(async (req, res) => {
  const { alumni_id, topic } = req.body;
  const message = String(req.body.message || '').trim();

  if (!alumni_id || !topic || !message) {
    return res.status(400).json({ error: 'Alumnus, mentorship topic, and message are required' });
  }
  if (message.length < 30) {
    return res.status(400).json({ error: 'Please write at least 30 characters — specific questions receive much higher response rates.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Please keep your message under 2000 characters.' });
  }

  const alumnus = await db.get(`
    SELECT u.id as user_id, u.institution_id, u.verification_status,
           ap.is_open_to_mentoring, ap.open_to_external, ap.mentorship_topics_json, ap.visibility
    FROM users u
    JOIN alumni_profiles ap ON u.id = ap.user_id
    WHERE (u.id = ? OR ap.id = ?) AND u.role = 'ALUMNI'
  `, alumni_id, alumni_id);

  if (!alumnus || !(await canViewAlumnus(req.user, alumnus))) {
    return res.status(404).json({ error: 'Target alumnus not found' });
  }

  const access = await mentorshipAccess(req.user, alumnus);
  if (!access.allowed) return sendBlocked(res, access);

  const topics = JSON.parse(alumnus.mentorship_topics_json || '[]');
  const allowedTopics = topics.length ? topics : MENTORSHIP_TOPICS;

  if (!allowedTopics.includes(topic)) {
    return res.status(400).json({
      error: `Selected topic is not offered by this mentor. Offered topics: ${allowedTopics.join(', ')}`
    });
  }

  const existingPending = await db.get(`
    SELECT id FROM mentorship_requests
    WHERE student_id = ? AND alumni_id = ? AND status = 'PENDING'
  `, req.user.id, alumnus.user_id);

  if (existingPending) {
    return res.status(409).json({ error: 'You already have a pending mentorship request with this alumnus' });
  }

  const reqId = 'req_' + crypto.randomUUID().slice(0, 8);

  await db.run(`
    INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, is_external, topic, message, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `,
    reqId,
    alumnus.institution_id,
    req.user.id,
    alumnus.user_id,
    req.user.role === 'EXTERNAL' ? 1 : 0,
    topic,
    message
  );

  res.status(201).json({
    success: true,
    request_id: reqId,
    status: 'PENDING',
    message: 'Mentorship request submitted successfully'
  });
}));

// GET /api/student/requests
router.get('/requests', asyncRoute(async (req, res) => {
  const requests = await db.all(`
    SELECT r.id, r.topic, r.message, r.status, r.response_note,
           r.meeting_info, r.created_at, r.responded_at, r.program_id,
           (SELECT COUNT(*) FROM messages m WHERE m.request_id = r.id) as message_count,
           u.id as alumni_user_id, u.full_name as alumni_name,
           ap."current_role" as alumni_role, ap.current_company as alumni_company,
           ap.graduation_year as alumni_batch,
           i.short_name as alumni_institution, i.abbr as alumni_abbr
    FROM mentorship_requests r
    JOIN users u ON r.alumni_id = u.id
    JOIN alumni_profiles ap ON u.id = ap.user_id
    JOIN institutions i ON u.institution_id = i.id
    WHERE r.student_id = ?
    ORDER BY r.created_at DESC
  `, req.user.id);

  res.json({ requests, count: requests.length });
}));

export default router;