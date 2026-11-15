import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { internshipAccess, sendBlocked, viewerSandbox } from '../access.js';
import { activeInstitutionIds, getInstitutionAccess, sendInactive } from '../billing.js';
import { audit } from '../audit.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAuth, (req, res, next) => {
  if (req.user.role === 'SUPERADMIN') return res.status(403).json({ error: 'Platform staff do not have access to institution community data' });
  next();
});

const MODES = ['REMOTE', 'ONSITE', 'HYBRID'];
const AUDIENCES = ['OWN_COLLEGE', 'ALL'];

const BASE_SELECT = `
  SELECT n.id, n.institution_id, n.title, n.company, n.location, n.mode, n.stipend_inr_month, n.duration_weeks,
         n.description, n.skills_json, n.audience, n.status, n.deadline, n.created_at,
         u.id as poster_id, u.full_name as poster_name, u.role as poster_role, ap."current_role" as poster_role_title,
         i.short_name as institution_short,
         (SELECT COUNT(*) FROM internship_applications a WHERE a.internship_id = n.id) as application_count
  FROM internships n
  JOIN users u ON n.posted_by = u.id
  LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
  JOIN institutions i ON n.institution_id = i.id
`;

const parse = (r) => ({ ...r, skills: JSON.parse(r.skills_json || '[]'), skills_json: undefined });

// Rows a learner may see: their own institution's openings, plus openings shared
// with everyone by active institutions that chose platform sharing.
async function learnerScope(user, params) {
  const active = await activeInstitutionIds();
  const list = active.length ? active.map(() => '?').join(',') : "''";
  const shared = `(n.audience = 'ALL' AND i.data_sharing = 'PLATFORM' AND i.id IN (${list}) AND i.is_sandbox = ?)`;
  if (user.role === 'STUDENT') {
    params.push(user.institution_id, ...active, viewerSandbox(user));
    return `n.status = 'OPEN' AND (n.institution_id = ? OR ${shared})`;
  }
  params.push(...active, viewerSandbox(user));
  return `n.status = 'OPEN' AND ${shared}`;
}

function validatePosting(b) {
  const title = String(b.title || '').trim().slice(0, 100);
  const company = String(b.company || '').trim().slice(0, 80);
  const location = String(b.location || '').trim().slice(0, 60);
  const description = String(b.description || '').trim().slice(0, 3000);
  const mode = String(b.mode || '').toUpperCase();
  const audience = String(b.audience || 'OWN_COLLEGE').toUpperCase();
  if (!title || !company || !location) return { error: 'Title, company and location are required' };
  if (description.length < 30) return { error: 'Please describe the internship in at least 30 characters' };
  if (!MODES.includes(mode)) return { error: 'Mode must be Remote, On-site or Hybrid' };
  if (!AUDIENCES.includes(audience)) return { error: 'Invalid audience' };
  const stipend = b.stipend_inr_month === '' || b.stipend_inr_month == null ? null : Math.max(0, parseInt(b.stipend_inr_month, 10) || 0);
  const weeks = b.duration_weeks ? Math.max(1, Math.min(104, parseInt(b.duration_weeks, 10) || 0)) : null;
  const skills = Array.isArray(b.skills) ? b.skills.map(s => String(s).trim().slice(0, 40)).filter(Boolean).slice(0, 12) : [];
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline || '')) ? b.deadline : null;
  return { title, company, location, description, mode, audience, stipend, weeks, skills, deadline };
}

// GET /api/internships
router.get('/', asyncRoute(async (req, res) => {
  const user = req.user;

  if (user.role === 'ADMIN') {
    const rows = await db.all(`${BASE_SELECT} WHERE n.institution_id = ? ORDER BY n.created_at DESC`, user.institution_id);
    return res.json({ internships: rows.map(parse) });
  }

  const access = await internshipAccess(user);
  if (!access.allowed) {
    const row = await db.get(`SELECT COUNT(*) as n FROM internships n JOIN institutions i ON n.institution_id = i.id
      WHERE n.status = 'OPEN' AND n.audience = 'ALL' AND i.data_sharing = 'PLATFORM' AND i.is_sandbox = ?`, viewerSandbox(user));
    const activeCount = row?.n ?? 0;
    return res.status(['PREMIUM_REQUIRED', 'INSTITUTION_INACTIVE'].includes(access.code) ? 402 : 403)
      .json({ error: access.reason, code: access.code, open_count: activeCount });
  }

  const params = [];
  const where = await learnerScope(user, params);
  const rows = await db.all(`${BASE_SELECT} WHERE ${where} ORDER BY n.created_at DESC LIMIT 100`, ...params);
  const appRows = await db.all('SELECT internship_id, status FROM internship_applications WHERE applicant_id = ?', user.id);
  const mine = new Map(appRows.map(a => [a.internship_id, a.status]));
  res.json({ internships: rows.map(r => ({ ...parse(r), my_application: mine.get(r.id) || null })) });
}));

const APPS_SQL = `
  SELECT a.id, a.internship_id, a.note, a.status, a.created_at,
         u.full_name as applicant_name, u.email as applicant_email, u.role as applicant_role,
         COALESCE(i.short_name, ep.current_institution) as applicant_institution
  FROM internship_applications a
  JOIN internships n ON a.internship_id = n.id
  JOIN users u ON a.applicant_id = u.id
  LEFT JOIN institutions i ON u.institution_id = i.id
  LEFT JOIN external_profiles ep ON ep.user_id = u.id
`;

// GET /api/internships/posted — the poster's own listings with applicants
// (alumni: their postings; admins: every posting of their institution).
router.get('/posted', requireRole('ALUMNI', 'ADMIN'), asyncRoute(async (req, res) => {
  const isAdmin = req.user.role === 'ADMIN';
  const postings = (await (isAdmin
    ? db.all(`${BASE_SELECT} WHERE n.institution_id = ? ORDER BY n.created_at DESC`, req.user.institution_id)
    : db.all(`${BASE_SELECT} WHERE n.posted_by = ? ORDER BY n.created_at DESC`, req.user.id))).map(parse);
  const apps = await (isAdmin
    ? db.all(`${APPS_SQL} WHERE n.institution_id = ? ORDER BY a.created_at DESC, a.id DESC`, req.user.institution_id)
    : db.all(`${APPS_SQL} WHERE n.posted_by = ? ORDER BY a.created_at DESC, a.id DESC`, req.user.id));
  for (const p of postings) p.applications = apps.filter(a => a.internship_id === p.id);
  res.json({ internships: postings });
}));

// POST /api/internships — verified alumni, or admins on behalf of the institution.
router.post('/', requireRole('ALUMNI', 'ADMIN'), asyncRoute(async (req, res) => {
  if (req.user.role === 'ALUMNI' && req.user.verification_status !== 'VERIFIED') {
    return res.status(403).json({ error: 'Only verified alumni can post internships' });
  }
  const instAccess = await getInstitutionAccess(req.user.institution_id);
  if (!instAccess.active) return sendInactive(res);

  const v = validatePosting(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const id = 'in_' + crypto.randomUUID().slice(0, 8);
  await db.run(`
    INSERT INTO internships (id, institution_id, posted_by, title, company, location, mode, stipend_inr_month,
      duration_weeks, description, skills_json, audience, status, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `, id, req.user.institution_id, req.user.id, v.title, v.company, v.location, v.mode, v.stipend, v.weeks,
    v.description, JSON.stringify(v.skills), v.audience, v.deadline);

  if (req.user.role === 'ADMIN') await audit(req, req.user.institution_id, 'INTERNSHIP_POSTED', { targetType: 'internship', targetId: id, details: v.title });
  res.status(201).json({ success: true, id });
}));

// POST /api/internships/:id/close — the poster, or an admin of the institution (moderation).
router.post('/:id/close', requireRole('ALUMNI', 'ADMIN'), asyncRoute(async (req, res) => {
  const r = await (req.user.role === 'ADMIN'
    ? db.run("UPDATE internships SET status = 'CLOSED' WHERE id = ? AND institution_id = ?", req.params.id, req.user.institution_id)
    : db.run("UPDATE internships SET status = 'CLOSED' WHERE id = ? AND posted_by = ?", req.params.id, req.user.id));
  if (!r.changes) return res.status(404).json({ error: 'Internship not found' });
  if (req.user.role === 'ADMIN') await audit(req, req.user.institution_id, 'INTERNSHIP_CLOSED', { targetType: 'internship', targetId: req.params.id });
  res.json({ success: true });
}));

// POST /api/internships/:id/apply  { note }
router.post('/:id/apply', requireRole('STUDENT', 'EXTERNAL'), asyncRoute(async (req, res) => {
  const access = await internshipAccess(req.user);
  if (!access.allowed) return sendBlocked(res, access);

  const params = [req.params.id];
  const where = await learnerScope(req.user, params);
  const internship = await db.get(`SELECT n.id FROM internships n JOIN institutions i ON n.institution_id = i.id WHERE n.id = ? AND ${where}`, ...params);
  if (!internship) return res.status(404).json({ error: 'Internship not found or closed' });

  const note = String(req.body.note || '').trim();
  if (note.length < 20) return res.status(400).json({ error: 'Please write at least 20 characters about why you are a good fit' });
  if (await db.get('SELECT 1 FROM internship_applications WHERE internship_id = ? AND applicant_id = ?', internship.id, req.user.id)) {
    return res.status(409).json({ error: 'You have already applied to this internship' });
  }

  const id = 'ia_' + crypto.randomUUID().slice(0, 8);
  await db.run('INSERT INTO internship_applications (id, internship_id, applicant_id, note) VALUES (?, ?, ?, ?)',
    id, internship.id, req.user.id, note.slice(0, 2000));
  res.status(201).json({ success: true, id, status: 'APPLIED' });
}));

// POST /api/internships/applications/:id/decide  { status }
router.post('/applications/:id/decide', requireRole('ALUMNI', 'ADMIN'), asyncRoute(async (req, res) => {
  const status = String(req.body.status || '').toUpperCase();
  if (!['SHORTLISTED', 'REJECTED'].includes(status)) {
    return res.status(400).json({ error: "Status must be 'SHORTLISTED' or 'REJECTED'" });
  }
  const app = await (req.user.role === 'ADMIN'
    ? db.get('SELECT a.id FROM internship_applications a JOIN internships n ON a.internship_id = n.id WHERE a.id = ? AND n.institution_id = ?', req.params.id, req.user.institution_id)
    : db.get('SELECT a.id FROM internship_applications a JOIN internships n ON a.internship_id = n.id WHERE a.id = ? AND n.posted_by = ?', req.params.id, req.user.id));
  if (!app) return res.status(404).json({ error: 'Application not found' });
  await db.run('UPDATE internship_applications SET status = ? WHERE id = ?', status, app.id);
  res.json({ success: true, status });
}));

export default router;
