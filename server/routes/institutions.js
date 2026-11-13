import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { activeInstitutionIds } from '../billing.js';
import { viewerSandbox } from '../access.js';

const router = express.Router();

const LIST_SQL = `
  SELECT i.id, i.name, i.short_name, i.abbr, i.kind, i.domain, i.city, i.state, i.type, i.founded, i.hue, i.about,
         i.website, i.email_domain, i.data_sharing, i.public_profile, i.platform_verified, i.is_sandbox,
    (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role = 'ALUMNI' AND u.verification_status = 'VERIFIED' AND u.is_active = 1) as verified_count,
    (SELECT COUNT(*) FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id
       WHERE u.institution_id = i.id AND u.verification_status = 'VERIFIED' AND u.is_active = 1 AND ap.is_open_to_mentoring = 1) as mentor_count,
    (SELECT COUNT(*) FROM courses c WHERE c.institution_id = i.id) as course_count
  FROM institutions i
`;

// Listed publicly = verified by the platform, opted into a public profile, subscription active,
// and in the same world as the viewer (sandbox reviewer accounts see only fictional sandbox institutions).
function isListed(inst, activeIds, viewer) {
  return inst.platform_verified === 1 && inst.public_profile === 1 && activeIds.includes(inst.id)
    && (inst.is_sandbox ? 1 : 0) === viewerSandbox(viewer);
}

// GET /api/institutions — public directory of listed institutions.
router.get('/', (req, res) => {
  const activeIds = activeInstitutionIds();
  const institutions = db.prepare(`${LIST_SQL} ORDER BY verified_count DESC`).all().filter(i => isListed(i, activeIds, req.user));
  res.json({ institutions });
});

// GET /api/institutions/joinable — institutions members can sign up to (active subscription).
router.get('/joinable', (req, res) => {
  const activeIds = activeInstitutionIds();
  const rows = db.prepare('SELECT id, name, short_name, kind, email_domain, is_sandbox FROM institutions ORDER BY name').all()
    .filter(i => activeIds.includes(i.id) && (i.is_sandbox ? 1 : 0) === viewerSandbox(req.user));
  res.json({ institutions: rows });
});

// GET /api/institutions/:id — full institution page: courses, placements, aggregate outcomes.
// Members of the institution always see it; everyone else only if it is listed publicly.
router.get('/:id', requireAuth, (req, res) => {
  const inst = db.prepare(`${LIST_SQL} WHERE i.id = ?`).get(req.params.id);
  const activeIds = activeInstitutionIds();
  const isMember = inst && req.user.institution_id === inst.id;
  if (!inst || (!isMember && !isListed(inst, activeIds, req.user))) {
    return res.status(404).json({ error: 'Institution not found' });
  }

  const courses = db.prepare(`
    SELECT id, name, level, duration_years, seats, annual_fee_inr, eligibility, description
    FROM courses WHERE institution_id = ?
    ORDER BY CASE level WHEN 'SCHOOL' THEN 0 WHEN 'UG' THEN 1 WHEN 'PG' THEN 2 WHEN 'DOCTORAL' THEN 3 ELSE 4 END, name
  `).all(inst.id);

  const placements = db.prepare(`
    SELECT year, students_eligible, students_placed, median_ctc_lpa, average_ctc_lpa, highest_ctc_lpa, top_recruiters_json
    FROM placement_stats WHERE institution_id = ? ORDER BY year DESC
  `).all(inst.id).map(p => ({
    ...p,
    placement_rate: p.students_eligible ? Math.round((p.students_placed / p.students_eligible) * 1000) / 10 : null,
    top_recruiters: JSON.parse(p.top_recruiters_json || '[]'),
    top_recruiters_json: undefined
  }));

  // Aggregates only — no individual records leave the institution through this page.
  const verifiedJoin = `
    FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1
  `;
  const network = {
    verified_alumni: inst.verified_count,
    open_to_mentoring: inst.mentor_count,
    open_to_external: inst.data_sharing === 'PLATFORM'
      ? db.prepare(`SELECT COUNT(*) as n ${verifiedJoin} AND ap.is_open_to_mentoring = 1 AND ap.open_to_external = 1`).get(inst.id).n
      : 0,
    abroad: db.prepare(`SELECT COUNT(*) as n ${verifiedJoin} AND ap.location IN ('San Francisco Bay Area','Seattle','London','Singapore','New York')`).get(inst.id).n,
    top_employers: db.prepare(`SELECT ap.current_company as label, COUNT(*) as count ${verifiedJoin} GROUP BY ap.current_company ORDER BY count DESC LIMIT 8`).all(inst.id),
    top_industries: db.prepare(`SELECT ap.industry as label, COUNT(*) as count ${verifiedJoin} GROUP BY ap.industry ORDER BY count DESC LIMIT 6`).all(inst.id),
    top_cities: db.prepare(`SELECT ap.location as label, COUNT(*) as count ${verifiedJoin} GROUP BY ap.location ORDER BY count DESC LIMIT 6`).all(inst.id),
    higher_studies: db.prepare(`SELECT COUNT(*) as n ${verifiedJoin} AND ap.higher_ed IS NOT NULL`).get(inst.id).n
  };

  res.json({ institution: inst, courses, placements, network, is_member: Boolean(isMember) });
});

export default router;
