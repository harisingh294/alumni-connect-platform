// Role-specific login & signup pages. Each user type has its own portal.
import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { state, applySession, goAfterLogin, demoLogin, toast, ROLE_LABEL } from '../state.js';

export const PORTALS = {
  student: {
    title: 'Current Students',
    tagline: 'Enrolled at a partner college',
    cta: 'current student',
    color: 'var(--brand)',
    icon: 'cap',
    perks: ['Free mentorship from alumni of your college', 'Career guidance and mock interviews', 'Internships shared by your alumni']
  },
  alumni: {
    title: 'Alumni',
    tagline: 'Graduated from a partner college',
    cta: 'alumnus',
    color: 'var(--violet)',
    icon: 'users',
    perks: ['Mentor students of your own college for free', 'Share internships with juniors', 'Keep your verified career profile up to date']
  },
  external: {
    title: 'Students from Other Colleges & Schools',
    tagline: 'Exploring colleges or careers',
    cta: 'visiting student',
    color: 'var(--warn)',
    icon: 'book',
    perks: ['Free: courses, placements and alumni-network data', 'Premium: personal mentorship and career guidance', 'Premium: internship opportunities']
  },
  admin: {
    title: 'Institution Admins',
    tagline: 'College staff managing the network',
    cta: 'admin',
    color: 'var(--good)',
    icon: 'building',
    perks: ['Verify alumni and students', 'Import graduate rosters', 'See outcome analytics']
  },
  platform: {
    title: 'Platform Team',
    tagline: 'AlumVerse operations',
    cta: 'platform staff',
    color: 'var(--ink-2)',
    icon: 'cog',
    perks: []
  }
};

const DEMO = {
  student: [['student', 'Ishita Rao', 'Current student · Westbridge Tech']],
  alumni: [['alumni', 'Rohan Deshpande', 'Alumnus · Stripe, Westbridge Tech 2016']],
  external: [
    ['external', 'Aarav Khanna', 'Class 12 student · Free account'],
    ['external_premium', 'Meera Joshi', 'B.Sc. student · Premium account']
  ],
  admin: [
    ['admin', 'Priya Menon', 'Owner · Westbridge Tech · Growth plan'],
    ['admin_trial', 'Arvind Khanna', 'Owner · Meridian Commerce · free trial'],
    ['school_admin', 'Dr. Lata Kulkarni', 'Owner · Greenfield School · trial expired']
  ],
  platform: [['superadmin', 'Operations Team', 'Platform console · billing only']]
};

window._demoLogin = (persona) => demoLogin(persona);

function demoBlock(portals) {
  if (!state.config.demo_login) return '';
  const rows = portals.flatMap(p => DEMO[p] || []);
  return `
    <div class="card card-pad" style="margin-top:20px;border-style:dashed">
      <div class="eyebrow">Demo accounts (local development only)</div>
      <p class="tiny dim" style="margin-top:4px">One-click sign in with seeded data. This is switched off automatically when NODE_ENV=production.</p>
      <div class="stack g6" style="margin-top:10px">
        ${rows.map(([key, name, desc]) => `
          <button class="persona-item" style="border:1px solid var(--border);background:var(--surface);text-align:left;width:100%" onclick="window._demoLogin('${key}')">
            <div class="grow">
              <div class="small font-semibold">${esc(name)}</div>
              <div class="tiny dim">${esc(desc)}</div>
            </div>
            ${icon('arrow', 14)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

export function renderPortalChooser(mode) {
  const isLogin = mode === 'login';
  const keys = ['student', 'alumni', 'external'];
  return `
  <div class="page">
    <div class="page-head" style="text-align:center">
      <div class="eyebrow">${isLogin ? 'Log in' : 'Create your account'}</div>
      <h1 style="margin-top:6px">${isLogin ? 'Who is logging in?' : 'Which best describes you?'}</h1>
      <p class="muted" style="margin-top:6px">Each type of member has a separate ${isLogin ? 'login' : 'signup'} and workspace.</p>
    </div>

    <div class="portal-grid">
      ${keys.map(k => {
        const p = PORTALS[k];
        return `
          <a class="card card-pad card-hover portal-card" href="#/${mode}/${k}">
            <div style="color:${p.color}">${icon(p.icon, 30)}</div>
            <h3 style="margin-top:12px">${esc(p.title)}</h3>
            <p class="small muted" style="margin-top:2px">${esc(p.tagline)}</p>
            <ul class="perk-list">
              ${p.perks.map(x => `<li>${icon('check', 13)} ${esc(x)}</li>`).join('')}
            </ul>
            <span class="btn btn-sm" style="margin-top:auto;align-self:flex-start;color:${p.color}">
              ${isLogin ? 'Log in' : 'Sign up'} as ${esc(p.cta)} ${icon('arrow', 13)}
            </span>
          </a>
        `;
      }).join('')}
    </div>

    <p class="small muted" style="text-align:center;margin-top:20px">
      ${isLogin
        ? `New here? <a href="#/signup">Create an account</a> · College or school staff? <a href="#/login/admin">Admin login</a> · <a href="#/login/platform">Platform team</a>`
        : `Already have an account? <a href="#/login">Log in</a>`}
    </p>

    ${isLogin ? `<div class="page-narrow">${demoBlock(['student', 'alumni', 'external', 'admin', 'platform'])}</div>` : `
      <p class="small muted" style="text-align:center;margin-top:6px">Representing a college or school? <a href="#/register-institution">Register your institution</a></p>
    `}
  </div>
  `;
}

// ---------------- Login ----------------

window._submitLogin = async (e, portal) => {
  e.preventDefault();
  const form = e.target;
  const errEl = document.getElementById('auth-err');
  const btn = form.querySelector('button[type=submit]');
  errEl.innerHTML = '';
  btn.disabled = true;
  try {
    const res = await api.auth.login(form.email.value.trim(), form.password.value, portal);
    applySession(res);
    toast(`Welcome back, ${res.user.full_name}`, 'good');
    goAfterLogin();
  } catch (err) {
    btn.disabled = false;
    errEl.textContent = err.message;
    if (err.code === 'WRONG_PORTAL' && err.data?.correct_portal) {
      const p = err.data.correct_portal;
      errEl.innerHTML = `${esc(err.message)} <a href="#/login/${p}">Go to ${esc(PORTALS[p].title)} login</a>`;
    }
  }
};

export function renderLogin(portal) {
  const p = PORTALS[portal];
  return `
  <div class="page-narrow" style="max-width:460px">
    <a class="small font-semibold muted row g6" href="#/login" style="margin-bottom:16px">${icon('back', 14)} All login options</a>
    <div class="card card-pad auth-card" style="border-top:4px solid ${p.color}">
      <div class="row g10">
        <span style="color:${p.color}">${icon(p.icon, 24)}</span>
        <div>
          <div class="eyebrow">Log in</div>
          <h2>${esc(p.title)}</h2>
        </div>
      </div>
      <form class="stack g12" style="margin-top:18px" onsubmit="window._submitLogin(event, '${portal}')">
        <div>
          <label class="label" for="login-email">Email address</label>
          <input class="input" id="login-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div>
          <label class="label" for="login-password">Password</label>
          <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <p class="tiny" id="auth-err" role="alert" style="color:var(--bad);font-weight:600"></p>
        <button type="submit" class="btn btn-primary">Log in</button>
      </form>
      ${['student', 'alumni', 'external'].includes(portal) ? `
        <p class="small muted" style="margin-top:14px">No account yet? <a href="#/signup/${portal}">Sign up as ${esc(p.title.toLowerCase())}</a></p>
      ` : portal === 'admin' ? `
        <p class="small muted" style="margin-top:14px">New institution? <a href="#/register-institution">Register your college or school</a> and start a free trial. Colleagues are added by your institution’s owner.</p>
      ` : ''}
    </div>
    ${demoBlock([portal])}
  </div>
  `;
}

// ---------------- Signup ----------------

const INDUSTRIES = ['Software & Internet', 'Fintech', 'Consulting', 'Financial Services', 'Semiconductors',
  'E-commerce & Retail', 'Consumer Internet', 'Manufacturing', 'IT Services', 'Government & Public Sector', 'Education', 'Other'];

let signupInstitutions = [];

window._onSignupInstChange = (sel) => {
  const hint = document.getElementById('domain-hint');
  if (!hint) return;
  const inst = signupInstitutions.find(i => i.id === sel.value);
  hint.innerHTML = inst?.email_domain
    ? `${icon('shield', 12)} Use your <b>@${esc(inst.email_domain)}</b> email for instant verification. Other emails are reviewed by the college admin.`
    : '';
};

window._submitSignup = async (e, portal) => {
  e.preventDefault();
  const form = e.target;
  const errEl = document.getElementById('auth-err');
  const btn = form.querySelector('button[type=submit]');
  errEl.textContent = '';

  const data = Object.fromEntries(new FormData(form).entries());
  if (data.password !== data.password_confirm) {
    errEl.textContent = 'Passwords do not match.';
    return;
  }
  delete data.password_confirm;

  btn.disabled = true;
  try {
    const res = await api.auth.register(portal, data);
    applySession(res);
    const pending = res.user.verification_status === 'PENDING';
    toast(pending ? 'Account created. Your college will verify it shortly.' : `Welcome, ${res.user.full_name}!`, 'good');
    goAfterLogin();
  } catch (err) {
    btn.disabled = false;
    errEl.textContent = err.message;
  }
};

function field(label, name, attrs = '', hint = '') {
  return `
    <div class="grow" style="min-width:180px">
      <label class="label" for="su-${name}">${label}</label>
      <input class="input" id="su-${name}" name="${name}" ${attrs}>
      ${hint ? `<p class="tiny dim" style="margin-top:4px">${hint}</p>` : ''}
    </div>
  `;
}

function instSelect(name, required, placeholder, onchange = '') {
  return `
    <select class="select" id="su-${name}" name="${name}" ${required ? 'required' : ''} ${onchange}>
      <option value="">${esc(placeholder)}</option>
      ${signupInstitutions.map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}
    </select>
  `;
}

const passwordFields = `
  <div class="row g10 wrap">
    ${field('Password', 'password', 'type="password" minlength="8" autocomplete="new-password" required', 'At least 8 characters.')}
    ${field('Confirm password', 'password_confirm', 'type="password" minlength="8" autocomplete="new-password" required')}
  </div>
`;

function studentForm() {
  const y = new Date().getFullYear();
  return `
    <div>
      <label class="label" for="su-institution_id">Your college or school</label>
      ${instSelect('institution_id', true, 'Choose your institution', 'onchange="window._onSignupInstChange(this)"')}
    </div>
    <div class="row g10 wrap">
      ${field('Full name', 'full_name', 'autocomplete="name" required')}
      ${field('College email', 'email', 'type="email" autocomplete="email" required')}
    </div>
    <p class="tiny dim" id="domain-hint" style="margin-top:-6px"></p>
    <div class="row g10 wrap">
      ${field('Enrolment / roll number', 'roll_number', 'required')}
      ${field('Expected graduation year', 'graduation_year', `type="number" min="${y}" max="${y + 6}" value="${y + 2}" required`)}
    </div>
    <div class="row g10 wrap">
      ${field('Degree', 'degree', 'placeholder="e.g. B.Tech" required')}
      ${field('Branch / major', 'branch', 'placeholder="e.g. Computer Science" required')}
    </div>
    ${field('Career interest (optional)', 'target_industry', 'placeholder="e.g. Fintech, Consulting"')}
  `;
}

function alumniForm() {
  const y = new Date().getFullYear();
  return `
    <div>
      <label class="label" for="su-institution_id">College or school you graduated from</label>
      ${instSelect('institution_id', true, 'Choose your institution')}
    </div>
    <div class="row g10 wrap">
      ${field('Full name', 'full_name', 'autocomplete="name" required')}
      ${field('Email', 'email', 'type="email" autocomplete="email" required', 'Use the email your college has on record for instant verification.')}
    </div>
    <div class="row g10 wrap">
      ${field('Graduation year', 'graduation_year', `type="number" min="1950" max="${y}" required`)}
      ${field('Degree', 'degree', 'placeholder="e.g. B.Tech" required')}
      ${field('Branch / major', 'branch', 'placeholder="e.g. Mechanical" required')}
    </div>
    <div class="row g10 wrap">
      ${field('Current company', 'current_company', 'placeholder="e.g. Google"')}
      ${field('Current role', 'current_role', 'placeholder="e.g. Product Manager"')}
    </div>
    <div class="row g10 wrap">
      <div class="grow" style="min-width:180px">
        <label class="label" for="su-industry">Industry</label>
        <select class="select" id="su-industry" name="industry">
          ${INDUSTRIES.map(i => `<option>${esc(i)}</option>`).join('')}
        </select>
      </div>
      ${field('City', 'location', 'placeholder="e.g. Bengaluru"')}
    </div>
  `;
}

function externalForm() {
  return `
    <div class="row g10 wrap">
      ${field('Full name', 'full_name', 'autocomplete="name" required')}
      ${field('Email', 'email', 'type="email" autocomplete="email" required')}
    </div>
    <div class="row g10 wrap">
      <div class="grow" style="min-width:180px">
        <label class="label" for="su-education_level">I am currently in</label>
        <select class="select" id="su-education_level" name="education_level" required>
          <option value="SCHOOL">School</option>
          <option value="COLLEGE">College / University</option>
        </select>
      </div>
      ${field('Class / year', 'current_year', 'placeholder="e.g. Class 12 or B.Sc. 2nd year"')}
    </div>
    ${field('Name of your current school or college', 'current_institution', 'required')}
    <div class="row g10 wrap">
      ${field('Field of interest', 'field_of_interest', 'placeholder="e.g. Computer Science, Commerce"')}
      ${field('City', 'city', 'placeholder="e.g. Pune"')}
    </div>
    <div>
      <label class="label" for="su-interested_institution_id">College you are interested in (optional)</label>
      ${instSelect('interested_institution_id', false, 'Not sure yet')}
    </div>
    <div class="card card-pad" style="background:var(--surface-2);padding:12px 14px">
      <div class="small"><b>Free account:</b> courses, placement records and alumni-network data for every partner college.</div>
      <div class="small" style="margin-top:4px"><b>Premium (from ₹499/month):</b> personal mentorship, career guidance and internship opportunities. You can upgrade any time after signing up.</div>
    </div>
  `;
}

export async function renderSignup(portal) {
  try {
    // Members join any active institution; visiting students pick from publicly listed ones.
    signupInstitutions = (portal === 'external' ? await api.institutions.list() : await api.institutions.joinable()).institutions || [];
  } catch {
    signupInstitutions = [];
  }
  const p = PORTALS[portal];
  const body = portal === 'student' ? studentForm() : portal === 'alumni' ? alumniForm() : externalForm();
  const note = portal === 'student'
    ? 'Students who sign up with their college email are verified instantly. Others are reviewed by the college admin before they can message alumni.'
    : portal === 'alumni'
      ? 'If your email is on your college’s graduate roster you are verified instantly. Otherwise the college admin reviews your claim before your profile is shown.'
      : '';

  return `
  <div class="page-narrow" style="max-width:640px">
    <a class="small font-semibold muted row g6" href="#/signup" style="margin-bottom:16px">${icon('back', 14)} All signup options</a>
    <div class="card card-pad auth-card" style="border-top:4px solid ${p.color}">
      <div class="row g10">
        <span style="color:${p.color}">${icon(p.icon, 24)}</span>
        <div>
          <div class="eyebrow">Sign up</div>
          <h2>${esc(p.title)}</h2>
        </div>
      </div>
      ${note ? `<p class="small muted" style="margin-top:10px">${icon('shield', 12)} ${esc(note)}</p>` : ''}
      <form class="stack g12" style="margin-top:18px" onsubmit="window._submitSignup(event, '${portal}')">
        ${body}
        ${passwordFields}
        <p class="tiny" id="auth-err" role="alert" style="color:var(--bad);font-weight:600"></p>
        <button type="submit" class="btn btn-primary">Create ${esc(ROLE_LABEL[portal === 'external' ? 'EXTERNAL' : portal.toUpperCase()].toLowerCase())} account</button>
      </form>
      <p class="small muted" style="margin-top:14px">Already registered? <a href="#/login/${portal}">Log in here</a></p>
    </div>
  </div>
  `;
}
