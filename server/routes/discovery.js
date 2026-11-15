import express from 'express';
import { db } from '../app-db.js';
import { requireAuth } from '../auth.js';
import { canViewAlumnus, mentorshipAccess, isPremium, viewerSandbox } from '../access.js';
import { activeInstitutionIds } from '../billing.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The alumni network is visible to signed-in members only.
router.use(requireAuth, (req, res, next) => {
  if (req.user.role === 'SUPERADMIN') {
    return res.status(403).json({ error: 'Platform staff do not have access to institution community data' });
  }
  next();
});

// SQL fragment applying tenant isolation, institution sharing choice and profile visibility.
async function visibilityClause(viewer, params) {
  const active = await activeInstitutionIds();
  const activeList = active.length ? active.map(() => '?').join(',') : "''";
  let clause = ' AND u.is_active = 1';

  if (viewer.role === 'ADMIN') {
    params.push(viewer.institution_id);
    return clause + ' AND u.institution_id = ?';
  }

  clause += ` AND i.id IN (${activeList}) AND i.is_sandbox = ?`;
  params.push(...active, viewerSandbox(viewer));

  if ((viewer.role === 'STUDENT' || viewer.role === 'ALUMNI') && viewer.institution_id) {
    params.push(viewer.institution_id);
    return clause + ` AND ap.visibility != 'HIDDEN' AND (u.institution_id = ? OR (i.data_sharing = 'PLATFORM' AND ap.visibility = 'PUBLIC'))`;
  }

  return clause + ` AND i.data_sharing = 'PLATFORM' AND ap.visibility = 'PUBLIC'`;
}

// GET /api/discovery/alumni
router.get('/alumni', asyncRoute(async (req, res) => {
  const viewer = req.user;
  const { q, inst, batch, industry, company, role, location, mentor_only, external_only } = req.query;

  const params = [];
  let query = `
    SELECT ap.id as profile_id, ap.user_id, ap.graduation_year, ap.degree, ap.branch,
           ap.current_company, ap."current_role", ap.industry, ap.location,
           ap.is_open_to_mentoring, ap.open_to_external, ap.mentorship_topics_json, ap.skills_json,
           ap.stale_months, ap.higher_ed,
           u.full_name, u.verification_status,
           i.id as institution_id, i.name as institution_name, i.short_name as institution_short,
           i.abbr as institution_abbr, i.hue as institution_hue
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE u.verification_status = 'VERIFIED'
  `;

  query += await visibilityClause(viewer, params);

  if (inst) { query += ' AND i.id = ?'; params.push(String(inst)); }
  if (batch) { query += ' AND ap.graduation_year = ?'; params.push(parseInt(batch, 10)); }
  if (industry) { query += ' AND LOWER(ap.industry) = LOWER(?)'; params.push(String(industry)); }
  if (company) { query += ' AND LOWER(ap.current_company) = LOWER(?)'; params.push(String(company)); }
  if (role) { query += ' AND LOWER(ap."current_role") = LOWER(?)'; params.push(String(role)); }
  if (location) { query += ' AND LOWER(ap.location) = LOWER(?)'; params.push(String(location)); }
  if (mentor_only === '1' || mentor_only === 'true') query += ' AND ap.is_open_to_mentoring = 1';
  if (external_only === '1' || external_only === 'true') {
    query += ' AND ap.is_open_to_mentoring = 1 AND ap.open_to_external = 1';
  }

  if (q && String(q).trim()) {
    const term = `%${String(q).trim().toLowerCase()}%`;
    query += ` AND (LOWER(u.full_name) LIKE ? OR LOWER(ap.current_company) LIKE ? OR LOWER(ap."current_role") LIKE ? OR LOWER(ap.skills_json) LIKE ?)`;
    params.push(term, term, term, term);
  }

  query += ' ORDER BY ap.is_open_to_mentoring DESC, ap.graduation_year DESC, u.full_name ASC, ap.id ASC LIMIT 80';

  const rows = await db.all(query, ...params);
  const results = await Promise.all(rows.map(async r => {
    const access = await mentorshipAccess(viewer, r);
    return {
      ...r,
      skills: JSON.parse(r.skills_json || '[]'),
      mentorship_topics: JSON.parse(r.mentorship_topics_json || '[]'),
      can_request: access.allowed,
      request_block_code: access.allowed ? null : access.code
    };
  }));

  // Filter options are drawn only from profiles this viewer is allowed to see.
  const optParams = [];
  const optWhere = `FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id JOIN institutions i ON u.institution_id = i.id
    WHERE u.verification_status = 'VERIFIED' ${await visibilityClause(viewer, optParams)}`;

  // graduation_year is an INTEGER column: comparing it with '' works in SQLite but is an error in
  // PostgreSQL, so numeric columns only exclude NULL. Text columns exclude NULL and empty strings.
  const distinct = async col => {
    const numeric = col === 'ap.graduation_year';
    const rows = await db.all(`
      SELECT DISTINCT ${col} as value ${optWhere} AND ${numeric ? `${col} IS NOT NULL` : `${col} != ''`}
      ORDER BY ${col} ${numeric ? 'DESC' : 'ASC'}
    `, ...optParams);
    return rows.map(r => r.value);
  };

  const institutions = await db.all(
    `SELECT DISTINCT i.id, i.short_name ${optWhere} ORDER BY i.short_name`,
    ...optParams
  );

  const [batches, industries, companies, roles, locations] = await Promise.all([
    distinct('ap.graduation_year'),
    distinct('ap.industry'),
    distinct('ap.current_company'),
    distinct('ap."current_role"'),
    distinct('ap.location')
  ]);

  res.json({
    results,
    total: results.length,
    filter_options: { institutions, batches, industries, companies, roles, locations }
  });
}));

// GET /api/discovery/alumni/:id
router.get('/alumni/:id', asyncRoute(async (req, res) => {
  const viewer = req.user;

  const profile = await db.get(`
    SELECT ap.*, u.full_name, u.verification_status, u.verified_at, u.is_active,
           i.id as institution_id, i.name as institution_name, i.short_name as institution_short,
           i.abbr as institution_abbr, i.hue as institution_hue
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    JOIN institutions i ON u.institution_id = i.id
    WHERE (ap.id = ? OR ap.user_id = ?)
  `, req.params.id, req.params.id);

  if (!profile || (!profile.is_active && viewer.role !== 'ADMIN') || !(await canViewAlumnus(viewer, profile))) {
    return res.status(404).json({ error: 'Alumnus not found' });
  }

  profile.skills = JSON.parse(profile.skills_json || '[]');
  profile.mentorship_topics = JSON.parse(profile.mentorship_topics_json || '[]');
  profile.career_steps = await db.all(`
    SELECT * FROM career_steps WHERE alumni_profile_id = ? ORDER BY display_order ASC, year ASC
  `, profile.id);

  // Direct LinkedIn access is a Premium perk for students outside the college.
  if (viewer.role === 'EXTERNAL' && !(await isPremium(viewer))) {
    profile.linkedin_url = null;
    profile.linkedin_locked = true;
  }

  const access = await mentorshipAccess(viewer, profile);
  profile.access = { can_request: access.allowed, code: access.code, reason: access.reason };

  const saved = await db.get(
    'SELECT 1 FROM saved_alumni WHERE user_id = ? AND alumni_profile_id = ?',
    viewer.id,
    profile.id
  );
  profile.is_saved = Boolean(saved);

  res.json(profile);
}));

// GET /api/discovery/institutions
router.get('/institutions', (req, res) => {
  res.redirect(307, '/api/institutions');
});

export default router;