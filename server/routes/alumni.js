import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = express.Router();

// Require ALUMNI role
router.use(requireAuth, requireRole('ALUMNI'));

// GET /api/alumni/profile
router.get('/profile', (req, res) => {
  const profile = db.prepare(`
    SELECT ap.*, u.full_name, u.email, u.verification_status, u.verified_at,
           i.name as institution_name, i.short_name as institution_short, i.abbr as institution_abbr
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE ap.user_id = ?
  `).get(req.user.id);

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
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

// PUT /api/alumni/profile
router.put('/profile', (req, res) => {
  const {
    current_company, current_role, industry, location,
    headline, bio, linkedin_url, visibility, skills, graduation_year, degree, branch
  } = req.body;

  const prof = db.prepare('SELECT id FROM alumni_profiles WHERE user_id = ?').get(req.user.id);
  if (!prof) {
    return res.status(404).json({ error: 'Alumni profile not found' });
  }

  const validVis = ['PUBLIC', 'STUDENTS_ONLY', 'HIDDEN'];
  const vis = validVis.includes(visibility) ? visibility : 'PUBLIC';
  const skillsJson = Array.isArray(skills) ? JSON.stringify(skills) : undefined;

  db.prepare(`
    UPDATE alumni_profiles SET
      current_company = COALESCE(?, current_company),
      current_role = COALESCE(?, current_role),
      industry = COALESCE(?, industry),
      location = COALESCE(?, location),
      headline = COALESCE(?, headline),
      bio = COALESCE(?, bio),
      linkedin_url = COALESCE(?, linkedin_url),
      visibility = ?,
      graduation_year = COALESCE(?, graduation_year),
      degree = COALESCE(?, degree),
      branch = COALESCE(?, branch),
      skills_json = COALESCE(?, skills_json)
    WHERE user_id = ?
  `).run(
    current_company, current_role, industry, location,
    headline, bio, linkedin_url, vis,
    graduation_year ? parseInt(graduation_year, 10) : null, degree, branch,
    skillsJson, req.user.id
  );

  // Update current career step if current_role/company changed
  if (current_role || current_company) {
    const currentStep = db.prepare('SELECT id FROM career_steps WHERE alumni_profile_id = ? AND is_current = 1').get(prof.id);
    if (currentStep) {
      db.prepare(`
        UPDATE career_steps SET
          role = COALESCE(?, role),
          company = COALESCE(?, company)
        WHERE id = ?
      `).run(current_role, current_company, currentStep.id);
    }
  }

  res.json({ success: true, message: 'Profile updated' });
});

// PUT /api/alumni/mentorship
router.put('/mentorship', (req, res) => {
  const { is_open_to_mentoring, mentorship_topics } = req.body;

  if (is_open_to_mentoring === undefined) {
    return res.status(400).json({ error: 'is_open_to_mentoring flag required' });
  }

  const topicsJson = Array.isArray(mentorship_topics) ? JSON.stringify(mentorship_topics) : '[]';

  db.prepare(`
    UPDATE alumni_profiles
    SET is_open_to_mentoring = ?, mentorship_topics_json = ?
    WHERE user_id = ?
  `).run(is_open_to_mentoring ? 1 : 0, topicsJson, req.user.id);

  res.json({ success: true, is_open_to_mentoring: Boolean(is_open_to_mentoring), mentorship_topics });
});

// POST /api/alumni/confirm-freshness
router.post('/confirm-freshness', (req, res) => {
  const { location } = req.body;

  db.prepare(`
    UPDATE alumni_profiles
    SET details_confirmed_at = datetime('now'),
        stale_months = 0,
        location = COALESCE(?, location)
    WHERE user_id = ?
  `).run(location || null, req.user.id);

  res.json({ success: true, message: 'Career details confirmed as fresh' });
});

// GET /api/alumni/requests (Inbound mentorship requests)
router.get('/requests', (req, res) => {
  const requests = db.prepare(`
    SELECT r.id, r.topic, r.message, r.status, r.response_note, r.meeting_info,
           r.created_at, r.responded_at,
           u.full_name as student_name, u.email as student_email,
           sp.graduation_year as student_batch, sp.degree as student_degree, sp.branch as student_branch,
           i.short_name as student_institution
    FROM mentorship_requests r
    JOIN users u ON r.student_id = u.id
    JOIN student_profiles sp ON u.id = sp.user_id
    JOIN institutions i ON u.institution_id = i.id
    WHERE r.alumni_id = ?
    ORDER BY r.created_at DESC
  `).all(req.user.id);

  res.json({ requests, count: requests.length });
});

// POST /api/alumni/requests/:id/respond
router.post('/requests/:id/respond', (req, res) => {
  const { status, response_note, meeting_info } = req.body;

  if (!['ACCEPTED', 'DECLINED'].includes(status)) {
    return res.status(400).json({ error: "Status must be 'ACCEPTED' or 'DECLINED'" });
  }

  const request = db.prepare(`
    SELECT id, status, student_id FROM mentorship_requests WHERE id = ? AND alumni_id = ?
  `).get(req.params.id, req.user.id);

  if (!request) {
    return res.status(404).json({ error: 'Mentorship request not found' });
  }

  if (request.status !== 'PENDING') {
    return res.status(400).json({ error: `Cannot change request that is already ${request.status}` });
  }

  if (status === 'ACCEPTED' && !meeting_info) {
    return res.status(400).json({ error: 'Please provide contact/meeting details when accepting (e.g. meeting link or email)' });
  }

  const now = new Date().toISOString();

  db.prepare(`
    UPDATE mentorship_requests SET
      status = ?,
      response_note = ?,
      meeting_info = ?,
      responded_at = ?
    WHERE id = ?
  `).run(
    status,
    response_note || (status === 'ACCEPTED' ? 'Happy to help! Let us connect soon.' : null),
    status === 'ACCEPTED' ? meeting_info : null,
    now,
    request.id
  );

  res.json({
    success: true,
    request_id: request.id,
    status,
    responded_at: now
  });
});

export default router;
