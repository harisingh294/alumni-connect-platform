// Dashboard for students from other colleges and schools.
import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { requestList, savedGrid } from './student_home.js';

export async function renderExternalHome() {
  const u = state.user;
  const p = state.profile || {};
  const premium = u.is_premium;
  const sub = state.subscription;

  const [instData, reqData, savedData] = await Promise.allSettled([
    api.institutions.list(),
    api.learner.getMyRequests(),
    api.learner.getSaved()
  ]);
  const institutions = instData.status === 'fulfilled' ? instData.value.institutions || [] : [];
  const myRequests = reqData.status === 'fulfilled' ? reqData.value.requests || [] : [];
  const saved = savedData.status === 'fulfilled' ? savedData.value.saved || [] : [];
  const interested = institutions.find(i => i.id === p.interested_institution_id);

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Visiting student${p.current_institution ? ' · ' + esc(p.current_institution) : ''}</div>
      <h1 style="margin-top:4px">Hi ${esc(u.full_name.split(' ')[0])}, explore your next step</h1>
      <p class="muted" style="margin-top:4px">Compare colleges by their courses, placements and real alumni outcomes.</p>
    </div>

    ${premium ? `
      <div class="notice notice-violet row between wrap g10">
        <span>${icon('star', 14)} <b>Premium active</b> until ${esc(new Date(sub.expires_at.replace(' ', 'T') + 'Z').toLocaleDateString())}. Mentorship and internships are unlocked.</span>
        <a class="btn btn-sm" href="#/premium">Manage plan</a>
      </div>
    ` : `
      <div class="card card-pad" style="margin-bottom:24px;background:var(--violet-soft);border-color:var(--violet-line)">
        <div class="row between wrap g16">
          <div>
            <div class="row g8" style="color:var(--violet-ink)">${icon('star', 18)}<h3 style="color:var(--violet-ink)">Get personal guidance with Premium</h3></div>
            <p class="small" style="margin-top:6px;color:var(--violet-ink)">Ask alumni about admissions, courses and careers, get your resume reviewed, and apply to internships from the alumni network.</p>
          </div>
          <a class="btn btn-violet" href="#/premium">See plans from ₹499</a>
        </div>
      </div>
    `}

    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile"><div class="stat-val num">${institutions.length}</div><div class="stat-lbl">Colleges to explore</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--brand)">${saved.length}</div><div class="stat-lbl">Saved alumni</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${myRequests.filter(r => r.status === 'ACCEPTED').length}</div><div class="stat-lbl">Mentors connected</div></div>
      <div class="stat-tile"><div class="stat-val" style="color:${premium ? 'var(--violet)' : 'var(--ink-3)'}">${premium ? 'Premium' : 'Free'}</div><div class="stat-lbl">Your plan</div></div>
    </div>

    ${interested ? `
      <section class="card card-pad" style="margin-bottom:28px">
        <div class="row between wrap g12">
          <div>
            <div class="eyebrow">Your college of interest</div>
            <h3 style="margin-top:4px">${esc(interested.name)}</h3>
            <p class="small muted">${interested.course_count} courses · ${interested.verified_count} verified alumni</p>
          </div>
          <a class="btn btn-primary" href="#/institutions/${esc(interested.id)}">View courses & placements ${icon('arrow', 14)}</a>
        </div>
      </section>
    ` : ''}

    <section style="margin-bottom:32px">
      <h2 style="margin-bottom:14px">Colleges (free information)</h2>
      <div class="alum-grid">
        ${institutions.map(i => `
          <a class="alum-card" style="color:inherit" href="#/institutions/${esc(i.id)}">
            <div class="row g10">
              <div class="crest" style="background:linear-gradient(135deg, hsl(${i.hue} 60% 50%), hsl(${(i.hue + 35) % 360} 55% 40%))">${esc(i.abbr)}</div>
              <div><div style="font-weight:650">${esc(i.short_name)}</div><div class="tiny dim">${esc(i.city)}, ${esc(i.state)}</div></div>
            </div>
            <div class="row g16 tiny muted">
              <span>${icon('book', 12)} ${i.course_count} courses</span>
              <span>${icon('users', 12)} ${i.verified_count} alumni</span>
            </div>
          </a>
        `).join('')}
      </div>
    </section>

    <section style="margin-bottom:32px">
      <div class="row between" style="margin-bottom:14px">
        <h2>My mentorship requests</h2>
        ${premium ? '' : `<span class="badge badge-warn">${icon('lock', 11)} Premium</span>`}
      </div>
      ${premium
        ? requestList(myRequests, `<a class="btn btn-violet btn-sm" href="#/alumni?external_only=1" style="margin-top:12px">Find a mentor</a>`)
        : (myRequests.length ? requestList(myRequests, '') : `
          <div class="card card-pad" style="text-align:center;padding:28px">
            <p class="muted">Mentorship requests are part of Premium.</p>
            <a class="btn btn-violet btn-sm" href="#/premium" style="margin-top:12px">${icon('star', 13)} Unlock mentorship</a>
          </div>
        `)}
    </section>

    <section>
      <h2 style="margin-bottom:14px">Saved alumni (${saved.length})</h2>
      ${savedGrid(saved)}
    </section>
  </div>
  `;
}
