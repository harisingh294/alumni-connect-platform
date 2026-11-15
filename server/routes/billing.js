// Institution subscription billing. PAYMENTS ARE SIMULATED (see ../billing.js).
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole, requireOwner } from '../auth.js';
import {
  publicPlans, getPlan, priceFor, getInstitutionAccess, countMembers, TRIAL_DAYS, SCHOOL_DISCOUNT
} from '../billing.js';
import { clearInstCache } from '../access.js';
import { audit } from '../audit.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/billing/plans — public pricing for colleges and schools.
router.get('/plans', (req, res) => {
  res.json({ plans: publicPlans(), trial_days: TRIAL_DAYS, school_discount_pct: SCHOOL_DISCOUNT * 100, currency: 'INR', payments_mode: 'demo' });
});

router.use(requireAuth, requireRole('ADMIN'));

async function usage(instId) {
  const adminRow = await db.get("SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ADMIN'", instId);
  return {
    members: await countMembers(instId),
    admins: Number(adminRow?.n ?? 0)
  };
}

// GET /api/billing — current plan, status, usage and invoices.
router.get('/', asyncRoute(async (req, res) => {
  const instId = req.user.institution_id;
  const a = await getInstitutionAccess(instId);
  const instRow = await db.get('SELECT kind FROM institutions WHERE id = ?', instId);
  const kind = instRow?.kind;
  const u = await usage(instId);
  const invoices = await db.all('SELECT id, plan_id, billing_cycle, amount_inr, period_start, period_end, status, payment_ref, created_at FROM institution_invoices WHERE institution_id = ? ORDER BY created_at DESC', instId);

  res.json({
    kind,
    active: a.active,
    state: a.state,
    plan: a.plan,
    billing_cycle: a.subscription?.billing_cycle,
    current_price_inr: a.plan ? priceFor(a.plan, a.subscription.billing_cycle, kind) : null,
    ends_at: a.ends_at,
    days_left: a.days_left,
    cancel_at_period_end: Boolean(a.subscription?.cancel_at_period_end),
    usage: { ...u, member_limit: a.member_limit, admin_seats: a.admin_seats },
    invoices,
    plans: publicPlans(),
    payments_mode: 'demo'
  });
}));

// POST /api/billing/checkout { plan_id, billing_cycle } — pay for (or switch to) a plan.
// Starts a new billing period now. Proration is out of scope for the demo.
router.post('/checkout', requireOwner, asyncRoute(async (req, res) => {
  const instId = req.user.institution_id;
  const plan = getPlan(req.body.plan_id);
  const cycle = req.body.billing_cycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });

  const u = await usage(instId);
  if (plan.member_limit != null && u.members > plan.member_limit) {
    return res.status(400).json({ error: `You have ${u.members} verified members, more than the ${plan.name} limit of ${plan.member_limit}.` });
  }
  if (u.admins > plan.admin_seats) {
    return res.status(400).json({ error: `You have ${u.admins} admins, more than the ${plan.admin_seats} seats in ${plan.name}. Remove admins first.` });
  }

  const instRow = await db.get('SELECT kind FROM institutions WHERE id = ?', instId);
  const kind = instRow?.kind;
  const amount = priceFor(plan, cycle, kind);
  const interval = cycle === 'ANNUAL' ? '+1 year' : '+1 month';
  const paymentRef = 'DEMO-' + crypto.randomUUID().slice(0, 12).toUpperCase();

  await db.transaction(async (tx) => {
    await tx.run(`
      UPDATE institution_subscriptions SET plan_id = ?, billing_cycle = ?, status = 'ACTIVE', trial_ends_at = NULL,
        current_period_start = datetime('now'), current_period_end = datetime('now', ?), cancel_at_period_end = 0
      WHERE institution_id = ?
    `, plan.id, cycle, interval, instId);
    await tx.run(`
      INSERT INTO institution_invoices (id, institution_id, plan_id, billing_cycle, amount_inr, period_start, period_end, status, payment_ref)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now', ?), 'PAID', ?)
    `, 'inv_' + crypto.randomUUID().slice(0, 10), instId, plan.id, cycle, amount, interval, paymentRef);
  });

  clearInstCache(instId);
  await audit(req, instId, 'SUBSCRIPTION_PAID', { details: { plan: plan.id, cycle, amount_inr: amount, payment_ref: paymentRef } });
  res.status(201).json({ success: true, demo_payment: true, amount_inr: amount, payment_ref: paymentRef });
}));

// POST /api/billing/cancel — stop renewal; access continues until the period ends.
router.post('/cancel', requireOwner, asyncRoute(async (req, res) => {
  await db.run('UPDATE institution_subscriptions SET cancel_at_period_end = 1 WHERE institution_id = ?', req.user.institution_id);
  await audit(req, req.user.institution_id, 'SUBSCRIPTION_CANCELLED');
  res.json({ success: true });
}));

router.post('/resume', requireOwner, asyncRoute(async (req, res) => {
  await db.run('UPDATE institution_subscriptions SET cancel_at_period_end = 0 WHERE institution_id = ?', req.user.institution_id);
  await audit(req, req.user.institution_id, 'SUBSCRIPTION_RESUMED');
  res.json({ success: true });
}));

export default router;
