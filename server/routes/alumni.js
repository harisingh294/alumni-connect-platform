import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { MENTORSHIP_TOPICS } from '../access.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Require ALUMNI role
router.use(requireAuth, requireRole('ALUMNI'));

// GET /api/alumni/profile
router.get('/profile', asyncRoute(async (req, res) => {
  const profile = await db.get(`
    SELECT ap.*, u.full_name, u.email, u.verification_status, u.verified_at,
           i.name as institution_name, i.short_name as institution_short, i.abbr as institution_abbr
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE ap.user_id = ?
  `, req.user.id);

  if (!profile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  const steps = await db.all(`
    SELECT * FROM career_steps
    WHERE alumni_profile_id = ?
    ORDER BY display_order ASC, year ASC
  `, profile.id);

  profile.skills = JSON.parse(profile.skills_json || '[]');
  profile.mentorship_topics = JSON.parse(profile.mentorship_topics_json || '[]');
  profile.career_steps = steps;

  res.json(profile);
}));

// PUT /api/alumni/profile
router.put('/profile', asyncRoute(async (req, res) => {
  const {
    current_company, current_role, industry, location,
    headline, bio, linkedin_url, visibility, skills, graduation_year, degree, branch
  } = req.body;

  const prof = await db.get('SELECT id FROM alumni_profiles WHERE user_id = ?', req.user.id);
  if (!prof) {
    return res.status(404).json({ error: 'Alumni profile not found' });
  }

  const validVis = ['PUBLIC', 'STUDENTS_ONLY', 'HIDDEN'];
  if (visibility !== undefined && !validVis.includes(visibility)) {
    return res.status(400).json({ error: 'Invalid visibility' });
  }

  const vis = visibility ?? null;
  if (linkedin_url && !/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(linkedin_url)) {
    return res.status(400).json({ error: 'LinkedIn URL must start with https://linkedin.com/ or https://www.linkedin.com/' });
  }

  const skillsJson = Array.isArray(skills)
    ? JSON.stringify(skills.map(s => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 20))
    : null;

  // Required text: blank or missing keeps the current value. Optional text: '' clears it.
  const req_ = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const opt = (v, max = 1000) => (v === undefined || v === null ? null : String(v).trim().slice(0, max));

  await db.transaction(async tx => {
    await tx.run(`
      UPDATE alumni_profiles SET
        current_company = COALESCE(?, current_company),
        "current_role" = COALESCE(?, "current_role"),
        industry = COALESCE(?, industry),
        location = COALESCE(?, location),
        headline = COALESCE(?, headline),
        bio = COALESCE(?, bio),
        linkedin_url = COALESCE(?, linkedin_url),
        visibility = COALESCE(?, visibility),
        graduation_year = COALESCE(?, graduation_year),
        degree = COALESCE(?, degree),
        branch = COALESCE(?, branch),
        skills_json = COALESCE(?, skills_json)
      WHERE user_id = ?
    `,
      req_(current_company), req_(current_role), req_(industry, 60), req_(location, 60),
      opt(headline, 200), opt(bio), opt(linkedin_url, 300), vis,
      parseInt(graduation_year, 10) || null, req_(degree, 60), req_(branch, 60),
      skillsJson, req.user.id
    );

    // Update current career step if current_role/company changed.
    if (req_(current_role) || req_(current_company)) {
      const currentStep = await tx.get(
        'SELECT id FROM career_steps WHERE alumni_profile_id = ? AND is_current = 1',
        prof.id
      );

      if (currentStep) {
        await tx.run(`
          UPDATE career_steps SET
            role = COALESCE(?, role),
            company = COALESCE(?, company)
          WHERE id = ?
        `, req_(current_role), req_(current_company), currentStep.id);
      }
    }
  });

  res.json({ success: true, message: 'Profile updated' });
}));

// PUT /api/alumni/mentorship
router.put('/mentorship', asyncRoute(async (req, res) => {
  const { is_open_to_mentoring, open_to_external, mentorship_topics } = req.body;

  if (is_open_to_mentoring === undefined && open_to_external === undefined && mentorship_topics === undefined) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  let topicsJson = null;
  if (mentorship_topics !== undefined) {
    if (!Array.isArray(mentorship_topics) || mentorship_topics.some(t => !MENTORSHIP_TOPICS.includes(t))) {
      return res.status(400).json({ error: `Topics must be chosen from: ${MENTORSHIP_TOPICS.join(', ')}` });
    }
    topicsJson = JSON.stringify([...new Set(mentorship_topics)]);
  }

  const toFlag = v => (v === undefined ? null : (v ? 1 : 0));

  await db.run(`
    UPDATE alumni_profiles
    SET is_open_to_mentoring = COALESCE(?, is_open_to_mentoring),
        open_to_external = COALESCE(?, open_to_external),
        mentorship_topics_json = COALESCE(?, mentorship_topics_json)
    WHERE user_id = ?
  `, toFlag(is_open_to_mentoring), toFlag(open_to_external), topicsJson, req.user.id);

  const p = await db.get(
    'SELECT is_open_to_mentoring, open_to_external, mentorship_topics_json FROM alumni_profiles WHERE user_id = ?',
    req.user.id
  );

  if (!p) {
    return res.status(404).json({ error: 'Alumni profile not found' });
  }

  res.json({
    success: true,
    is_open_to_mentoring: Boolean(p.is_open_to_mentoring),
    open_to_external: Boolean(p.open_to_external),
    mentorship_topics: JSON.parse(p.mentorship_topics_json || '[]')
  });
}));

// POST /api/alumni/confirm-freshness
router.post('/confirm-freshness', asyncRoute(async (req, res) => {
  const { location } = req.body;

  await db.run(`
    UPDATE alumni_profiles
    SET details_confirmed_at = datetime('now'),
        stale_months = 0,
        location = COALESCE(?, location)
    WHERE user_id = ?
  `, location || null, req.user.id);

  res.json({ success: true, message: 'Career details confirmed as fresh' });
}));

// GET /api/alumni/requests
router.get('/requests', asyncRoute(async (req, res) => {
  const requests = await db.all(`
    SELECT r.id, r.topic, r.message, r.status, r.response_note, r.meeting_info,
           r.created_at, r.responded_at, r.is_external, r.program_id,
           (SELECT COUNT(*) FROM messages m WHERE m.request_id = r.id) as message_count,
           u.full_name as student_name,
           sp.graduation_year as student_batch, sp.degree as student_degree, sp.branch as student_branch,
           COALESCE(i.short_name, ep.current_institution) as student_institution,
           ep.education_level as external_level, ep.current_year as external_year, ep.field_of_interest as external_interest
    FROM mentorship_requests r
    JOIN users u ON r.student_id = u.id
    LEFT JOIN student_profiles sp ON u.id = sp.user_id
    LEFT JOIN external_profiles ep ON u.id = ep.user_id
    LEFT JOIN institutions i ON u.institution_id = i.id
    WHERE r.alumni_id = ?
    ORDER BY r.created_at DESC
  `, req.user.id);

  res.json({ requests, count: requests.length });
}));

// POST /api/alumni/requests/:id/respond
router.post('/requests/:id/respond', asyncRoute(async (req, res) => {
  const { status, response_note, meeting_info } = req.body;

  if (!['ACCEPTED', 'DECLINED'].includes(status)) {
    return res.status(400).json({ error: "Status must be 'ACCEPTED' or 'DECLINED'" });
  }

  const request = await db.get(`
    SELECT id, status, student_id FROM mentorship_requests WHERE id = ? AND alumni_id = ?
  `, req.params.id, req.user.id);

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

  await db.run(`
    UPDATE mentorship_requests SET
      status = ?,
      response_note = ?,
      meeting_info = ?,
      responded_at = ?
    WHERE id = ?
  `,
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
}));

export default router;