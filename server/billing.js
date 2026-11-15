import { db } from './app-db.js';

export const TRIAL_DAYS = 30;
export const SCHOOL_DISCOUNT = 0.4;

const BASE_FEATURES = ['directory', 'verification', 'mentorship', 'internships', 'announcements', 'analytics', 'export', 'audit_log'];

export const INSTITUTION_PLANS = [
  {
    id: 'starter', name: 'Starter', monthly_inr: 4999, annual_inr: 49990,
    member_limit: 1000, admin_seats: 2, features: BASE_FEATURES,
    highlights: ['Up to 1,000 verified students and alumni', '2 admin seats', 'Verification queue and roster import', 'Mentorship requests and messaging', 'Internship board and announcements', 'Outcome analytics']
  },
  {
    id: 'growth', name: 'Growth', monthly_inr: 12999, annual_inr: 129990,
    member_limit: 5000, admin_seats: 5, features: [...BASE_FEATURES, 'programs', 'events', 'value_report'],
    highlights: ['Up to 5,000 verified students and alumni', '5 admin seats', 'Everything in Starter', 'Structured mentorship programs with matching', 'Events and alumni meetups with RSVPs', 'Monthly value report and engagement trends']
  },
  {
    id: 'enterprise', name: 'Enterprise', monthly_inr: 29999, annual_inr: 299990,
    member_limit: null, admin_seats: 15, features: [...BASE_FEATURES, 'programs', 'events', 'value_report', 'priority_support'],
    highlights: ['Unlimited students and alumni', '15 admin seats', 'Everything in Growth', 'Priority support and onboarding help', 'Suited to universities with several campuses']
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

export async function activeInstitutionIds() {
  const rows = await db.all(
    `SELECT s.institution_id as id FROM institution_subscriptions s WHERE ${ACTIVE_SQL}`
  );
  return rows.map(row => row.id);
}

export async function countMembers(instId) {
  const row = await db.get(`
    SELECT COUNT(*) as n FROM users
    WHERE institution_id = ? AND role IN ('STUDENT', 'ALUMNI') AND verification_status = 'VERIFIED' AND is_active = 1
  `, instId);
  return Number(row?.n ?? 0);
}

function daysUntil(sqlDate) {
  if (!sqlDate) return null;
  const ms = new Date(sqlDate.replace(' ', 'T') + 'Z').getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

export async function getInstitutionAccess(instId) {
  if (!instId) return { active: false, state: 'NONE', features: new Set() };

  const sub = await db.get(
    'SELECT * FROM institution_subscriptions WHERE institution_id = ?',
    instId
  );

  if (!sub) return { active: false, state: 'NONE', features: new Set(), plan: null };

  const plan = getPlan(sub.plan_id);
  const nowActive = await db.get(`
    SELECT 1 as ok FROM institution_subscriptions s
    WHERE s.institution_id = ? AND (${ACTIVE_SQL})
  `, instId);

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

export async function hasFeature(instId, feature) {
  const access = await getInstitutionAccess(instId);
  return access.active && access.features.has(feature);
}

export async function memberLimitReached(instId) {
  const access = await getInstitutionAccess(instId);
  if (access.member_limit == null) return false;
  return (await countMembers(instId)) >= access.member_limit;
}

export function sendInactive(res) {
  return res.status(402).json({
    error: 'Your institution’s subscription is not active. Renew it from Billing to use this feature. Data export and privacy tools remain available.',
    code: 'INSTITUTION_INACTIVE'
  });
}

export async function requireActiveInstitution(req, res, next) {
  try {
    const access = await getInstitutionAccess(req.user.institution_id);
    if (!access.active) return sendInactive(res);
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireFeature(feature) {
  return async (req, res, next) => {
    try {
      const access = await getInstitutionAccess(req.user.institution_id);
      if (!access.active) return sendInactive(res);
      if (!access.features.has(feature)) {
        return res.status(402).json({
          error: `${FEATURE_LABEL[feature] || feature} is included in the Growth and Enterprise plans.`,
          code: 'PLAN_UPGRADE_REQUIRED',
          feature
        });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}