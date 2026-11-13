// Central role / tenant / subscription access rules. Every route that gates a
// feature goes through these helpers so the UI and API never disagree.
//
// Data-protection principles enforced here:
//  1. Tenant isolation: an institution's community is visible outside it only if
//     that institution chose data_sharing = 'PLATFORM'. New institutions default to PRIVATE.
//  2. Platform staff (SUPERADMIN) never see personal data of any institution.
//  3. Admins of one institution cannot browse another institution's community.
//  4. A lapsed institution's community is hidden from everyone outside it.
import { db } from './db.js';
import { getInstitutionAccess } from './billing.js';

export const PLANS = [
  {
    id: 'premium_monthly',
    name: 'Premium Monthly',
    price_inr: 499,
    days: 30,
    features: [
      'Personal mentorship requests to opted-in alumni',
      'Career guidance and mock interviews',
      'Internship opportunities from the alumni network',
      'Direct LinkedIn access on alumni profiles'
    ]
  },
  {
    id: 'premium_annual',
    name: 'Premium Annual',
    price_inr: 3999,
    days: 365,
    features: [
      'Everything in Premium Monthly',
      'Save about 33% compared with paying monthly',
      'Priority placement in alumni inboxes'
    ]
  }
];

export const MENTORSHIP_TOPICS = [
  'Resume Review',
  'Career Guidance',
  'Mock Interview',
  'Career transitions',
  'Placement preparation',
  'Higher studies abroad'
];

export function getActiveSubscription(userId) {
  return db.prepare(`
    SELECT * FROM subscriptions
    WHERE user_id = ? AND expires_at > datetime('now')
    ORDER BY expires_at DESC LIMIT 1
  `).get(userId) || null;
}

export function isPremium(user) {
  if (!user || user.role !== 'EXTERNAL') return false;
  if (user._premium === undefined) {
    Object.defineProperty(user, '_premium', { value: Boolean(getActiveSubscription(user.id)), enumerable: false });
  }
  return user._premium;
}

// Per-process memo of institution sharing + activity, refreshed every few seconds.
const instCache = new Map();
export function instInfo(instId) {
  if (!instId) return null;
  const hit = instCache.get(instId);
  if (hit && hit.at > Date.now() - 3000) return hit.value;
  const row = db.prepare('SELECT id, data_sharing, public_profile, platform_verified, is_sandbox FROM institutions WHERE id = ?').get(instId);
  const value = row ? { ...row, active: getInstitutionAccess(instId).active } : null;
  instCache.set(instId, { at: Date.now(), value });
  return value;
}
export function clearInstCache(instId) {
  if (instId) instCache.delete(instId); else instCache.clear();
}

// Sandbox (reviewer) accounts and real accounts live in separate worlds.
export const viewerSandbox = (viewer) => (viewer?.is_sandbox ? 1 : 0);
export function sameWorld(viewer, inst) {
  return Boolean(inst) && (inst.is_sandbox ? 1 : 0) === viewerSandbox(viewer);
}

// Who may see an alumni profile (alum needs user_id, institution_id, verification_status, visibility).
export function canViewAlumnus(viewer, alum) {
  if (!viewer) return false;
  if (viewer.role === 'SUPERADMIN') return false; // platform staff never see member data
  if (viewer.id === alum.user_id) return true;

  const sameInst = Boolean(viewer.institution_id) && viewer.institution_id === alum.institution_id;
  if (viewer.role === 'ADMIN') return sameInst;

  const inst = instInfo(alum.institution_id);
  if (!inst || !inst.active || !sameWorld(viewer, inst)) return false;
  if (alum.verification_status !== 'VERIFIED') return false;
  if (alum.visibility === 'HIDDEN') return false;

  if (sameInst) {
    return alum.visibility === 'PUBLIC' || viewer.role === 'STUDENT' || viewer.role === 'ALUMNI';
  }
  return inst.data_sharing === 'PLATFORM' && alum.visibility === 'PUBLIC';
}

// Whether `user` may send a mentorship request to the alumnus row `alum`
// (needs user_id, institution_id, verification_status, is_open_to_mentoring, open_to_external).
export function mentorshipAccess(user, alum) {
  if (!user) return { allowed: false, code: 'LOGIN_REQUIRED', reason: 'Log in to request mentorship.' };
  const inst = instInfo(alum.institution_id);
  if (!inst || !inst.active || !sameWorld(user, inst)) {
    return { allowed: false, code: 'INSTITUTION_INACTIVE', reason: 'This alumnus’s institution is not currently active on the platform.' };
  }
  if (alum.verification_status !== 'VERIFIED') {
    return { allowed: false, code: 'ALUMNUS_UNVERIFIED', reason: 'This alumnus is not yet verified by the institution.' };
  }
  if (!alum.is_open_to_mentoring) {
    return { allowed: false, code: 'NOT_MENTORING', reason: 'This alumnus is not accepting mentorship requests right now.' };
  }

  if (user.role === 'STUDENT') {
    if (user.verification_status !== 'VERIFIED') {
      return { allowed: false, code: 'STUDENT_UNVERIFIED', reason: 'Your student account is waiting for verification by your institution.' };
    }
    if (user.institution_id !== alum.institution_id) {
      return { allowed: false, code: 'OTHER_COLLEGE', reason: 'Free mentorship is available from alumni of your own institution only.' };
    }
    return { allowed: true, code: 'OK', reason: 'Free for students of this institution.' };
  }

  if (user.role === 'EXTERNAL') {
    if (inst.data_sharing !== 'PLATFORM') {
      return { allowed: false, code: 'INSTITUTION_PRIVATE', reason: 'This institution keeps mentorship within its own community.' };
    }
    if (!isPremium(user)) {
      return { allowed: false, code: 'PREMIUM_REQUIRED', reason: 'Personal mentorship for students from other colleges and schools needs a Premium subscription.' };
    }
    if (!alum.open_to_external) {
      return { allowed: false, code: 'NOT_OPEN_TO_EXTERNAL', reason: 'This alumnus mentors students of their own institution only.' };
    }
    return { allowed: true, code: 'OK', reason: 'Included in your Premium plan.' };
  }

  return { allowed: false, code: 'ROLE', reason: 'Only students can send mentorship requests.' };
}

export function internshipAccess(user) {
  if (!user) return { allowed: false, code: 'LOGIN_REQUIRED', reason: 'Log in to view internships.' };
  if (user.role === 'STUDENT') {
    if (user.verification_status !== 'VERIFIED') {
      return { allowed: false, code: 'STUDENT_UNVERIFIED', reason: 'Your student account is waiting for verification by your institution.' };
    }
    if (!instInfo(user.institution_id)?.active) {
      return { allowed: false, code: 'INSTITUTION_INACTIVE', reason: 'Your institution’s subscription is not active right now.' };
    }
    return { allowed: true, code: 'OK' };
  }
  if (user.role === 'EXTERNAL') {
    if (!isPremium(user)) {
      return { allowed: false, code: 'PREMIUM_REQUIRED', reason: 'Internship opportunities for students from other colleges and schools need a Premium subscription.' };
    }
    return { allowed: true, code: 'OK' };
  }
  return { allowed: false, code: 'ROLE', reason: 'Only students can apply to internships.' };
}

// A member (student/alumni) can use their own institution's community features
// only while the institution is active.
export function memberCommunityAccess(user) {
  if (!user || !['STUDENT', 'ALUMNI'].includes(user.role)) {
    return { allowed: false, code: 'ROLE', reason: 'Only students and alumni of an institution can use this.' };
  }
  if (!instInfo(user.institution_id)?.active) {
    return { allowed: false, code: 'INSTITUTION_INACTIVE', reason: 'Your institution’s subscription is not active right now.' };
  }
  return { allowed: true, code: 'OK' };
}

export function sendBlocked(res, access) {
  const status = ['PREMIUM_REQUIRED', 'INSTITUTION_INACTIVE'].includes(access.code) ? 402
    : access.code === 'LOGIN_REQUIRED' ? 401
      : 403;
  return res.status(status).json({ error: access.reason, code: access.code });
}
