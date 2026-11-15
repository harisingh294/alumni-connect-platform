// Premium subscriptions for students from other colleges and schools.
//
// PAYMENTS ARE SIMULATED. Checkout records a subscription with a DEMO- payment
// reference and never collects card details. Before charging real money, replace
// the body of POST /checkout with a payment-gateway flow (e.g. Razorpay Orders +
// webhook signature verification) and only activate the plan from the webhook.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { PLANS, getActiveSubscription } from '../access.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/subscriptions/plans — public pricing
router.get('/plans', (req, res) => {
  res.json({ plans: PLANS, currency: 'INR', payments_mode: 'demo' });
});

router.use(requireAuth, requireRole('EXTERNAL'));

// GET /api/subscriptions/me
router.get('/me', asyncRoute(async (req, res) => {
  const active = await getActiveSubscription(req.user.id);
  const history = await db.all(`
    SELECT id, plan_id, amount_inr, started_at, expires_at, auto_renew, payment_ref, created_at
    FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
  `, req.user.id);
  res.json({
    active,
    plan: active ? PLANS.find(p => p.id === active.plan_id) || null : null,
    history
  });
}));

// POST /api/subscriptions/checkout  { plan_id }
router.post('/checkout', asyncRoute(async (req, res) => {
  const plan = PLANS.find(p => p.id === req.body.plan_id);
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });

  if (await getActiveSubscription(req.user.id)) {
    return res.status(409).json({ error: 'You already have an active Premium subscription' });
  }

  const id = 'sub_' + crypto.randomUUID().slice(0, 8);
  const paymentRef = 'DEMO-' + crypto.randomUUID().slice(0, 12).toUpperCase();
  await db.run(`
    INSERT INTO subscriptions (id, user_id, plan_id, amount_inr, started_at, expires_at, auto_renew, payment_ref)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now', ?), 1, ?)
  `, id, req.user.id, plan.id, plan.price_inr, `+${plan.days} days`, paymentRef);

  const subscription = await db.get('SELECT * FROM subscriptions WHERE id = ?', id);

  res.status(201).json({
    success: true,
    demo_payment: true,
    subscription
  });
}));

// POST /api/subscriptions/cancel — stops renewal; access continues until expiry.
router.post('/cancel', asyncRoute(async (req, res) => {
  const active = await getActiveSubscription(req.user.id);
  if (!active) return res.status(404).json({ error: 'No active subscription' });
  await db.run('UPDATE subscriptions SET auto_renew = 0 WHERE id = ?', active.id);
  res.json({ success: true, expires_at: active.expires_at });
}));

export default router;
