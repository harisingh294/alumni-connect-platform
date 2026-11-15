import express from 'express';
import { db, databaseEngine } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { getInstitutionAccess, priceFor, countMembers } from '../billing.js';
import { clearInstCache } from '../access.js';
import { platformLog } from '../audit.js';
import { usageReport, usageCsv } from '../usage.js';

const router = express.Router();
router.use(requireAuth, requireRole('SUPERADMIN'));

const asyncRoute = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function monthlyValue(a, kind) {
  if (!a.active || a.state === 'TRIAL' || !a.plan) return 0;
  const price = priceFor(a.plan, a.subscription.billing_cycle, kind);
  return a.subscription.billing_cycle === 'ANNUAL' ? Math.round(price / 12) : price;
}

router.get('/institutions', asyncRoute(async (req, res) => {
  const rows = await db.all(`
    SELECT id, name, short_name, kind, city, state, contact_email,
           platform_verified, data_sharing, is_sandbox, created_at
    FROM institutions
    ORDER BY is_sandbox, created_at
  `);

  const institutions = await Promise.all(rows.map(async i => {
    const a = await getInstitutionAccess(i.id);
    return {
      ...i,
      plan: a.plan?.name || null,
      billing_cycle: a.subscription?.billing_cycle || null,
      state: a.state,
      ends_at: a.ends_at,
      days_left: a.days_left,
      members: await countMembers(i.id),
      member_limit: a.member_limit,
      mrr_inr: i.is_sandbox ? 0 : monthlyValue(a, i.kind)
    };
  }));

  res.json({ institutions });
}));

router.post('/institutions/:id/verify', asyncRoute(async (req, res) => {
  const verified = req.body.verified === false ? 0 : 1;
  const result = await db.run(
    'UPDATE institutions SET platform_verified = ? WHERE id = ?',
    verified,
    req.params.id
  );

  if (!result.changes) {
    return res.status(404).json({ error: 'Institution not found' });
  }

  clearInstCache(req.params.id);
  await platformLog(
    verified ? 'INSTITUTION_VERIFIED' : 'INSTITUTION_UNVERIFIED',
    { institution_id: req.params.id, by: req.user.id }
  );

  res.json({ success: true });
}));

router.get('/usage', asyncRoute(async (req, res) => {
  const rows = await db.all(
    'SELECT id FROM institutions ORDER BY is_sandbox, created_at'
  );
  const institutions = await Promise.all(rows.map(row => usageReport(row.id)));
  res.json({ institutions });
}));

router.get('/institutions/:id/usage.csv', asyncRoute(async (req, res) => {
  const report = await usageReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Institution not found' });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="usage-${report.institution.id}-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send('﻿' + usageCsv(report)); // BOM for Excel
}));

router.get('/institutions/:id/usage', asyncRoute(async (req, res) => {
  const report = await usageReport(req.params.id);
  if (!report) return res.status(404).json({ error: 'Institution not found' });
  res.json(report);
}));

router.get('/feedback.csv', asyncRoute(async (req, res) => {
  const { feedbackCsv } = await import('./feedback.js');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="feedback-log-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.send('﻿' + await feedbackCsv(req.query.include_sandbox === '1')); // BOM for Excel
}));

router.get('/revenue', asyncRoute(async (req, res) => {
  const insts = await db.all(
    'SELECT id, kind FROM institutions WHERE is_sandbox = 0'
  );

  let mrr = 0;
  const counts = { ACTIVE: 0, TRIAL: 0, CANCELLING: 0, EXPIRED: 0, NONE: 0 };
  const byPlan = {};

  for (const i of insts) {
    const a = await getInstitutionAccess(i.id);
    counts[a.state] = (counts[a.state] || 0) + 1;
    const value = monthlyValue(a, i.kind);
    mrr += value;

    if (value && a.plan) {
      byPlan[a.plan.name] = (byPlan[a.plan.name] || 0) + value;
    }
  }

  const [invoices, b2c, externalUsers, sandboxInstitutions] = await Promise.all([
    db.get(`
      SELECT COUNT(*) as count,
             COALESCE(SUM(v.amount_inr), 0) as total
      FROM institution_invoices v
      JOIN institutions i ON v.institution_id = i.id
      WHERE i.is_sandbox = 0
    `),
    db.get(`
      SELECT COUNT(*) as subscriptions,
             COALESCE(SUM(s.amount_inr), 0) as gross_inr,
             SUM(CASE WHEN s.expires_at > datetime('now') THEN 1 ELSE 0 END) as active
      FROM subscriptions s
      JOIN users u ON s.user_id = u.id
      WHERE u.is_sandbox = 0
    `),
    db.get(`
      SELECT COUNT(*) as n
      FROM users
      WHERE role = 'EXTERNAL' AND is_sandbox = 0
    `),
    db.get(`
      SELECT COUNT(*) as n
      FROM institutions
      WHERE is_sandbox = 1
    `)
  ]);

  const externalCount = Number(externalUsers?.n ?? 0);
  const activeCount = Number(b2c?.active ?? 0);

  res.json({
    institutions: {
      total: insts.length,
      by_state: counts,
      sandbox: Number(sandboxInstitutions?.n ?? 0)
    },
    b2b: {
      mrr_inr: mrr,
      arr_inr: mrr * 12,
      by_plan: byPlan,
      invoices_paid: Number(invoices?.count ?? 0),
      invoiced_total_inr: Number(invoices?.total ?? 0)
    },
    b2c: {
      ...b2c,
      active: activeCount,
      external_users: externalCount,
      conversion_pct: externalCount
        ? Math.round((activeCount / externalCount) * 1000) / 10
        : 0
    },
    payments_mode: 'demo'
  });
}));

router.post('/sandbox/reset', asyncRoute(async (req, res) => {
  if (databaseEngine !== 'sqlite') {
    return res.status(503).json({
      error: 'Sandbox reset is SQLite-only and is not available in PostgreSQL mode.'
    });
  }

  const { runSeed } = await import('../seed.js');
  runSeed({ mode: 'sandbox' });
  clearInstCache();
  await platformLog('SANDBOX_RESET', { by: req.user.id });

  res.json({ success: true });
}));

router.get('/log', asyncRoute(async (req, res) => {
  const entries = await db.all(
    'SELECT * FROM platform_log ORDER BY created_at DESC LIMIT 100'
  );
  res.json({ entries });
}));

export default router;
