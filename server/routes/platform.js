// Platform operator console (SUPERADMIN). By design this exposes only what a
// technology provider needs to run the service — institution accounts, plans,
// billing, aggregate usage counts and product feedback. No student, alumni or
// message data is reachable here.
import express from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';
import { getInstitutionAccess, priceFor, countMembers } from '../billing.js';
import { clearInstCache } from '../access.js';
import { platformLog } from '../audit.js';
import { usageReport, usageCsv } from '../usage.js';
import { feedbackCsv } from './feedback.js';
import { runSeed } from '../seed.js';

const router = express.Router();
router.use(requireAuth, requireRole('SUPERADMIN'));

function monthlyValue(a, kind) {
  if (!a.active || a.state === 'TRIAL' || !a.plan) return 0;
  const price = priceFor(a.plan, a.subscription.billing_cycle, kind);
  return a.subscription.billing_cycle === 'ANNUAL' ? Math.round(price / 12) : price;
}

// GET /api/platform/institutions — accounts list (institutional data only). Real partners first.
router.get('/institutions', (req, res) => {
  const rows = db.prepare(`SELECT id, name, short_name, kind, city, state, contact_email, platform_verified, data_sharing, is_sandbox, created_at
    FROM institutions ORDER BY is_sandbox, created_at`).all();
  const institutions = rows.map(i => {
    const a = getInstitutionAccess(i.id);
    return {
      ...i,
      plan: a.plan?.name || null,
      billing_cycle: a.subscription?.billing_cycle || null,
      state: a.state,
      ends_at: a.ends_at,
      days_left: a.days_left,
      members: countMembers(i.id), // count only
      member_limit: a.member_limit,
      mrr_inr: i.is_sandbox ? 0 : monthlyValue(a, i.kind)
    };
  });
  res.json({ institutions });
});

router.post('/institutions/:id/verify', (req, res) => {
  const verified = req.body.verified === false ? 0 : 1;
  const r = db.prepare('UPDATE institutions SET platform_verified = ? WHERE id = ?').run(verified, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Institution not found' });
  clearInstCache(req.params.id);
  platformLog(verified ? 'INSTITUTION_VERIFIED' : 'INSTITUTION_UNVERIFIED', { institution_id: req.params.id, by: req.user.id });
  res.json({ success: true });
});

// GET /api/platform/usage — usage evidence summary for every institution (counts only).
router.get('/usage', (req, res) => {
  const ids = db.prepare('SELECT id FROM institutions ORDER BY is_sandbox, created_at').all().map(r => r.id);
  res.json({ institutions: ids.map(usageReport) });
});

// GET /api/platform/institutions/:id/usage(.csv)
router.get('/institutions/:id/usage.csv', (req, res) => {
  const report = usageReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Institution not found' });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usage-${report.institution.id}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + usageCsv(report)); // BOM for Excel
});

router.get('/institutions/:id/usage', (req, res) => {
  const report = usageReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Institution not found' });
  res.json(report);
});

// GET /api/platform/feedback.csv — the feedback log, ready to import into Google Sheets.
router.get('/feedback.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="feedback-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + feedbackCsv(req.query.include_sandbox === '1')); // BOM for Excel
});

// GET /api/platform/revenue — real institutions and real visiting students only.
// All payments are simulated in this build, so these are demo-payment figures.
router.get('/revenue', (req, res) => {
  const insts = db.prepare('SELECT id, kind FROM institutions WHERE is_sandbox = 0').all();
  let mrr = 0;
  const counts = { ACTIVE: 0, TRIAL: 0, CANCELLING: 0, EXPIRED: 0, NONE: 0 };
  const byPlan = {};
  for (const i of insts) {
    const a = getInstitutionAccess(i.id);
    counts[a.state] = (counts[a.state] || 0) + 1;
    const v = monthlyValue(a, i.kind);
    mrr += v;
    if (v && a.plan) byPlan[a.plan.name] = (byPlan[a.plan.name] || 0) + v;
  }
  const invoices = db.prepare(`SELECT COUNT(*) as count, COALESCE(SUM(v.amount_inr), 0) as total FROM institution_invoices v
    JOIN institutions i ON v.institution_id = i.id WHERE i.is_sandbox = 0`).get();
  const b2c = db.prepare(`SELECT COUNT(*) as subscriptions, COALESCE(SUM(s.amount_inr), 0) as gross_inr,
    SUM(CASE WHEN s.expires_at > datetime('now') THEN 1 ELSE 0 END) as active
    FROM subscriptions s JOIN users u ON s.user_id = u.id WHERE u.is_sandbox = 0`).get();
  const externalUsers = db.prepare("SELECT COUNT(*) as n FROM users WHERE role = 'EXTERNAL' AND is_sandbox = 0").get().n;
  const sandboxInstitutions = db.prepare('SELECT COUNT(*) as n FROM institutions WHERE is_sandbox = 1').get().n;
  res.json({
    institutions: { total: insts.length, by_state: counts, sandbox: sandboxInstitutions },
    b2b: { mrr_inr: mrr, arr_inr: mrr * 12, by_plan: byPlan, invoices_paid: invoices.count, invoiced_total_inr: invoices.total },
    b2c: { ...b2c, active: b2c.active || 0, external_users: externalUsers, conversion_pct: externalUsers ? Math.round(((b2c.active || 0) / externalUsers) * 1000) / 10 : 0 },
    payments_mode: 'demo'
  });
});

// POST /api/platform/sandbox/reset — rebuild the fictional reviewer institutions.
// Real institutions and their data are never touched.
router.post('/sandbox/reset', (req, res) => {
  runSeed({ mode: 'sandbox' });
  clearInstCache();
  platformLog('SANDBOX_RESET', { by: req.user.id });
  res.json({ success: true });
});

router.get('/log', (req, res) => {
  res.json({ entries: db.prepare('SELECT * FROM platform_log ORDER BY created_at DESC LIMIT 100').all() });
});

export default router;
