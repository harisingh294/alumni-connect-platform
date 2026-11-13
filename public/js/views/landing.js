import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { state, homeFor } from '../state.js';
import { PORTALS } from './auth.js';

export async function renderLanding() {
  let institutions = [];
  try {
    institutions = (await api.institutions.list()).institutions || [];
  } catch (e) {
    console.error('Failed to fetch institutions:', e);
  }

  const verifiedTotal = institutions.reduce((a, i) => a + (i.verified_count || 0), 0);
  const mentorTotal = institutions.reduce((a, i) => a + (i.mentor_count || 0), 0);
  const courseTotal = institutions.reduce((a, i) => a + (i.course_count || 0), 0);
  const u = state.user;

  const audience = (key, freeLabel, freeItems, extra = '') => {
    const p = PORTALS[key];
    return `
      <div class="card card-pad portal-card" style="border-top:4px solid ${p.color}">
        <div style="color:${p.color}">${icon(p.icon, 28)}</div>
        <h3 style="margin-top:10px">${esc(p.title)}</h3>
        <p class="small muted">${esc(p.tagline)}</p>
        <div class="eyebrow" style="margin-top:14px">${esc(freeLabel)}</div>
        <ul class="perk-list">${freeItems.map(x => `<li>${icon('check', 13)} ${esc(x)}</li>`).join('')}</ul>
        ${extra}
        ${u ? '' : `
          <div class="row g8 wrap" style="margin-top:auto;padding-top:14px">
            <a class="btn btn-primary btn-sm" href="#/signup/${key}">Sign up</a>
            <a class="btn btn-sm" href="#/login/${key}">Log in</a>
          </div>
        `}
      </div>
    `;
  };

  return `
  <section class="hero">
    <div class="hero-grid">
      <div>
        <span class="badge badge-brand">${icon('shield', 13)} One platform · three communities</span>
        <h1 style="margin-top:16px">Alumni, current students and future applicants, connected through their college.</h1>
        <p style="margin-top:12px;font-size:1.05rem;line-height:1.55;color:var(--ink-2)">
          Alumni give back with <b>free mentorship</b> to students of their own college. Students from other colleges and schools can
          explore <b>courses, placements and alumni outcomes</b> for free, and unlock personal mentorship and internships with <b>Premium</b>.
        </p>
        <div class="row g10 wrap" style="margin-top:24px">
          ${u ? `
            <a class="btn btn-primary" href="${homeFor(u)}">${icon('grid', 15)} Go to my dashboard</a>
          ` : `
            <a class="btn btn-primary" href="#/signup">${icon('spark', 15)} Create a free account</a>
            <a class="btn" href="#/login">Log in</a>
          `}
          <a class="btn btn-ghost" href="#/institutions">${icon('building', 15)} Browse colleges</a>
        </div>
      </div>

      <div class="card card-pad">
        <div class="eyebrow">Live network</div>
        <div class="stat-row" style="margin-top:12px;grid-template-columns:repeat(2,1fr)">
          <div class="stat-tile"><div class="stat-val num">${institutions.length}</div><div class="stat-lbl">Partner colleges</div></div>
          <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${verifiedTotal}</div><div class="stat-lbl">Verified alumni</div></div>
          <div class="stat-tile"><div class="stat-val num" style="color:var(--violet)">${mentorTotal}</div><div class="stat-lbl">Alumni mentoring</div></div>
          <div class="stat-tile"><div class="stat-val num">${courseTotal}</div><div class="stat-lbl">Courses listed</div></div>
        </div>
        <div class="row wrap g6" style="margin-top:14px">
          ${institutions.map(i => `<a class="chip" href="#/institutions">${esc(i.short_name)}</a>`).join('')}
        </div>
      </div>
    </div>
  </section>

  <section style="margin-bottom:44px">
    <div class="eyebrow">Choose your section</div>
    <h2 style="margin-top:8px;margin-bottom:20px">Separate spaces for each kind of member</h2>
    <div class="portal-grid">
      ${audience('alumni', 'What you can do', PORTALS.alumni.perks)}
      ${audience('student', 'Always free', PORTALS.student.perks)}
      ${audience('external', 'Free for everyone', ['Courses, fees and eligibility', 'Placement records and top recruiters', 'Alumni-network outcomes'], `
        <div class="eyebrow" style="margin-top:12px;color:var(--violet)">${icon('star', 11)} With Premium</div>
        <ul class="perk-list">
          ${['Personal mentorship from opted-in alumni', 'Career guidance and mock interviews', 'Internship opportunities'].map(x => `<li>${icon('lock', 12)} ${esc(x)}</li>`).join('')}
        </ul>
      `)}
    </div>
  </section>

  <section class="card card-pad" style="margin-bottom:40px;background:var(--violet-soft);border-color:var(--violet-line)">
    <div class="row between wrap g16">
      <div>
        <div class="row g8" style="color:var(--violet-ink)">${icon('star', 18)}<h3 style="color:var(--violet-ink)">Premium for students outside the college</h3></div>
        <p class="small" style="margin-top:6px;color:var(--violet-ink)">Plans start at ₹499 per month or ₹3,999 per year. Current students of a partner college never pay.</p>
      </div>
      <a class="btn btn-violet" href="#/premium">See Premium plans ${icon('arrow', 14)}</a>
    </div>
  </section>

  <section class="card card-pad" style="margin-bottom:28px;border-color:var(--good-line)">
    <div class="row between wrap g16">
      <div style="max-width:62ch">
        <div class="row g8" style="color:var(--good)">${icon('building', 18)}<h3>For colleges and schools</h3></div>
        <p class="small" style="margin-top:6px">Give your institution its own private workspace for alumni, students, mentorship, internships and outcomes reporting.
          Your data stays yours: private by default, exportable any time, never sold.</p>
      </div>
      <div class="row g8 wrap">
        <a class="btn btn-primary" href="#/for-institutions">Plans & features</a>
        <a class="btn" href="#/trust">${icon('shield', 14)} Trust & data</a>
      </div>
    </div>
  </section>

  <p class="tiny dim" style="text-align:center;margin-bottom:24px">Institution staff? <a href="#/login/admin">Admin login</a> · <a href="#/register-institution">Register your institution</a></p>
  `;
}
