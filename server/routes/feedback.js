// Product feedback. Members and admins send feedback in the app; the platform team
// triages it and records decisions. The CSV export matches the Phase 2 feedback-log columns.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { rateLimit } from '../security.js';
import { toCsv } from '../usage.js';

export const FEEDBACK_TYPES = ['Bug', 'Feature', 'Usability', 'Data or integration', 'Pricing or business'];
export const DECISIONS = ['New', 'Shipped', 'In progress', 'Planned', "Won't do"];
const ROLE_NAME = { ADMIN: 'Institution admin', STUDENT: 'Student', ALUMNI: 'Alumnus', EXTERNAL: 'Visiting student' };

const memberRouter = express.Router();
const platformRouter = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const s = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  keyFn: (req) => `feedback:${req.user?.id || req.ip}`,
  message: 'You have sent a lot of feedback in the last hour. Thank you! Please try again later.'
});

// ---------- Members & admins ----------

memberRouter.use(requireAuth, requireRole('ADMIN', 'STUDENT', 'ALUMNI', 'EXTERNAL'));

// POST /api/feedback { type, message }
memberRouter.post('/', feedbackLimiter, asyncRoute(async (req, res) => {
  const type = FEEDBACK_TYPES.includes(req.body.type) ? req.body.type : null;
  const message = s(req.body.message, 2000);
  if (!type) return res.status(400).json({ error: 'Please choose what kind of feedback this is' });
  if (!message || message.length < 5) return res.status(400).json({ error: 'Please tell us a little more (at least 5 characters)' });

  const u = req.user;
  const inst = u.institution_id ? await db.get('SELECT name FROM institutions WHERE id = ?', u.institution_id) : null;
  const role = u.role === 'ADMIN' && u.admin_level === 'OWNER' ? 'Institution owner' : ROLE_NAME[u.role];
  const id = 'fb_' + crypto.randomUUID().slice(0, 10);
  await db.run(`
    INSERT INTO feedback (id, institution_id, partner_name, person, person_role, user_id, source, channel, what_they_said, type)
    VALUES (?, ?, ?, ?, ?, ?, 'IN_APP', 'In-app form', ?, ?)
  `, id, u.institution_id || null, inst?.name || 'Visiting student', u.full_name, role, u.id, message, type);
  res.status(201).json({ success: true, id });
}));

// GET /api/feedback/mine — what I sent and what the team decided.
memberRouter.get('/mine', asyncRoute(async (req, res) => {
  const feedback = await db.all(`
    SELECT id, type, what_they_said, decision, decision_reason, shipped_on, received_on
    FROM feedback WHERE user_id = ? ORDER BY received_on DESC, created_at DESC, id DESC LIMIT 50
  `, req.user.id);
  res.json({ feedback });
}));

// ---------- Platform team ----------

platformRouter.use(requireAuth, requireRole('SUPERADMIN'));

const LIST_SQL = `
  SELECT f.*, COALESCE(i.name, f.partner_name) as partner, i.is_sandbox
  FROM feedback f LEFT JOIN institutions i ON f.institution_id = i.id
`;

async function listFeedback(includeSandbox) {
  return db.all(`${LIST_SQL} ${includeSandbox ? '' : 'WHERE COALESCE(i.is_sandbox, 0) = 0'}
    ORDER BY f.received_on DESC, f.created_at DESC, f.id DESC`);
}

platformRouter.get('/', asyncRoute(async (req, res) => {
  const rows = await listFeedback(req.query.include_sandbox === '1');
  const summary = {};
  for (const r of rows) {
    const key = r.partner || 'Unknown';
    summary[key] ??= { partner: key, entries: 0, shipped: 0 };
    summary[key].entries += 1;
    if (r.decision === 'Shipped') summary[key].shipped += 1;
  }
  res.json({ feedback: rows, by_partner: Object.values(summary), types: FEEDBACK_TYPES, decisions: DECISIONS });
}));

// POST /api/platform/feedback — log feedback received by phone, visit or WhatsApp.
platformRouter.post('/', asyncRoute(async (req, res) => {
  const b = req.body;
  const type = FEEDBACK_TYPES.includes(b.type) ? b.type : null;
  const said = s(b.what_they_said, 2000);
  const person = s(b.person, 120);
  if (!type || !said || !person) return res.status(400).json({ error: 'Type, person and what they said are required' });
  if (b.received_on && !isDate(b.received_on)) return res.status(400).json({ error: 'Date must be YYYY-MM-DD' });

  let institutionId = null;
  let partnerName = s(b.partner_name, 160);
  if (b.institution_id) {
    const inst = await db.get('SELECT id, name FROM institutions WHERE id = ?', b.institution_id);
    if (!inst) return res.status(400).json({ error: 'Unknown institution' });
    institutionId = inst.id;
    partnerName = inst.name;
  }
  if (!partnerName) return res.status(400).json({ error: 'Choose the partner institution or type its name' });

  const id = 'fb_' + crypto.randomUUID().slice(0, 10);
  await db.run(`
    INSERT INTO feedback (id, institution_id, partner_name, person, person_role, source, channel, what_they_said, type, received_on)
    VALUES (?, ?, ?, ?, ?, 'LOGGED_BY_TEAM', ?, ?, ?, COALESCE(?, date('now')))
  `, id, institutionId, partnerName, person, s(b.person_role, 80), s(b.channel, 60) || 'Conversation', said, type, b.received_on || null);
  res.status(201).json({ success: true, id });
}));

// PATCH /api/platform/feedback/:id — record the decision, shipping date, evidence and reaction.
platformRouter.patch('/:id', asyncRoute(async (req, res) => {
  const row = await db.get('SELECT * FROM feedback WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'Feedback not found' });
  const b = req.body;
  const next = {
    type: b.type !== undefined ? b.type : row.type,
    decision: b.decision !== undefined ? b.decision : row.decision,
    decision_reason: b.decision_reason !== undefined ? s(b.decision_reason, 400) : row.decision_reason,
    shipped_on: b.shipped_on !== undefined ? (b.shipped_on || null) : row.shipped_on,
    evidence: b.evidence !== undefined ? s(b.evidence, 400) : row.evidence,
    partner_reaction: b.partner_reaction !== undefined ? s(b.partner_reaction, 600) : row.partner_reaction
  };
  if (!FEEDBACK_TYPES.includes(next.type)) return res.status(400).json({ error: 'Invalid type' });
  if (!DECISIONS.includes(next.decision)) return res.status(400).json({ error: 'Invalid decision' });
  if (next.shipped_on && !isDate(next.shipped_on)) return res.status(400).json({ error: 'Shipped date must be YYYY-MM-DD' });
  // Phase 2 rule: every shipped item links to evidence; every "won't do" states its reason.
  if (next.decision === 'Shipped' && (!next.shipped_on || !next.evidence)) {
    return res.status(400).json({ error: 'A shipped item needs the date it shipped and evidence (commit, pull request or screenshot link)' });
  }
  if (next.decision === "Won't do" && !next.decision_reason) {
    return res.status(400).json({ error: "Give the reason for a won't-do decision" });
  }

  await db.run(`UPDATE feedback SET type = ?, decision = ?, decision_reason = ?, shipped_on = ?, evidence = ?, partner_reaction = ?, updated_at = datetime('now') WHERE id = ?`,
    next.type, next.decision, next.decision_reason, next.shipped_on, next.evidence, next.partner_reaction, row.id);
  res.json({ success: true });
}));

platformRouter.delete('/:id', asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM feedback WHERE id = ?', req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Feedback not found' });
  res.json({ success: true });
}));

const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00Z');
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// GET /api/platform/feedback.csv — newest first, columns exactly as the Phase 2 feedback log.
export async function feedbackCsv(includeSandbox = false) {
  const rows = await listFeedback(includeSandbox);
  return toCsv(
    ['Date', 'Partner and person', 'What they said (their words)', 'Type', 'Decision', 'Shipped on', 'Evidence', "Partner's reaction"],
    rows.map(r => [
      fmtDate(r.received_on),
      // Sandbox rows are labelled so test data can never pass as a real partner's feedback.
      `${r.is_sandbox ? '[SANDBOX TEST DATA] ' : ''}${r.partner}, ${r.person}${r.person_role ? ` (${r.person_role})` : ''}`,
      `"${r.what_they_said}"`,
      r.type,
      r.decision === "Won't do" ? `Won't do: ${r.decision_reason}` : r.decision === 'New' ? 'Not yet decided' : r.decision,
      fmtDate(r.shipped_on),
      r.evidence || '',
      r.partner_reaction || ''
    ])
  );
}

export { memberRouter as feedbackRoutes, platformRouter as platformFeedbackRoutes };
