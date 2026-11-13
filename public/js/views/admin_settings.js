import { icon, esc, inr } from '../icons.js';
import { api } from '../api.js';
import { state, toast, refresh, refreshSession, download, openModal, logout } from '../state.js';
import { meter } from './admin_home.js';

const isOwner = () => state.user?.admin_level === 'OWNER';
const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const LEVELS = { SCHOOL: 'School', UG: 'Undergraduate', PG: 'Postgraduate', DOCTORAL: 'Doctoral', DIPLOMA: 'Diploma' };

async function submit(e, fn, okMsg, after) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  const err = f.querySelector('.form-err');
  if (err) err.textContent = '';
  btn.disabled = true;
  try {
    await fn(Object.fromEntries(new FormData(f).entries()));
    toast(okMsg, 'good');
    if (after) await after();
    refresh();
  } catch (ex) {
    if (err) err.textContent = ex.message; else toast(ex.message, 'bad');
    btn.disabled = false;
  }
}

const ownerOnlyNote = () => (isOwner() ? '' : `<div class="notice">${icon('lock', 14)} Only the institution owner can change this.</div>`);

// ---------------- Profile, courses, placements ----------------

window._saveInstProfile = (e) => submit(e, api.inst.update, 'Institution profile saved', refreshSession);
window._addCourse = (e) => submit(e, api.inst.addCourse, 'Course added');
window._savePlacement = (e) => submit(e, api.inst.savePlacement, 'Placement record saved');
window._deleteCourse = async (id) => {
  if (!confirm('Delete this course?')) return;
  try { await api.inst.deleteCourse(id); refresh(); } catch (err) { toast(err.message, 'bad'); }
};
window._deletePlacement = async (year) => {
  if (!confirm(`Delete the ${year} placement record?`)) return;
  try { await api.inst.deletePlacement(year); refresh(); } catch (err) { toast(err.message, 'bad'); }
};

export async function renderAdminInstitution() {
  const { institution: i, courses, placements } = await api.inst.get();
  const y = new Date().getFullYear();
  return `
  <div class="page">
    <div class="page-head row between wrap g12">
      <div>
        <div class="eyebrow">Institution profile</div>
        <h1 style="margin-top:4px">${esc(i.name)}</h1>
        <p class="muted" style="margin-top:4px">This information appears on your public ${i.kind === 'SCHOOL' ? 'school' : 'college'} page${i.public_profile ? '' : ' (currently hidden — see Data & Privacy)'}.</p>
      </div>
      <a class="btn" href="#/institutions/${esc(i.id)}">${icon('arrow', 14)} View public page</a>
    </div>

    ${i.platform_verified ? '' : `<div class="notice notice-brand">${icon('shield', 14)} The platform team is confirming your institution. You can use everything now; your page will appear in the public college list once confirmed.</div>`}

    <div class="split-layout">
      <div class="stack g20">
        <section class="card card-pad">
          <div class="row between wrap g8" style="margin-bottom:12px"><h2>Courses (${courses.length})</h2></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Programme</th><th>Level</th><th class="num">Years</th><th class="num">Seats</th><th class="num">Annual fee</th><th></th></tr></thead>
              <tbody>
                ${courses.map(c => `
                  <tr>
                    <td><div style="font-weight:600">${esc(c.name)}</div><div class="tiny dim">${esc(c.eligibility || '')}</div></td>
                    <td class="small">${LEVELS[c.level]}</td><td class="num small">${c.duration_years}</td><td class="num small">${c.seats ?? '—'}</td>
                    <td class="num small">${inr(c.annual_fee_inr)}</td>
                    <td><button class="btn btn-sm btn-ghost" onclick="window._deleteCourse('${esc(c.id)}')" aria-label="Delete course">${icon('x', 13)}</button></td>
                  </tr>
                `).join('') || '<tr><td colspan="6" class="muted small" style="text-align:center">No courses yet.</td></tr>'}
              </tbody>
            </table>
          </div>
          <form class="row g8 wrap" style="margin-top:12px;align-items:flex-end" onsubmit="window._addCourse(event)">
            <div class="grow" style="min-width:200px"><label class="label" for="co-name">Course name</label><input class="input" id="co-name" name="name" required></div>
            <div><label class="label" for="co-level">Level</label><select class="select" id="co-level" name="level">${Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${(i.kind === 'SCHOOL' ? 'SCHOOL' : 'UG') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div style="width:90px"><label class="label" for="co-dur">Years</label><input class="input" id="co-dur" name="duration_years" type="number" step="0.5" min="0.5" required></div>
            <div style="width:90px"><label class="label" for="co-seats">Seats</label><input class="input" id="co-seats" name="seats" type="number" min="0"></div>
            <div style="width:130px"><label class="label" for="co-fee">Annual fee ₹</label><input class="input" id="co-fee" name="annual_fee_inr" type="number" min="0"></div>
            <div class="grow" style="min-width:200px"><label class="label" for="co-elig">Eligibility</label><input class="input" id="co-elig" name="eligibility"></div>
            <button type="submit" class="btn btn-primary">Add</button>
            <p class="tiny form-err" style="color:var(--bad);width:100%"></p>
          </form>
        </section>

        <section class="card card-pad">
          <h2 style="margin-bottom:12px">${i.kind === 'SCHOOL' ? 'Outcomes / placement records (optional)' : 'Placement records'}</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Year</th><th class="num">Placed</th><th class="num">Median LPA</th><th class="num">Highest LPA</th><th>Top recruiters</th><th></th></tr></thead>
              <tbody>
                ${placements.map(p => `
                  <tr>
                    <td class="num">${p.year}</td><td class="num small">${p.students_placed}/${p.students_eligible}</td>
                    <td class="num small">${p.median_ctc_lpa ?? '—'}</td><td class="num small">${p.highest_ctc_lpa ?? '—'}</td>
                    <td class="small muted">${p.top_recruiters.map(esc).join(', ')}</td>
                    <td><button class="btn btn-sm btn-ghost" onclick="window._deletePlacement(${p.year})" aria-label="Delete record">${icon('x', 13)}</button></td>
                  </tr>
                `).join('') || '<tr><td colspan="6" class="muted small" style="text-align:center">No placement records yet.</td></tr>'}
              </tbody>
            </table>
          </div>
          <form class="row g8 wrap" style="margin-top:12px;align-items:flex-end" onsubmit="window._savePlacement(event)">
            <div style="width:90px"><label class="label" for="pl-year">Year</label><input class="input" id="pl-year" name="year" type="number" value="${y - 1}" required></div>
            <div style="width:110px"><label class="label" for="pl-el">Eligible</label><input class="input" id="pl-el" name="students_eligible" type="number" min="1" required></div>
            <div style="width:110px"><label class="label" for="pl-pl">Placed</label><input class="input" id="pl-pl" name="students_placed" type="number" min="0" required></div>
            <div style="width:110px"><label class="label" for="pl-med">Median LPA</label><input class="input" id="pl-med" name="median_ctc_lpa" type="number" step="0.1"></div>
            <div style="width:110px"><label class="label" for="pl-high">Highest LPA</label><input class="input" id="pl-high" name="highest_ctc_lpa" type="number" step="0.1"></div>
            <div class="grow" style="min-width:200px"><label class="label" for="pl-rec">Top recruiters (comma separated)</label><input class="input" id="pl-rec" name="top_recruiters"></div>
            <button type="submit" class="btn btn-primary">Save year</button>
            <p class="tiny form-err" style="color:var(--bad);width:100%"></p>
          </form>
        </section>
      </div>

      <aside>
        <form class="card card-pad stack g10" onsubmit="window._saveInstProfile(event)">
          <h3>Details</h3>
          <div><label class="label" for="ip-short">Short name</label><input class="input" id="ip-short" name="short_name" value="${esc(i.short_name)}"></div>
          <div><label class="label" for="ip-type">Type</label><input class="input" id="ip-type" name="type" value="${esc(i.type)}"></div>
          <div class="row g8"><div class="grow"><label class="label" for="ip-city">City</label><input class="input" id="ip-city" name="city" value="${esc(i.city)}"></div>
            <div class="grow"><label class="label" for="ip-state">State</label><input class="input" id="ip-state" name="state" value="${esc(i.state)}"></div></div>
          <div><label class="label" for="ip-founded">Founded</label><input class="input" id="ip-founded" name="founded" type="number" value="${esc(i.founded)}"></div>
          <div><label class="label" for="ip-web">Website</label><input class="input" id="ip-web" name="website" value="${esc(i.website || '')}" placeholder="https://"></div>
          <div><label class="label" for="ip-contact">Contact email</label><input class="input" id="ip-contact" name="contact_email" value="${esc(i.contact_email || '')}"></div>
          <div><label class="label" for="ip-about">About</label><textarea class="input" id="ip-about" name="about" rows="5">${esc(i.about || '')}</textarea></div>
          <div class="tiny dim">Email domain for automatic student verification: <b>@${esc(i.email_domain)}</b></div>
          <p class="tiny form-err" style="color:var(--bad)"></p>
          <button type="submit" class="btn btn-primary">Save details</button>
        </form>
      </aside>
    </div>
  </div>
  `;
}

// ---------------- Team ----------------

window._addAdmin = (e) => submit(e, api.inst.addAdmin, 'Admin added. Share the initial password with them securely.');
let teamById = new Map();
window._removeAdmin = async (id) => {
  const name = teamById.get(id)?.full_name || 'this admin';
  if (!confirm(`Remove ${name} as an admin? Their account will be deleted.`)) return;
  try { await api.inst.removeAdmin(id); toast('Admin removed'); refresh(); } catch (err) { toast(err.message, 'bad'); }
};

export async function renderAdminTeam() {
  const { team, seats } = await api.inst.team();
  teamById = new Map(team.map(t => [t.id, t]));
  const domain = state.user.email.split('@')[1];
  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Admin team</div>
      <h1 style="margin-top:4px">Who can manage your institution</h1>
      <p class="muted" style="margin-top:4px">Admins can manage members, mentorship, internships and engagement. Only the owner can change billing, the team, or delete the institution.</p>
    </div>
    <div class="split-layout">
      <section>
        <div class="card card-pad" style="margin-bottom:16px">${meter(team.length, seats, 'Admin seats used')}</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Role</th><th>Last active</th><th></th></tr></thead>
            <tbody>
              ${team.map(t => `
                <tr>
                  <td><div style="font-weight:600">${esc(t.full_name)}</div><div class="tiny dim">${esc(t.email)}</div></td>
                  <td><span class="badge ${t.admin_level === 'OWNER' ? 'badge-violet' : ''}">${t.admin_level === 'OWNER' ? 'Owner' : 'Admin'}</span></td>
                  <td class="small muted">${t.last_active_at ? fmtDate(t.last_active_at) : 'Never'}</td>
                  <td>${isOwner() && t.admin_level !== 'OWNER' ? `<button class="btn btn-sm btn-ghost" onclick="window._removeAdmin('${esc(t.id)}')">Remove</button>` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
      <aside>
        ${isOwner() ? `
          <form class="card card-pad stack g10" onsubmit="window._addAdmin(event)">
            <h3>Add an admin</h3>
            <div><label class="label" for="tm-name">Full name</label><input class="input" id="tm-name" name="full_name" required></div>
            <div><label class="label" for="tm-email">Email (must be @${esc(domain)})</label><input class="input" id="tm-email" name="email" type="email" required></div>
            <div><label class="label" for="tm-pw">Initial password</label><input class="input" id="tm-pw" name="password" type="text" minlength="10" required autocomplete="off"></div>
            <p class="tiny dim">Share this password with your colleague directly. They should change it from Account & Privacy after their first login.</p>
            <p class="tiny form-err" style="color:var(--bad)"></p>
            <button type="submit" class="btn btn-primary">${icon('users', 14)} Add admin</button>
          </form>
        ` : ownerOnlyNote()}
      </aside>
    </div>
  </div>
  `;
}

// ---------------- Billing ----------------

let billingCycle = 'MONTHLY';
window._billingCycle = (c) => { billingCycle = c; refresh(); };
window._choosePlan = (planId) => openModal('inst_checkout', { plan_id: planId, cycle: billingCycle });
window._cancelInstPlan = async () => {
  if (!confirm('Turn off renewal? Your plan stays active until the end of the current period.')) return;
  try { await api.billing.cancel(); await refreshSession(); toast('Renewal turned off'); refresh(); } catch (err) { toast(err.message, 'bad'); }
};
window._resumeInstPlan = async () => {
  try { await api.billing.resume(); await refreshSession(); toast('Renewal turned back on', 'good'); refresh(); } catch (err) { toast(err.message, 'bad'); }
};

export async function renderAdminBilling() {
  const b = await api.billing.get();
  const school = b.kind === 'SCHOOL';
  const price = (p) => (billingCycle === 'ANNUAL' ? (school ? p.school_annual_inr : p.annual_inr) : (school ? p.school_monthly_inr : p.monthly_inr));
  const stateBadge = b.state === 'TRIAL' ? '<span class="badge badge-brand">Free trial</span>'
    : b.state === 'ACTIVE' ? '<span class="badge badge-good">Active</span>'
      : b.state === 'CANCELLING' ? '<span class="badge badge-warn">Ends soon</span>' : '<span class="badge badge-bad">Expired</span>';

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Plan & billing</div>
      <h1 style="margin-top:4px">Your subscription</h1>
    </div>
    ${ownerOnlyNote()}

    <div class="split-layout" style="margin-bottom:28px">
      <section class="card card-pad">
        <div class="row between wrap g8">
          <div>
            <div class="row g8 wrap"><h2>${esc(b.plan?.name || '—')}</h2>${stateBadge}</div>
            <p class="small muted" style="margin-top:4px">
              ${b.state === 'TRIAL' ? `Trial ends ${fmtDate(b.ends_at)} (${b.days_left} days left). Choose a plan to keep everything running.`
                : b.state === 'EXPIRED' ? 'Your subscription has ended. Community features are paused; data export and privacy tools still work.'
                  : `${b.billing_cycle === 'ANNUAL' ? 'Annual' : 'Monthly'} billing · ${inr(b.current_price_inr)} · ${b.cancel_at_period_end ? 'ends' : 'renews'} ${fmtDate(b.ends_at)}`}
            </p>
          </div>
          ${isOwner() && b.state === 'ACTIVE' ? `<button class="btn btn-sm btn-ghost" onclick="window._cancelInstPlan()">Turn off renewal</button>` : ''}
          ${isOwner() && b.state === 'CANCELLING' ? `<button class="btn btn-sm" onclick="window._resumeInstPlan()">Resume renewal</button>` : ''}
        </div>
        <div class="stack g12" style="margin-top:16px">
          ${meter(b.usage.members, b.usage.member_limit, 'Verified students & alumni')}
          ${meter(b.usage.admins, b.usage.admin_seats, 'Admin seats')}
        </div>
      </section>
      <aside class="card card-pad">
        <h3>What you never pay for</h3>
        <ul class="perk-list">
          <li>${icon('check', 13)} Exporting all of your data, any time</li>
          <li>${icon('check', 13)} Your audit log and privacy controls</li>
          <li>${icon('check', 13)} Deleting your institution and its data</li>
        </ul>
        <p class="tiny dim">These stay available even if your subscription lapses.</p>
      </aside>
    </div>

    <div class="row between wrap g8" style="margin-bottom:14px">
      <h2>Plans${school ? ' <span class="badge badge-good">School pricing: 40% off</span>' : ''}</h2>
      <div class="tabs" role="tablist" style="margin:0">
        <button class="tab ${billingCycle === 'MONTHLY' ? 'on' : ''}" onclick="window._billingCycle('MONTHLY')">Monthly</button>
        <button class="tab ${billingCycle === 'ANNUAL' ? 'on' : ''}" onclick="window._billingCycle('ANNUAL')">Annual (2 months free)</button>
      </div>
    </div>
    <div class="price-grid" style="max-width:none">
      ${b.plans.map(p => {
        const current = b.plan?.id === p.id && b.state !== 'TRIAL' && b.state !== 'EXPIRED' && b.billing_cycle === billingCycle;
        return `
          <div class="card card-pad price-card ${p.id === 'growth' ? 'price-card-featured' : ''}">
            ${p.id === 'growth' ? '<span class="badge badge-violet" style="align-self:flex-start">Most popular</span>' : ''}
            <h3>${esc(p.name)}</h3>
            <div class="row g6" style="align-items:baseline"><span class="stat-val num">${inr(price(p))}</span><span class="small muted">/ ${billingCycle === 'ANNUAL' ? 'year' : 'month'}</span></div>
            <ul class="perk-list">${p.highlights.map(h => `<li>${icon('check', 13)} ${esc(h)}</li>`).join('')}</ul>
            <div style="margin-top:auto">
              ${current ? `<button class="btn" disabled>${icon('check', 14)} Current plan</button>`
                : isOwner() ? `<button class="btn ${p.id === 'growth' ? 'btn-violet' : 'btn-primary'}" onclick="window._choosePlan('${p.id}')">${b.state === 'TRIAL' || b.state === 'EXPIRED' ? 'Choose' : 'Switch to'} ${esc(p.name)}</button>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <p class="tiny dim" style="margin-top:12px">${icon('shield', 11)} Payments are simulated in this build. No card details are collected. Prices exclude GST.</p>

    <section style="margin-top:28px">
      <h2 style="margin-bottom:10px">Invoices</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Plan</th><th>Period</th><th class="num">Amount</th><th>Reference</th></tr></thead>
          <tbody>
            ${b.invoices.map(v => `
              <tr><td class="small">${fmtDate(v.created_at)}</td><td class="small">${esc(v.plan_id)} · ${v.billing_cycle === 'ANNUAL' ? 'annual' : 'monthly'}</td>
                <td class="small muted">${fmtDate(v.period_start)} – ${fmtDate(v.period_end)}</td><td class="num small">${inr(v.amount_inr)}</td><td class="tiny dim">${esc(v.payment_ref)}</td></tr>
            `).join('') || '<tr><td colspan="5" class="muted small" style="text-align:center">No invoices yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  </div>
  `;
}

// ---------------- Data & privacy ----------------

window._saveSharing = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api.inst.settings({ data_sharing: f.data_sharing.value, public_profile: f.public_profile.checked });
    await refreshSession();
    toast('Data-sharing settings saved', 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};
window._exportInstitution = async () => {
  try {
    const data = await api.inst.exportData();
    download(`${state.user.institution_id}-export-${new Date().toISOString().slice(0, 10)}.json`, data);
    toast('Full export downloaded (recorded in your audit log)', 'good');
  } catch (err) { toast(err.message, 'bad'); }
};
window._deleteInstitution = async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!confirm('This permanently deletes your institution and every student, alumni and record in it. This cannot be undone. Continue?')) return;
  try {
    await api.inst.remove(f.confirm_name.value, f.password.value);
    toast('Your institution and all of its data have been deleted');
    logout();
  } catch (err) { f.querySelector('.form-err').textContent = err.message; }
};

export async function renderAdminPrivacy() {
  const [{ institution: i }, audit] = await Promise.all([api.inst.get(), api.inst.audit(150)]);
  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Data & privacy</div>
      <h1 style="margin-top:4px">You own your institution’s data</h1>
      <p class="muted" style="margin-top:4px">We only provide the technology. We do not sell, share, analyse for our own purposes, or advertise with your data. <a href="#/trust">Read our commitments</a>.</p>
    </div>

    <div class="split-layout">
      <div class="stack g20">
        <form class="card card-pad stack g12" onsubmit="window._saveSharing(event)">
          <h2>What leaves your community</h2>
          <label class="radio-card ${i.data_sharing === 'PRIVATE' ? 'on' : ''}">
            <input type="radio" name="data_sharing" value="PRIVATE" ${i.data_sharing === 'PRIVATE' ? 'checked' : ''}>
            <span><b>Private (recommended default)</b><br><span class="small muted">Alumni profiles, mentorship and internships are visible only to your own verified students and alumni.</span></span>
          </label>
          <label class="radio-card ${i.data_sharing === 'PLATFORM' ? 'on' : ''}">
            <input type="radio" name="data_sharing" value="PLATFORM" ${i.data_sharing === 'PLATFORM' ? 'checked' : ''}>
            <span><b>Share with the wider network</b><br><span class="small muted">Alumni who set their profile to Public appear to students of other institutions and visiting students. Alumni who opt in can mentor Premium visiting students. Internships marked “all students” are shown outside. Alumni can always restrict their own profile.</span></span>
          </label>
          <label class="row g8 small"><input type="checkbox" name="public_profile" ${i.public_profile ? 'checked' : ''}> Show our courses, placement records and aggregate alumni outcomes on our public page (no names)</label>
          <div><button type="submit" class="btn btn-primary">Save settings</button></div>
        </form>

        <section class="card card-pad">
          <div class="row between wrap g8" style="margin-bottom:10px">
            <h2>Audit log</h2>
            <span class="tiny dim">Every administrative action on your data</span>
          </div>
          <div class="table-wrap" style="max-height:460px;overflow:auto">
            <table>
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>
                ${audit.entries.map(a => `
                  <tr>
                    <td class="tiny dim" style="white-space:nowrap">${new Date(a.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</td>
                    <td class="small">${esc(a.actor_name)}<div class="tiny dim">${esc(a.actor_role || '')}</div></td>
                    <td class="small"><code>${esc(a.action)}</code></td>
                    <td class="tiny muted" style="max-width:280px;word-break:break-word">${esc(a.details || '')}</td>
                  </tr>
                `).join('') || '<tr><td colspan="4" class="muted small" style="text-align:center">No entries yet.</td></tr>'}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <aside class="stack g16">
        <div class="card card-pad">
          <h3>Export everything</h3>
          <p class="small muted" style="margin-top:4px">Download a complete JSON copy of your institution’s data: members, profiles, mentorships, internships, events, rosters and the audit log. Available on every plan, even after a subscription ends.</p>
          <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="window._exportInstitution()">${icon('doc', 14)} Download export</button>
        </div>

        <div class="card card-pad">
          <h3>How your data is protected</h3>
          <ul class="perk-list">
            <li>${icon('check', 13)} Separated from every other institution</li>
            <li>${icon('check', 13)} Platform staff cannot open member records</li>
            <li>${icon('check', 13)} Mentorship messages are readable only by the two people in them</li>
            <li>${icon('check', 13)} Passwords stored as salted scrypt hashes</li>
            <li>${icon('check', 13)} Deactivated members lose access immediately</li>
          </ul>
        </div>

        <form class="card card-pad stack g10" style="border-color:var(--bad-line)" onsubmit="window._deleteInstitution(event)">
          <h3 style="color:var(--bad)">Delete institution</h3>
          ${isOwner() ? `
            <p class="small muted">Permanently deletes ${esc(i.name)} and all of its students, alumni, records and history. Export first if you want a copy.</p>
            <div><label class="label" for="del-name">Type the full name to confirm</label><input class="input" id="del-name" name="confirm_name" autocomplete="off" required></div>
            <div><label class="label" for="del-pw">Your password</label><input class="input" id="del-pw" name="password" type="password" required></div>
            <p class="tiny form-err" style="color:var(--bad)"></p>
            <button type="submit" class="btn" style="color:var(--bad);border-color:var(--bad-line)">Delete permanently</button>
          ` : '<p class="small muted">Only the owner can delete the institution.</p>'}
        </form>
      </aside>
    </div>
  </div>
  `;
}
