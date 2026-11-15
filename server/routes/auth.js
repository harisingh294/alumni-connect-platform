import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { hashPassword, verifyPassword, createToken, requireAuth, demoLoginEnabled } from '../auth.js';
import { getActiveSubscription } from '../access.js';
import { getInstitutionAccess, getPlan, memberLimitReached, TRIAL_DAYS } from '../billing.js';
import { rateLimit } from '../security.js';
import { audit, platformLog } from '../audit.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const PORTAL_ROLES = {
  student: ['STUDENT'],
  alumni: ['ALUMNI'],
  external: ['EXTERNAL'],
  admin: ['ADMIN'],
  platform: ['SUPERADMIN']
};

const ROLE_PORTAL_LABEL = {
  STUDENT: 'Current Student',
  ALUMNI: 'Alumni',
  EXTERNAL: 'Other College / School Student',
  ADMIN: 'Institution Admin',
  SUPERADMIN: 'Platform Team'
};

const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const CURRENT_YEAR = new Date().getFullYear();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  keyFn: (req) => `login:${req.ip}:${String(req.body?.email || '').toLowerCase()}`,
  message: 'Too many login attempts. Please wait 15 minutes and try again.'
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  keyFn: (req) => `register:${req.ip}`,
  message: 'Too many signups from this network. Please try again later.'
});

async function institutionSummary(instId) {
  if (!instId) return null;

  const inst = await db.get(`
    SELECT id, name, short_name, abbr, kind, hue, data_sharing, public_profile, platform_verified, is_sandbox
    FROM institutions WHERE id = ?
  `, instId);

  if (!inst) return null;

  const a = await getInstitutionAccess(instId);
  return {
    ...inst,
    subscription: {
      active: a.active,
      state: a.state,
      plan_id: a.plan?.id || null,
      plan_name: a.plan?.name || null,
      days_left: a.days_left,
      ends_at: a.ends_at,
      features: [...a.features]
    }
  };
}

export async function buildSession(userId) {
  const user = await db.get(`
    SELECT u.id, u.institution_id, u.email, u.role, u.admin_level, u.full_name, u.verification_status, u.reject_reason, u.is_sandbox,
           i.name as institution_name, i.short_name as institution_short, i.abbr as institution_abbr, i.hue as institution_hue,
           i.kind as institution_kind
    FROM users u
    LEFT JOIN institutions i ON u.institution_id = i.id
    WHERE u.id = ?
  `, userId);

  if (!user) return null;

  let profile = null;
  let subscription = null;

  if (user.role === 'ALUMNI') {
    profile = await db.get('SELECT * FROM alumni_profiles WHERE user_id = ?', user.id) || null;
    if (profile) {
      profile.skills = JSON.parse(profile.skills_json || '[]');
      profile.mentorship_topics = JSON.parse(profile.mentorship_topics_json || '[]');
    }
  } else if (user.role === 'STUDENT') {
    profile = await db.get('SELECT * FROM student_profiles WHERE user_id = ?', user.id) || null;
  } else if (user.role === 'EXTERNAL') {
    profile = await db.get(`
      SELECT ep.*, i.short_name as interested_institution_short
      FROM external_profiles ep LEFT JOIN institutions i ON ep.interested_institution_id = i.id
      WHERE ep.user_id = ?
    `, user.id) || null;

    subscription = await getActiveSubscription(user.id);
  }

  user.is_premium = Boolean(subscription);

  return {
    user,
    profile,
    subscription,
    institution: await institutionSummary(user.institution_id)
  };
}

async function issue(res, userId, status = 200) {
  const session = await buildSession(userId);
  if (!session) return res.status(404).json({ error: 'User not found' });

  const token = createToken({ id: session.user.id, role: session.user.role });
  return res.status(status).json({ token, ...session });
}

router.get('/config', (req, res) => {
  res.json({ demo_login: demoLoginEnabled() });
});

// POST /api/auth/login { email, password, portal }
router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const { email, password, portal } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (portal && !PORTAL_ROLES[portal]) return res.status(400).json({ error: 'Unknown login portal' });

  const user = await db.get(
    'SELECT id, role, password_hash, is_active FROM users WHERE LOWER(email) = LOWER(?)',
    String(email).trim()
  );

  if (!user || !verifyPassword(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!user.is_active) {
    return res.status(403).json({
      error: 'This account has been deactivated by your institution. Contact your institution admin.',
      code: 'DEACTIVATED'
    });
  }

  if (portal && !PORTAL_ROLES[portal].includes(user.role)) {
    const correct = Object.keys(PORTAL_ROLES).find(p => PORTAL_ROLES[p].includes(user.role));
    return res.status(403).json({
      error: `This is ${/^[AEIOU]/.test(ROLE_PORTAL_LABEL[user.role]) ? 'an' : 'a'} ${ROLE_PORTAL_LABEL[user.role]} account. Please use the ${ROLE_PORTAL_LABEL[user.role]} login.`,
      code: 'WRONG_PORTAL',
      correct_portal: correct
    });
  }

  return issue(res, user.id);
}));

// ---------- Registration ----------

async function validateCommon(body, { emailField = 'email', nameField = 'full_name' } = {}) {
  const fullName = String(body[nameField] || '').trim();
  const email = String(body[emailField] || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (fullName.length < 2 || fullName.length > 80) return { error: 'Please enter your full name' };
  if (!EMAIL_RE.test(email) || email.length > 120) return { error: 'Please enter a valid email address' };
  if (password.length < 8) return { error: 'Password must be at least 8 characters' };

  if (await db.get('SELECT id FROM users WHERE LOWER(email) = ?', email)) {
    return { error: 'An account with this email already exists', status: 409 };
  }

  return { fullName, email, password };
}

// Institutions members can join: must exist and have an active subscription.
async function getJoinableInstitution(id) {
  if (!id) return { error: 'Please choose your institution' };

  const inst = await db.get(
    'SELECT id, short_name, email_domain, is_sandbox FROM institutions WHERE id = ?',
    id
  );

  if (!inst) return { error: 'Please choose your institution' };

  if (!(await getInstitutionAccess(inst.id)).active) {
    return {
      error: `${inst.short_name} is not accepting new members right now. Please contact your institution.`,
      status: 403
    };
  }

  return { inst };
}

const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const newId = prefix => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const today = () => new Date().toISOString().slice(0, 10);

function emailOnDomain(email, domain) {
  return Boolean(domain) && (email.endsWith('@' + domain) || email.endsWith('.' + domain));
}

// POST /api/auth/register/student
async function registerStudent(req, res) {
  const c = await validateCommon(req.body);
  if (c.error) return res.status(c.status || 400).json({ error: c.error });

  const j = await getJoinableInstitution(req.body.institution_id);
  if (j.error) return res.status(j.status || 400).json({ error: j.error });

  const inst = j.inst;
  const year = parseInt(req.body.graduation_year, 10);

  if (!year || year < CURRENT_YEAR || year > CURRENT_YEAR + 8) {
    return res.status(400).json({
      error: `Expected graduation / passing-out year must be between ${CURRENT_YEAR} and ${CURRENT_YEAR + 8}`
    });
  }

  const degree = clean(req.body.degree, 60);
  const branch = clean(req.body.branch, 60);
  const roll = clean(req.body.roll_number, 40);

  if (!degree || !branch) return res.status(400).json({ error: 'Course / class and branch / stream are required' });
  if (!roll) return res.status(400).json({ error: 'Your enrolment / roll number is required' });

  const roster = await db.get(`
    SELECT id FROM roster_records
    WHERE institution_id = ? AND record_type = 'STUDENT' AND LOWER(email) = ? AND status = 'UNCLAIMED'
  `, inst.id, c.email);

  const autoVerify = Boolean(roster || emailOnDomain(c.email, inst.email_domain))
    && !(await memberLimitReached(inst.id));

  const status = autoVerify ? 'VERIFIED' : 'PENDING';
  const userId = newId('u');

  await db.transaction(async tx => {
    await tx.run(`
      INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at, is_sandbox)
      VALUES (?, ?, ?, ?, 'STUDENT', ?, ?, ?, ?)
    `, userId, inst.id, c.email, hashPassword(c.password), c.fullName, status, autoVerify ? today() : null, inst.is_sandbox);

    if (roster && autoVerify) {
      await tx.run("UPDATE roster_records SET status = 'CLAIMED' WHERE id = ?", roster.id);
    }

    await tx.run(`
      INSERT INTO student_profiles (id, user_id, graduation_year, degree, branch, roll_number, target_industry, target_role)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, newId('sp'), userId, year, degree, branch, roll,
      clean(req.body.target_industry, 60) || null,
      clean(req.body.target_role, 60) || null);
  });

  return issue(res, userId, 201);
}

// POST /api/auth/register/alumni
async function registerAlumni(req, res) {
  const c = await validateCommon(req.body);
  if (c.error) return res.status(c.status || 400).json({ error: c.error });

  const j = await getJoinableInstitution(req.body.institution_id);
  if (j.error) return res.status(j.status || 400).json({ error: j.error });

  const inst = j.inst;
  const year = parseInt(req.body.graduation_year, 10);

  if (!year || year < 1950 || year > CURRENT_YEAR) {
    return res.status(400).json({ error: `Graduation / passing-out year must be between 1950 and ${CURRENT_YEAR}` });
  }

  const degree = clean(req.body.degree, 60);
  const branch = clean(req.body.branch, 60);
  const company = clean(req.body.current_company, 80) || 'Independent';
  const role = clean(req.body.current_role, 80) || 'Professional';
  const industry = clean(req.body.industry, 60) || 'Software & Internet';
  const location = clean(req.body.location, 60) || 'India';

  if (!degree || !branch) return res.status(400).json({ error: 'Degree / course and branch / stream are required' });

  const roster = await db.get(`
    SELECT id FROM roster_records
    WHERE institution_id = ? AND record_type = 'ALUMNI' AND LOWER(email) = ? AND status = 'UNCLAIMED'
  `, inst.id, c.email);

  const autoVerify = Boolean(roster) && !(await memberLimitReached(inst.id));
  const status = autoVerify ? 'VERIFIED' : 'PENDING';
  const userId = newId('u');

  await db.transaction(async tx => {
    await tx.run(`
      INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at, is_sandbox)
      VALUES (?, ?, ?, ?, 'ALUMNI', ?, ?, ?, ?)
    `, userId, inst.id, c.email, hashPassword(c.password), c.fullName, status, autoVerify ? today() : null, inst.is_sandbox);

    if (autoVerify) {
      await tx.run("UPDATE roster_records SET status = 'CLAIMED' WHERE id = ?", roster.id);
    }

    const profId = newId('ap');

    await tx.run(`
      INSERT INTO alumni_profiles (
        id, user_id, graduation_year, degree, branch, current_company, current_role,
        industry, location, is_open_to_mentoring, open_to_external, visibility, details_confirmed_at, stale_months,
        mentorship_topics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'PUBLIC', datetime('now'), 0, ?)
    `, profId, userId, year, degree, branch, company, role, industry, location,
      JSON.stringify(['Career Guidance', 'Resume Review']));

    await tx.run(`
      INSERT INTO career_steps (id, alumni_profile_id, year, role, company, is_current, display_order)
      VALUES (?, ?, ?, ?, ?, 0, 1)
    `, newId('cs'), profId, year, `Graduated Â· ${degree}`, inst.short_name);

    await tx.run(`
      INSERT INTO career_steps (id, alumni_profile_id, year, role, company, is_current, display_order)
      VALUES (?, ?, ?, ?, ?, 1, 2)
    `, newId('cs'), profId, CURRENT_YEAR, role, company);
  });

  return issue(res, userId, 201);
}

// POST /api/auth/register/external
async function registerExternal(req, res) {
  const c = await validateCommon(req.body);
  if (c.error) return res.status(c.status || 400).json({ error: c.error });

  const level = String(req.body.education_level || '').toUpperCase();
  if (!['SCHOOL', 'COLLEGE'].includes(level)) {
    return res.status(400).json({ error: 'Please choose whether you are in school or college' });
  }

  const currentInst = clean(req.body.current_institution, 120);
  if (!currentInst) {
    return res.status(400).json({ error: 'Please enter the name of your current school or college' });
  }

  let interestedId = null;

  if (req.body.interested_institution_id) {
    const row = await db.get(
      'SELECT id FROM institutions WHERE id = ?',
      req.body.interested_institution_id
    );

    if (!row) return res.status(400).json({ error: 'Unknown institution of interest' });
    interestedId = row.id;
  }

  const userId = newId('u');

  await db.transaction(async tx => {
    await tx.run(`
      INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at)
      VALUES (?, NULL, ?, ?, 'EXTERNAL', ?, 'VERIFIED', ?)
    `, userId, c.email, hashPassword(c.password), c.fullName, today());

    await tx.run(`
      INSERT INTO external_profiles (id, user_id, education_level, current_institution, current_year, field_of_interest, interested_institution_id, city)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, newId('ep'), userId, level, currentInst,
      clean(req.body.current_year, 40) || null,
      clean(req.body.field_of_interest, 80) || null,
      interestedId,
      clean(req.body.city, 60) || null);
  });

  return issue(res, userId, 201);
}

// POST /api/auth/register/institution — a college or school signs up and starts a free trial.
async function registerInstitution(req, res) {
  const b = req.body;
  const c = await validateCommon(b, { emailField: 'admin_email', nameField: 'admin_name' });

  if (c.error) return res.status(c.status || 400).json({ error: c.error });

  const name = clean(b.name, 160);
  const shortName = clean(b.short_name, 40) || name.slice(0, 40);
  const kind = String(b.kind || '').toUpperCase();
  const type = clean(b.type, 60);
  const city = clean(b.city, 60);
  const state = clean(b.state, 60);
  const founded = parseInt(b.founded, 10);
  const domain = String(b.email_domain || '').trim().toLowerCase().replace(/^@/, '');
  const plan = getPlan(b.plan_id || 'growth');

  if (name.length < 4) return res.status(400).json({ error: 'Please enter the full name of your institution' });
  if (!['COLLEGE', 'SCHOOL'].includes(kind)) return res.status(400).json({ error: 'Please choose college or school' });
  if (!type || !city || !state) return res.status(400).json({ error: 'Type, city and state are required' });
  if (!founded || founded < 1800 || founded > CURRENT_YEAR) return res.status(400).json({ error: 'Please enter a valid founding year' });
  if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Please enter your official email domain, e.g. college.edu.in' });
  if (!plan) return res.status(400).json({ error: 'Unknown plan' });

  if (b.accept_terms !== true && b.accept_terms !== 'on' && b.accept_terms !== 'true') {
    return res.status(400).json({ error: 'Please accept the subscription terms and data processing commitments' });
  }

  // The registering admin must hold an address on the institution's own domain.
  if (!emailOnDomain(c.email, domain)) {
    return res.status(400).json({ error: `Your admin email must be on your institutionâ€™s domain (@${domain})` });
  }

  if (await db.get('SELECT id FROM institutions WHERE LOWER(email_domain) = ?', domain)) {
    return res.status(409).json({
      error: 'An institution with this email domain is already registered. Ask its owner to add you as an admin.'
    });
  }

  const slug = shortName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'inst';
  const instId = `${slug}_${crypto.randomUUID().slice(0, 4)}`;
  const abbr = shortName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'IN';
  const userId = newId('u');

  await db.transaction(async tx => {
    await tx.run(`
      INSERT INTO institutions (id, name, short_name, abbr, kind, domain, city, state, type, founded, hue, about,
        email_domain, website, contact_email, data_sharing, public_profile, platform_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PRIVATE', 1, 0)
    `, instId, name, shortName, abbr, kind, kind === 'SCHOOL' ? 'school' : 'general',
      city, state, type, founded, Math.floor(Math.random() * 360),
      clean(b.about, 600) || null, domain,
      /^https?:\/\//.test(String(b.website || '')) ? clean(b.website, 200) : null,
      c.email);

    await tx.run(`
      INSERT INTO users (id, institution_id, email, password_hash, role, admin_level, full_name, verification_status, verified_at)
      VALUES (?, ?, ?, ?, 'ADMIN', 'OWNER', ?, 'VERIFIED', ?)
    `, userId, instId, c.email, hashPassword(c.password), c.fullName, today());

    await tx.run(`
      INSERT INTO institution_subscriptions (id, institution_id, plan_id, billing_cycle, status, trial_ends_at)
      VALUES (?, ?, ?, 'MONTHLY', 'TRIALING', datetime('now', ?))
    `, newId('isub'), instId, plan.id, `+${TRIAL_DAYS} days`);
  });

  req.user = { id: userId, full_name: c.fullName, role: 'ADMIN', admin_level: 'OWNER' };

  await audit(req, instId, 'INSTITUTION_REGISTERED', {
    details: { plan: plan.id, trial_days: TRIAL_DAYS }
  });

  await platformLog('INSTITUTION_REGISTERED', { institution_id: instId, name, kind });

  return issue(res, userId, 201);
}

router.post('/register/student', registerLimiter, asyncRoute(registerStudent));
router.post('/register/alumni', registerLimiter, asyncRoute(registerAlumni));
router.post('/register/external', registerLimiter, asyncRoute(registerExternal));
router.post('/register/institution', registerLimiter, asyncRoute(registerInstitution));

router.post('/register', registerLimiter, asyncRoute(async (req, res) => {
  const role = String(req.body.role || '').toUpperCase();

  if (role === 'STUDENT') return registerStudent(req, res);
  if (role === 'ALUMNI') return registerAlumni(req, res);
  if (role === 'EXTERNAL') return registerExternal(req, res);

  return res.status(400).json({
    error: 'Invalid user role. Institutions register through /register/institution.'
  });
}));

router.get('/me', requireAuth, asyncRoute(async (req, res) => {
  const session = await buildSession(req.user.id);
  if (!session) return res.status(404).json({ error: 'User not found' });
  return res.json(session);
}));

// POST /api/auth/demo-switch — passwordless persona switch for local evaluation only.
const DEMO_PERSONAS = {
  student: 'ishita@example.com',
  alumni: 'rohan@example.com',
  admin: 'admin@westbridge.example',
  admin_trial: 'admin@meridian.example',
  school_admin: 'principal@greenfield.example',
  external: 'aarav.school@example.com',
  external_premium: 'meera.premium@example.com',
  superadmin: 'superadmin@alumniplatform.com'
};

router.post('/demo-switch', asyncRoute(async (req, res) => {
  if (!demoLoginEnabled()) return res.status(404).json({ error: 'Demo login is disabled' });

  const email = DEMO_PERSONAS[req.body.persona];
  if (!email) return res.status(400).json({ error: 'Unknown persona' });

  const user = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (!user) return res.status(404).json({ error: 'Persona account not found. Run "npm run seed".' });

  return issue(res, user.id);
}));

export default router;
