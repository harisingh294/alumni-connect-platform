// Institution (B2B) subscription plans and entitlement checks.
//
// PAYMENTS ARE SIMULATED. Checkout records a paid invoice with a DEMO- reference.
// Before charging real money, integrate a payment gateway (e.g. Razorpay
// Subscriptions with webhook signature verification) and only extend the
// billing period from the verified webhook.
import { db } from './db.js';

export const TRIAL_DAYS = 30;
export const SCHOOL_DISCOUNT = 0.4; // schools pay 40% less

// Data protection features (export, audit log, deletion, sharing controls) are on
// every plan and stay available even when a subscription lapses.
const BASE_FEATURES = ['directory', 'verification', 'mentorship', 'internships', 'announcements', 'analytics', 'export', 'audit_log'];

export const INSTITUTION_PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    monthly_inr: 4999,
    annual_inr: 49990,
    member_limit: 1000,
    admin_seats: 2,
    features: BASE_FEATURES,
    highlights: [
      'Up to 1,000 verified students and alumni',
      '2 admin seats',
      'Verification queue and roster import',
      'Mentorship requests and messaging',
      'Internship board and announcements',
      'Outcome analytics'
    ]
  },
  {
    id: 'growth',
    name: 'Growth',
    monthly_inr: 12999,
    annual_inr: 129990,
    member_limit: 5000,
    admin_seats: 5,
    features: [...BASE_FEATURES, 'programs', 'events', 'value_report'],
    highlights: [
      'Up to 5,000 verified students and alumni',
      '5 admin seats',
      'Everything in Starter',
      'Structured mentorship programs with matching',
      'Events and alumni meetups with RSVPs',
      'Monthly value report and engagement trends'
    ]
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    monthly_inr: 29999,
    annual_inr: 299990,
    member_limit: null,
    admin_seats: 15,
    features: [...BASE_FEATURES, 'programs', 'events', 'value_report', 'priority_support'],
    highlights: [
      'Unlimited students and alumni',
      '15 admin seats',
      'Everything in Growth',
      'Priority support and onboarding help',
      'Suited to universities with several campuses'
    ]
  }
];

export const FEATURE_LABEL = {
  programs: 'Mentorship programs',
  events: 'Events',
  value_report: 'Value report'
};

export function getPlan(id) {
  return INSTITUTION_PLANS.find(p => p.id === id) || null;
}

export function priceFor(plan, cycle, kind) {
  const base = cycle === 'ANNUAL' ? plan.annual_inr : plan.monthly_inr;
  return kind === 'SCHOOL' ? Math.round(base * (1 - SCHOOL_DISCOUNT)) : base;
}

export function publicPlans() {
  return INSTITUTION_PLANS.map(p => ({
    ...p,
    school_monthly_inr: priceFor(p, 'MONTHLY', 'SCHOOL'),
    school_annual_inr: priceFor(p, 'ANNUAL', 'SCHOOL')
  }));
}

const ACTIVE_SQL = `
  (s.status = 'TRIALING' AND s.trial_ends_at > datetime('now'))
  OR (s.status = 'ACTIVE' AND s.current_period_end > datetime('now'))
`;

export function activeInstitutionIds() {
  return db.prepare(`SELECT s.institution_id as id FROM institution_subscriptions s WHERE ${ACTIVE_SQL}`).all().map(r => r.id);
}

export function countMembers(instId) {
  return db.prepare(`
    SELECT COUNT(*) as n FROM users
    WHERE institution_id = ? AND role IN ('STUDENT', 'ALUMNI') AND verification_status = 'VERIFIED' AND is_active = 1
  `).get(instId).n;
}

function daysUntil(sqlDate) {
  if (!sqlDate) return null;
  const ms = new Date(sqlDate.replace(' ', 'T') + 'Z').getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// Everything the app needs to know about an institution's entitlement.
export function getInstitutionAccess(instId) {
  if (!instId) return { active: false, state: 'NONE', features: new Set() };
  const sub = db.prepare('SELECT * FROM institution_subscriptions WHERE institution_id = ?').get(instId);
  if (!sub) return { active: false, state: 'NONE', features: new Set(), plan: null };

  const plan = getPlan(sub.plan_id);
  const nowActive = db.prepare(`SELECT 1 as ok FROM institution_subscriptions s WHERE s.institution_id = ? AND (${ACTIVE_SQL})`).get(instId);
  let state;
  if (!nowActive) state = 'EXPIRED';
  else if (sub.status === 'TRIALING') state = 'TRIAL';
  else if (sub.cancel_at_period_end) state = 'CANCELLING';
  else state = 'ACTIVE';

  const endsAt = sub.status === 'TRIALING' ? sub.trial_ends_at : sub.current_period_end;
  return {
    active: Boolean(nowActive),
    state,
    plan,
    subscription: sub,
    ends_at: endsAt,
    days_left: daysUntil(endsAt),
    features: new Set(plan ? plan.features : []),
    member_limit: plan?.member_limit ?? null,
    admin_seats: plan?.admin_seats ?? 1
  };
}

export function hasFeature(instId, feature) {
  const a = getInstitutionAccess(instId);
  return a.active && a.features.has(feature);
}

export function memberLimitReached(instId) {
  const a = getInstitutionAccess(instId);
  if (a.member_limit == null) return false;
  return countMembers(instId) >= a.member_limit;
}

// Express helpers -----------------------------------------------------------

export function sendInactive(res) {
  return res.status(402).json({
    error: 'Your institution’s subscription is not active. Renew it from Billing to use this feature. Data export and privacy tools remain available.',
    code: 'INSTITUTION_INACTIVE'
  });
}

// Requires the admin's institution to have an active subscription.
export function requireActiveInstitution(req, res, next) {
  if (!getInstitutionAccess(req.user.institution_id).active) return sendInactive(res);
  next();
}

// Requires a plan feature (e.g. 'programs').
export function requireFeature(feature) {
  return (req, res, next) => {
    const a = getInstitutionAccess(req.user.institution_id);
    if (!a.active) return sendInactive(res);
    if (!a.features.has(feature)) {
      return res.status(402).json({
        error: `${FEATURE_LABEL[feature] || feature} is included in the Growth and Enterprise plans.`,
        code: 'PLAN_UPGRADE_REQUIRED',
        feature
      });
    }
    next();
  };
}
