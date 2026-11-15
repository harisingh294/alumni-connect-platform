import { icon, esc, inr } from '../icons.js';
import { api } from '../api.js';
import { applySession, goAfterLogin, toast } from '../state.js';

let cycle = 'MONTHLY';
let kind = 'COLLEGE';
window._fiCycle = (c) => { cycle = c; window.dispatchEvent(new Event('hashchange')); };
window._fiKind = (k) => { kind = k; window.dispatchEvent(new Event('hashchange')); };

const VALUE = [
  ['users', 'Verified alumni network', 'Import graduate rosters, auto-verify matching sign-ups, and keep career records current with yearly confirmations.'],
  ['spark', 'Mentorship that runs itself', 'Students send structured requests; alumni accept and talk in private threads. Run cohort programs and match pairs in one click.'],
  ['brief', 'Internships from your network', 'Alumni post openings for your students. You moderate the board and see every application.'],
  ['flag', 'Engagement tools', 'Announcements, alumni meetups and webinars with RSVPs keep graduates connected long after they leave.'],
  ['chart', 'Outcomes & value report', 'Where graduates work, which batches mentor, monthly engagement trends and a community health score for accreditation and leadership.'],
  ['shield', 'Your data stays yours', 'Private by default, full export any time, a complete audit log, and one-step deletion. We never sell or use your data.']
];

export async function renderForInstitutions() {
  let plans = [];
  let trialDays = 30;
  try {
    const p = await api.billing.plans();
    plans = p.plans;
    trialDays = p.trial_days;
  } catch { /* offline */ }
  const price = (p) => (cycle === 'ANNUAL'
    ? (kind === 'SCHOOL' ? p.school_annual_inr : p.annual_inr)
    : (kind === 'SCHOOL' ? p.school_monthly_inr : p.monthly_inr));

  return `
  <div class="page">
    <section class="hero" style="padding-top:20px">
      <div class="hero-grid">
        <div>
          <span class="badge badge-brand">${icon('building', 13)} For colleges and schools</span>
          <h1 style="margin-top:14px">Your alumni network, mentorship programme and outcomes data in one place.</h1>
          <p style="margin-top:12px;font-size:1.05rem;line-height:1.55;color:var(--ink-2)">
            AlumVerse gives your institution its own private workspace to verify students and alumni, run mentorship,
            share internships, engage graduates and prove outcomes. We are only the technology provider. <b>Your data stays yours.</b>
          </p>
          <div class="row g10 wrap" style="margin-top:22px">
            <a class="btn btn-primary" href="#/register-institution">${icon('spark', 15)} Start a ${trialDays}-day free trial</a>
            <a class="btn" href="#/trust">${icon('shield', 15)} How we protect your data</a>
          </div>
          <p class="tiny dim" style="margin-top:10px">No payment needed for the trial. Full access to Growth features.</p>
        </div>
        <div class="card card-pad">
          <div class="eyebrow">What institutions measure</div>
          <div class="stack g10" style="margin-top:12px">
            ${['Verified alumni and current students', 'Mentorship requests answered and median response time', 'Internship applications from your students', 'Event attendance and monthly active members', 'Alumni profiles kept up to date for accreditation'].map(t => `<div class="row g8 small">${icon('check', 14)} ${esc(t)}</div>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section style="margin-bottom:40px">
      <h2 style="margin-bottom:16px">Everything your institution needs</h2>
      <div class="portal-grid">
        ${VALUE.map(([ic, t, d]) => `
          <div class="card card-pad"><div style="color:var(--brand)">${icon(ic, 24)}</div><h3 style="margin-top:10px">${esc(t)}</h3><p class="small muted" style="margin-top:4px">${esc(d)}</p></div>
        `).join('')}
      </div>
    </section>

    <section style="margin-bottom:40px">
      <div class="row between wrap g10" style="margin-bottom:16px">
        <h2>Simple pricing</h2>
        <div class="row g8 wrap">
          <div class="tabs" style="margin:0">
            <button class="tab ${kind === 'COLLEGE' ? 'on' : ''}" onclick="window._fiKind('COLLEGE')">College</button>
            <button class="tab ${kind === 'SCHOOL' ? 'on' : ''}" onclick="window._fiKind('SCHOOL')">School (40% off)</button>
          </div>
          <div class="tabs" style="margin:0">
            <button class="tab ${cycle === 'MONTHLY' ? 'on' : ''}" onclick="window._fiCycle('MONTHLY')">Monthly</button>
            <button class="tab ${cycle === 'ANNUAL' ? 'on' : ''}" onclick="window._fiCycle('ANNUAL')">Annual</button>
          </div>
        </div>
      </div>
      <div class="price-grid" style="max-width:none">
        ${plans.map(p => `
          <div class="card card-pad price-card ${p.id === 'growth' ? 'price-card-featured' : ''}">
            ${p.id === 'growth' ? '<span class="badge badge-violet" style="align-self:flex-start">Most popular</span>' : ''}
            <h3>${esc(p.name)}</h3>
            <div class="row g6" style="align-items:baseline"><span class="stat-val num">${inr(price(p))}</span><span class="small muted">/ ${cycle === 'ANNUAL' ? 'year' : 'month'}</span></div>
            <ul class="perk-list">${p.highlights.map(h => `<li>${icon('check', 13)} ${esc(h)}</li>`).join('')}</ul>
            <a class="btn ${p.id === 'growth' ? 'btn-violet' : ''}" style="margin-top:auto" href="#/register-institution">Start free trial</a>
          </div>
        `).join('')}
      </div>
      <p class="tiny dim" style="margin-top:12px">Prices exclude GST. Data export, audit log, privacy controls and deletion are included on every plan.</p>
    </section>
  </div>
  `;
}

// ---------------- Registration ----------------

let regPlans = [];
window._registerInstitution = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = document.getElementById('reg-err');
  const btn = f.querySelector('button[type=submit]');
  err.textContent = '';
  const d = Object.fromEntries(new FormData(f).entries());
  if (d.password !== d.password_confirm) { err.textContent = 'Passwords do not match.'; return; }
  delete d.password_confirm;
  d.accept_terms = f.accept_terms.checked;
  btn.disabled = true;
  try {
    const res = await api.institutions.register(d);
    applySession(res);
    toast(`Welcome! ${res.institution.name} is set up with a free trial.`, 'good');
    goAfterLogin();
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
};
window._regDomainHint = (input) => {
  const el = document.getElementById('reg-domain-hint');
  const d = input.value.trim().replace(/^@/, '');
  el.textContent = d ? `Your admin email must end with @${d}. Students signing up with @${d} are verified automatically.` : '';
};

export async function renderRegisterInstitution() {
  try { regPlans = (await api.billing.plans()).plans; } catch { regPlans = []; }
  const y = new Date().getFullYear();
  return `
  <div class="page-narrow" style="max-width:720px">
    <a class="small font-semibold muted row g6" href="#/for-institutions" style="margin-bottom:16px">${icon('back', 14)} Plans & features</a>
    <div class="card card-pad auth-card" style="border-top:4px solid var(--good)">
      <div class="row g10">
        <span style="color:var(--good)">${icon('building', 24)}</span>
        <div><div class="eyebrow">Register your institution</div><h2>Start your free trial</h2></div>
      </div>
      <form class="stack g12" style="margin-top:18px" onsubmit="window._registerInstitution(event)">
        <h4>Institution</h4>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:260px"><label class="label" for="ri-name">Full name of the institution</label><input class="input" id="ri-name" name="name" required minlength="4"></div>
          <div style="width:180px"><label class="label" for="ri-short">Short name</label><input class="input" id="ri-short" name="short_name" placeholder="e.g. RIT"></div>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:160px"><label class="label" for="ri-kind">We are a</label>
            <select class="select" id="ri-kind" name="kind"><option value="COLLEGE">College / University</option><option value="SCHOOL">School</option></select></div>
          <div class="grow" style="min-width:200px"><label class="label" for="ri-type">Type</label><input class="input" id="ri-type" name="type" required placeholder="e.g. Autonomous College, CBSE School"></div>
          <div style="width:120px"><label class="label" for="ri-founded">Founded</label><input class="input" id="ri-founded" name="founded" type="number" min="1800" max="${y}" required></div>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:160px"><label class="label" for="ri-city">City</label><input class="input" id="ri-city" name="city" required></div>
          <div class="grow" style="min-width:160px"><label class="label" for="ri-state">State</label><input class="input" id="ri-state" name="state" required></div>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:220px"><label class="label" for="ri-domain">Official email domain</label><input class="input" id="ri-domain" name="email_domain" required placeholder="e.g. college.edu.in" oninput="window._regDomainHint(this)"></div>
          <div class="grow" style="min-width:220px"><label class="label" for="ri-web">Website (optional)</label><input class="input" id="ri-web" name="website" placeholder="https://"></div>
        </div>
        <p class="tiny dim" id="reg-domain-hint"></p>

        <h4 style="margin-top:6px">Owner account</h4>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:220px"><label class="label" for="ri-aname">Your full name</label><input class="input" id="ri-aname" name="admin_name" required></div>
          <div class="grow" style="min-width:220px"><label class="label" for="ri-aemail">Your official email</label><input class="input" id="ri-aemail" name="admin_email" type="email" required></div>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:200px"><label class="label" for="ri-pw">Password</label><input class="input" id="ri-pw" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
          <div class="grow" style="min-width:200px"><label class="label" for="ri-pw2">Confirm password</label><input class="input" id="ri-pw2" name="password_confirm" type="password" minlength="8" required autocomplete="new-password"></div>
        </div>

        <h4 style="margin-top:6px">Trial plan</h4>
        <select class="select" name="plan_id">
          ${regPlans.map(p => `<option value="${esc(p.id)}" ${p.id === 'growth' ? 'selected' : ''}>${esc(p.name)} — ${p.member_limit ? p.member_limit.toLocaleString('en-IN') + ' members' : 'unlimited members'}</option>`).join('')}
        </select>

        <label class="row g8 astart small" style="margin-top:6px">
          <input type="checkbox" name="accept_terms" style="margin-top:3px">
          <span>I am authorised to register this institution, and I accept the subscription terms and the <a href="#/trust" target="_blank">data processing commitments</a>: the institution owns its data and the platform acts only as its technology provider.</span>
        </label>
        <p class="tiny" id="reg-err" role="alert" style="color:var(--bad);font-weight:600"></p>
        <button type="submit" class="btn btn-primary">${icon('spark', 15)} Create institution & start trial</button>
      </form>
      <p class="small muted" style="margin-top:14px">Already registered? <a href="#/login/admin">Admin login</a></p>
    </div>
  </div>
  `;
}
