import express from 'express';
import { db } from '../app-db.js';
import { requireAuth } from '../auth.js';
import { activeInstitutionIds } from '../billing.js';
import { viewerSandbox } from '../access.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const LIST_SQL = `
  SELECT i.id, i.name, i.short_name, i.abbr, i.kind, i.domain, i.city, i.state, i.type, i.founded, i.hue, i.about,
         i.website, i.email_domain, i.data_sharing, i.public_profile, i.platform_verified, i.is_sandbox,
    (SELECT COUNT(*) FROM users u WHERE u.institution_id = i.id AND u.role = 'ALUMNI' AND u.verification_status = 'VERIFIED' AND u.is_active = 1) as verified_count,
    (SELECT COUNT(*) FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id
       WHERE u.institution_id = i.id AND u.verification_status = 'VERIFIED' AND u.is_active = 1 AND ap.is_open_to_mentoring = 1) as mentor_count,
    (SELECT COUNT(*) FROM courses c WHERE c.institution_id = i.id) as course_count
  FROM institutions i
`;

function isListed(inst, activeIds, viewer) {
  return inst.platform_verified === 1 && inst.public_profile === 1 && activeIds.includes(inst.id)
    && (inst.is_sandbox ? 1 : 0) === viewerSandbox(viewer);
}

// GET /api/institutions
router.get('/', asyncRoute(async (req, res) => {
  const activeIds = await activeInstitutionIds();
  const rows = await db.all(`${LIST_SQL} ORDER BY verified_count DESC, name ASC`);
  const institutions = rows.filter(i => isListed(i, activeIds, req.user));
  res.json({ institutions });
}));

// GET /api/institutions/joinable
router.get('/joinable', asyncRoute(async (req, res) => {
  const activeIds = await activeInstitutionIds();
  const rows = await db.all(
    'SELECT id, name, short_name, kind, email_domain, is_sandbox FROM institutions ORDER BY name'
  );

  res.json({
    institutions: rows.filter(i =>
      activeIds.includes(i.id) &&
      (i.is_sandbox ? 1 : 0) === viewerSandbox(req.user)
    )
  });
}));

// GET /api/institutions/:id
router.get('/:id', requireAuth, asyncRoute(async (req, res) => {
  const inst = await db.get(`${LIST_SQL} WHERE i.id = ?`, req.params.id);
  const activeIds = await activeInstitutionIds();
  const isMember = inst && req.user.institution_id === inst.id;

  if (!inst || (!isMember && !isListed(inst, activeIds, req.user))) {
    return res.status(404).json({ error: 'Institution not found' });
  }

  const courses = await db.all(`
    SELECT id, name, level, duration_years, seats, annual_fee_inr, eligibility, description
    FROM courses WHERE institution_id = ?
    ORDER BY CASE level WHEN 'SCHOOL' THEN 0 WHEN 'UG' THEN 1 WHEN 'PG' THEN 2 WHEN 'DOCTORAL' THEN 3 ELSE 4 END, name
  `, inst.id);

  const placementRows = await db.all(`
    SELECT year, students_eligible, students_placed, median_ctc_lpa, average_ctc_lpa, highest_ctc_lpa, top_recruiters_json
    FROM placement_stats WHERE institution_id = ? ORDER BY year DESC
  `, inst.id);

  const placements = placementRows.map(p => ({
    ...p,
    placement_rate: p.students_eligible
      ? Math.round((p.students_placed / p.students_eligible) * 1000) / 10
      : null,
    top_recruiters: JSON.parse(p.top_recruiters_json || '[]'),
    top_recruiters_json: undefined
  }));

  // Aggregates only — no individual records leave the institution through this page.
  const verifiedJoin = `
    FROM alumni_profiles ap JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND u.is_active = 1
  `;

  const [
    externalRow,
    abroadRow,
    topEmployers,
    topIndustries,
    topCities,
    higherStudiesRow
  ] = await Promise.all([
    inst.data_sharing === 'PLATFORM'
      ? db.get(`SELECT COUNT(*) as n ${verifiedJoin} AND ap.is_open_to_mentoring = 1 AND ap.open_to_external = 1`, inst.id)
      : Promise.resolve({ n: 0 }),
    db.get(`SELECT COUNT(*) as n ${verifiedJoin} AND ap.location IN ('San Francisco Bay Area','Seattle','London','Singapore','New York')`, inst.id),
    db.all(`SELECT ap.current_company as label, COUNT(*) as count ${verifiedJoin} GROUP BY ap.current_company ORDER BY count DESC, ap.current_company ASC LIMIT 8`, inst.id),
    db.all(`SELECT ap.industry as label, COUNT(*) as count ${verifiedJoin} GROUP BY ap.industry ORDER BY count DESC, ap.industry ASC LIMIT 6`, inst.id),
    db.all(`SELECT ap.location as label, COUNT(*) as count ${verifiedJoin} GROUP BY ap.location ORDER BY count DESC, ap.location ASC LIMIT 6`, inst.id),
    db.get(`SELECT COUNT(*) as n ${verifiedJoin} AND ap.higher_ed IS NOT NULL`, inst.id)
  ]);

  const network = {
    verified_alumni: inst.verified_count,
    open_to_mentoring: inst.mentor_count,
    open_to_external: Number(externalRow?.n ?? 0),
    abroad: Number(abroadRow?.n ?? 0),
    top_employers: topEmployers,
    top_industries: topIndustries,
    top_cities: topCities,
    higher_studies: Number(higherStudiesRow?.n ?? 0)
  };

  res.json({ institution: inst, courses, placements, network, is_member: Boolean(isMember) });
}));

export default router;