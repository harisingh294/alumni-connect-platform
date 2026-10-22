import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = express.Router();

// GET /api/discovery/alumni (Public & Student search - only VERIFIED & PUBLIC profiles)
router.get('/alumni', (req, res) => {
  const {
    q, inst, batch, industry, company, role, location, mentor_only
  } = req.query;

  let query = `
    SELECT ap.id as profile_id, ap.user_id, ap.graduation_year, ap.degree, ap.branch,
           ap.current_company, ap.current_role, ap.industry, ap.location,
           ap.is_open_to_mentoring, ap.mentorship_topics_json, ap.skills_json,
           ap.stale_months, ap.higher_ed,
           u.full_name, u.verification_status,
           i.id as institution_id, i.name as institution_name, i.short_name as institution_short,
           i.abbr as institution_abbr, i.hue as institution_hue
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE u.verification_status = 'VERIFIED' AND ap.visibility = 'PUBLIC'
  `;
  const params = [];

  if (inst) {
    query += ` AND i.id = ?`;
    params.push(inst);
  }
  if (batch) {
    query += ` AND ap.graduation_year = ?`;
    params.push(parseInt(batch, 10));
  }
  if (industry) {
    query += ` AND LOWER(ap.industry) = LOWER(?)`;
    params.push(industry);
  }
  if (company) {
    query += ` AND LOWER(ap.current_company) = LOWER(?)`;
    params.push(company);
  }
  if (role) {
    query += ` AND LOWER(ap.current_role) = LOWER(?)`;
    params.push(role);
  }
  if (location) {
    query += ` AND LOWER(ap.location) = LOWER(?)`;
    params.push(location);
  }
  if (mentor_only === '1' || mentor_only === 'true') {
    query += ` AND ap.is_open_to_mentoring = 1`;
  }
  if (q && q.trim()) {
    const term = `%${q.trim().toLowerCase()}%`;
    query += ` AND (
      LOWER(u.full_name) LIKE ? OR
      LOWER(ap.current_company) LIKE ? OR
      LOWER(ap.current_role) LIKE ? OR
      LOWER(ap.skills_json) LIKE ?
    )`;
    params.push(term, term, term, term);
  }

  query += ` ORDER BY ap.is_open_to_mentoring DESC, ap.graduation_year DESC LIMIT 80`;

  const rows = db.prepare(query).all(...params);

  // Parse JSON fields
  const results = rows.map(r => ({
    ...r,
    skills: JSON.parse(r.skills_json || '[]'),
    mentorship_topics: JSON.parse(r.mentorship_topics_json || '[]')
  }));

  // Unique filter options for frontend dropdowns
  const filterOptions = {
    institutions: db.prepare('SELECT id, short_name FROM institutions').all(),
    batches: db.prepare(`
      SELECT DISTINCT ap.graduation_year as value
      FROM alumni_profiles ap
      JOIN users u ON ap.user_id = u.id
      WHERE u.verification_status = 'VERIFIED'
      ORDER BY ap.graduation_year DESC
    `).all().map(b => b.value),
    industries: db.prepare(`
      SELECT DISTINCT ap.industry as value
      FROM alumni_profiles ap
      JOIN users u ON ap.user_id = u.id
      WHERE u.verification_status = 'VERIFIED' AND ap.industry != ''
      ORDER BY ap.industry ASC
    `).all().map(i => i.value),
    companies: db.prepare(`
      SELECT DISTINCT ap.current_company as value
      FROM alumni_profiles ap
      JOIN users u ON ap.user_id = u.id
      WHERE u.verification_status = 'VERIFIED' AND ap.current_company != ''
      ORDER BY ap.current_company ASC
    `).all().map(c => c.value),
    roles: db.prepare(`
      SELECT DISTINCT ap.current_role as value
      FROM alumni_profiles ap
      JOIN users u ON ap.user_id = u.id
      WHERE u.verification_status = 'VERIFIED' AND ap.current_role != ''
      ORDER BY ap.current_role ASC
    `).all().map(r => r.value),
    locations: db.prepare(`
      SELECT DISTINCT ap.location as value
      FROM alumni_profiles ap
      JOIN users u ON ap.user_id = u.id
      WHERE u.verification_status = 'VERIFIED' AND ap.location != ''
      ORDER BY ap.location ASC
    `).all().map(l => l.value)
  };

  res.json({ results, total: results.length, filter_options: filterOptions });
});

// GET /api/discovery/alumni/:id (Profile detail view)
router.get('/alumni/:id', (req, res) => {
  const profile = db.prepare(`
    SELECT ap.*, u.full_name, u.verification_status, u.verified_at,
           i.id as institution_id, i.name as institution_name, i.short_name as institution_short,
           i.abbr as institution_abbr, i.hue as institution_hue
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE (ap.id = ? OR ap.user_id = ?)
  `).get(req.params.id, req.params.id);

  if (!profile) {
    return res.status(404).json({ error: 'Alumnus not found' });
  }

  const steps = db.prepare(`
    SELECT * FROM career_steps
    WHERE alumni_profile_id = ?
    ORDER BY display_order ASC, year ASC
  `).all(profile.id);

  profile.skills = JSON.parse(profile.skills_json || '[]');
  profile.mentorship_topics = JSON.parse(profile.mentorship_topics_json || '[]');
  profile.career_steps = steps;

  res.json(profile);
});

// GET /api/discovery/institutions
router.get('/institutions', (req, res) => {
  const institutions = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role = 'ALUMNI' AND u.verification_status = 'VERIFIED') as verified_count,
      (SELECT COUNT(*) FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id WHERE u.institution_id = i.id AND u.verification_status = 'VERIFIED' AND ap.is_open_to_mentoring = 1) as mentor_count
    FROM institutions i
    ORDER BY verified_count DESC
  `).all();

  res.json({ institutions });
});

// POST /api/student/save/:alumni_profile_id (Toggle bookmark)
router.post('/save/:alumni_profile_id', requireAuth, requireRole('STUDENT'), (req, res) => {
  const profId = req.params.alumni_profile_id;
  const existing = db.prepare('SELECT id FROM saved_alumni WHERE user_id = ? AND alumni_profile_id = ?').get(req.user.id, profId);

  if (existing) {
    db.prepare('DELETE FROM saved_alumni WHERE id = ?').run(existing.id);
    return res.json({ saved: false, message: 'Removed from saved' });
  } else {
    db.prepare(`
      INSERT INTO saved_alumni (id, user_id, alumni_profile_id)
      VALUES (?, ?, ?)
    `).run('sa_' + crypto.randomUUID().slice(0, 8), req.user.id, profId);
    return res.json({ saved: true, message: 'Alumnus saved' });
  }
});

// GET /api/student/saved
router.get('/saved', requireAuth, requireRole('STUDENT'), (req, res) => {
  const saved = db.prepare(`
    SELECT sa.id as save_id, ap.*, u.full_name, i.short_name as institution_short, i.abbr as institution_abbr
    FROM saved_alumni sa
    JOIN alumni_profiles ap ON sa.alumni_profile_id = ap.id
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE sa.user_id = ?
    ORDER BY sa.created_at DESC
  `).all(req.user.id);

  res.json({ saved });
});

// POST /api/student/requests (Send structured mentorship request)
router.post('/requests', requireAuth, requireRole('STUDENT'), (req, res) => {
  const { alumni_id, topic, message } = req.body;

  if (!alumni_id || !topic || !message) {
    return res.status(400).json({ error: 'Alumnus, mentorship topic, and message are required' });
  }

  if (message.trim().length < 30) {
    return res.status(400).json({
      error: 'Please write at least 30 characters — specific questions receive much higher response rates.'
    });
  }

  // Check alumnus exists, is verified, and open to mentoring
  const alumnus = db.prepare(`
    SELECT u.id, u.institution_id, u.verification_status, ap.is_open_to_mentoring, ap.mentorship_topics_json
    FROM users u
    JOIN alumni_profiles ap ON u.id = ap.user_id
    WHERE (u.id = ? OR ap.id = ?) AND u.role = 'ALUMNI'
  `).get(alumni_id, alumni_id);

  if (!alumnus) {
    return res.status(404).json({ error: 'Target alumnus not found' });
  }

  if (alumnus.verification_status !== 'VERIFIED') {
    return res.status(400).json({ error: 'Target alumnus is not yet verified by the institution' });
  }

  if (!alumnus.is_open_to_mentoring) {
    return res.status(400).json({ error: 'This alumnus is currently not accepting mentorship requests' });
  }

  // Check if topic is allowed
  const topics = JSON.parse(alumnus.mentorship_topics_json || '[]');
  if (topics.length > 0 && !topics.includes(topic)) {
    return res.status(400).json({ error: `Selected topic is not offered by this mentor. Offered topics: ${topics.join(', ')}` });
  }

  // Check for duplicate pending request
  const existingPending = db.prepare(`
    SELECT id FROM mentorship_requests
    WHERE student_id = ? AND alumni_id = ? AND status = 'PENDING'
  `).get(req.user.id, alumnus.id);

  if (existingPending) {
    return res.status(409).json({ error: 'You already have a pending mentorship request with this alumnus' });
  }

  const reqId = 'req_' + crypto.randomUUID().slice(0, 8);
  db.prepare(`
    INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, topic, message, status)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING')
  `).run(reqId, req.user.institution_id, req.user.id, alumnus.id, topic, message.trim());

  res.status(201).json({
    success: true,
    request_id: reqId,
    status: 'PENDING',
    message: 'Mentorship request submitted successfully'
  });
});

// GET /api/student/requests (Track sent requests & view unlocked meeting info)
router.get('/requests', requireAuth, requireRole('STUDENT'), (req, res) => {
  const requests = db.prepare(`
    SELECT r.id, r.topic, r.message, r.status, r.response_note,
           r.meeting_info, r.created_at, r.responded_at,
           u.id as alumni_user_id, u.full_name as alumni_name,
           ap.current_role as alumni_role, ap.current_company as alumni_company,
           ap.graduation_year as alumni_batch,
           i.short_name as alumni_institution, i.abbr as alumni_abbr
    FROM mentorship_requests r
    JOIN users u ON r.alumni_id = u.id
    JOIN alumni_profiles ap ON u.id = ap.user_id
    JOIN institutions i ON u.institution_id = i.id
    WHERE r.student_id = ?
    ORDER BY r.created_at DESC
  `).all(req.user.id);

  res.json({ requests, count: requests.length });
});

export default router;
