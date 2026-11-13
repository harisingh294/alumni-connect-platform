import { icon, esc, inr } from '../icons.js';
import { api, downloadFile } from '../api.js';
import { toast, refresh, openModal } from '../state.js';

const STATE_BADGE = { ACTIVE: 'badge-good', TRIAL: 'badge-brand', CANCELLING: 'badge-warn', EXPIRED: 'badge-bad', NONE: '' };
const fmt = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length > 10 ? 'Z' : 'T00:00:00Z')).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const today = () => new Date().toISOString().slice(0, 10);

function currentTab() {
  const p = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  return ['institutions', 'usage', 'feedback', 'sandbox'].includes(p.get('tab')) ? p.get('tab') : 'institutions';
}

let feedbackById = new Map();
let showSandboxFeedback = false;

window._platformTab = (t) => { location.hash = '#/platform?tab=' + t; };
window._verifyInstitution = async (id, verified) => {
  try {
    await api.platform.verify(id, verified);
    toast(verified ? 'Institution verified and listed' : 'Verification removed', 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};
window._downloadUsage = async (id) => {
  try { await downloadFile(`/api/platform/institutions/${encodeURIComponent(id)}/usage.csv`, `usage-${id}-${today()}.csv`); } catch (err) { toast(err.message, 'bad'); }
};
window._downloadFeedbackCsv = async () => {
  try {
    await downloadFile(`/api/platform/feedback.csv${showSandboxFeedback ? '?include_sandbox=1' : ''}`, `feedback-log-${today()}.csv`);
    toast('Feedback log downloaded. In Google Sheets use File → Import → Upload.', 'good');
  } catch (err) { toast(err.message, 'bad'); }
};
window._toggleSandboxFeedback = (on) => { showSandboxFeedback = on; refresh(); };
window._editFeedback = (id) => { const f = feedbackById.get(id); if (f) openModal('feedback_edit', f); };
window._deleteFeedback = async (id) => {
  if (!confirm('Delete this feedback entry? Only do this for duplicates or mistakes.')) return;
  try { await api.platform.deleteFeedback(id); refresh(); } catch (err) { toast(err.message, 'bad'); }
};
window._logFeedback = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = f.querySelector('.form-err');
  err.textContent = '';
  try {
    await api.platform.logFeedback(Object.fromEntries(new FormData(f).entries()));
    toast('Feedback logged', 'good');
    refresh();
  } catch (ex) { err.textContent = ex.message; }
};
window._resetSandbox = async (btn) => {
  if (!confirm('Rebuild the fictional reviewer sandbox? Changes reviewers made there are discarded. Real institutions are not touched.')) return;
  btn.disabled = true;
  try {
    await api.platform.resetSandbox();
    toast('Sandbox rebuilt with fresh sample data', 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); btn.disabled = false; }
};

function tabs(active) {
  return `
    <div class="tabs" role="tablist" style="margin-bottom:18px">
      ${[['institutions', 'building', 'Institutions & revenue'], ['usage', 'chart', 'Usage evidence'], ['feedback', 'flag', 'Feedback log'], ['sandbox', 'shield', 'Reviewer sandbox']]
        .map(([k, ic, l]) => `<button role="tab" class="tab ${active === k ? 'on' : ''}" aria-selected="${active === k}" onclick="window._platformTab('${k}')">${icon(ic, 14)} ${l}</button>`).join('')}
    </div>
  `;
}

// ---------------- Institutions & revenue ----------------

async function institutionsTab() {
  const [{ institutions }, rev, log] = await Promise.all([api.platform.institutions(), api.platform.revenue(), api.platform.log()]);
  return `
    <div class="notice notice-warn">${icon('shield', 14)} Payments are simulated in this build, so revenue figures come from demo checkouts. Sandbox institutions are excluded.</div>
    <div class="stat-row" style="margin-bottom:14px">
      <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${inr(rev.b2b.mrr_inr)}</div><div class="stat-lbl">Institution MRR (demo payments)</div></div>
      <div class="stat-tile"><div class="stat-val num">${rev.institutions.by_state.ACTIVE + rev.institutions.by_state.CANCELLING}</div><div class="stat-lbl">Paying institutions</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--brand)">${rev.institutions.by_state.TRIAL}</div><div class="stat-lbl">In trial</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--bad)">${rev.institutions.by_state.EXPIRED}</div><div class="stat-lbl">Lapsed</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--violet)">${rev.b2c.active}</div><div class="stat-lbl">Premium visiting students</div></div>
    </div>

    <div class="table-wrap" style="margin-bottom:24px">
      <table>
        <thead><tr><th>Institution</th><th>Plan</th><th>Status</th><th class="num">Members</th><th class="num">MRR</th><th>Sharing</th><th>Verified</th></tr></thead>
        <tbody>
          ${institutions.map(i => `
            <tr style="${i.is_sandbox ? 'opacity:0.65' : ''}">
              <td><div style="font-weight:600">${esc(i.name)} ${i.is_sandbox ? '<span class="badge">Sandbox</span>' : '<span class="badge badge-good">Real</span>'}</div>
                <div class="tiny dim">${i.kind === 'SCHOOL' ? 'School' : 'College'} · ${esc(i.city)} · joined ${fmt(i.created_at)}</div></td>
              <td class="small">${esc(i.plan || '—')}<div class="tiny dim">${i.billing_cycle === 'ANNUAL' ? 'Annual' : 'Monthly'}</div></td>
              <td><span class="badge ${STATE_BADGE[i.state]}">${esc(i.state)}</span><div class="tiny dim">${i.days_left != null ? `${i.days_left} days · ${fmt(i.ends_at)}` : ''}</div></td>
              <td class="num small">${i.members}${i.member_limit ? ` / ${i.member_limit}` : ''}</td>
              <td class="num small">${inr(i.mrr_inr)}</td>
              <td><span class="badge">${i.data_sharing === 'PLATFORM' ? 'Network' : 'Private'}</span></td>
              <td>${i.platform_verified
                ? `<button class="btn btn-sm btn-ghost" onclick="window._verifyInstitution('${esc(i.id)}', false)">${icon('check', 13)} Verified</button>`
                : `<button class="btn btn-sm btn-primary" onclick="window._verifyInstitution('${esc(i.id)}', true)">Verify</button>`}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <section class="card card-pad">
      <h3 style="margin-bottom:10px">Platform log</h3>
      <div class="stack g6">
        ${log.entries.slice(0, 20).map(e => `<div class="row between small g8"><code>${esc(e.action)}</code><span class="tiny dim">${fmt(e.created_at)}</span></div>`).join('') || '<p class="tiny dim">No entries yet.</p>'}
      </div>
    </section>
  `;
}

// ---------------- Usage evidence ----------------

function usageCard(r) {
  const max = Math.max(1, ...r.weeks.map(w => w.active_users));
  return `
    <div class="card card-pad">
      <div class="row between astart wrap g8">
        <div>
          <div class="row g8 wrap"><h3>${esc(r.institution.name)}</h3>${r.institution.sandbox ? '<span class="badge">Sandbox</span>' : '<span class="badge badge-good">Real partner</span>'}</div>
          <div class="tiny dim">Account created ${fmt(r.institution.account_created)} · last activity ${fmt(r.last_active_at)}</div>
        </div>
        <button class="btn btn-sm" onclick="window._downloadUsage('${esc(r.institution.id)}')">${icon('doc', 13)} Download CSV</button>
      </div>
      <div class="stat-row stat-row-4" style="margin-top:12px">
        <div class="stat-tile"><div class="stat-val num">${r.totals.active_users_7d}</div><div class="stat-lbl">Active users, last 7 days</div></div>
        <div class="stat-tile"><div class="stat-val num">${r.totals.active_users_30d}</div><div class="stat-lbl">Active users, last 30 days</div></div>
        <div class="stat-tile"><div class="stat-val num">${r.totals.verified_students + r.totals.verified_alumni}</div><div class="stat-lbl">Verified members</div></div>
        <div class="stat-tile"><div class="stat-val num" style="color:${r.weeks_used_of_last_3 >= 2 ? 'var(--good)' : 'var(--bad)'}">${r.weeks_used_of_last_3} / 3</div><div class="stat-lbl">Weeks used, of the last 3</div></div>
      </div>
      <div class="table-wrap" style="margin-top:12px">
        <table>
          <thead><tr><th>Week</th><th class="num">Active users</th><th class="num">Requests</th><th class="num">Accepted</th><th class="num">Messages</th><th class="num">Applications</th><th class="num">Admin actions</th></tr></thead>
          <tbody>
            ${r.weeks.map(w => `
              <tr>
                <td class="small">${fmt(w.week_start)} – ${fmt(w.week_end)}</td>
                <td class="num small"><div class="row g6 end"><span>${w.active_users}</span><span class="cbar-track" style="width:60px;height:6px"><span class="cbar-fill" style="display:block;width:${(w.active_users / max) * 100}%"></span></span></div></td>
                <td class="num small">${w.mentorship_requests}</td><td class="num small">${w.mentorships_accepted}</td><td class="num small">${w.messages}</td>
                <td class="num small">${w.internship_applications}</td><td class="num small">${w.admin_actions}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function usageTab() {
  const { institutions } = await api.platform.usage();
  const real = institutions.filter(r => !r.institution.sandbox);
  const sandbox = institutions.filter(r => r.institution.sandbox);
  return `
    <p class="small muted" style="margin-bottom:14px">Counts only: no names, emails or messages. For each partner this shows the account creation date, active users, records created and activity by week for the last 4 weeks. Download the CSV into the partner’s evidence folder.</p>
    <h2 style="margin-bottom:10px">Real partners (${real.length})</h2>
    <div class="stack g16" style="margin-bottom:28px">${real.map(usageCard).join('') || '<div class="card card-pad muted small">No real institutions yet. Partners appear here once they register from “For institutions”.</div>'}</div>
    <details>
      <summary class="small font-semibold" style="cursor:pointer">Sandbox institutions (${sandbox.length}) — fictional, not evidence</summary>
      <div class="stack g16" style="margin-top:12px">${sandbox.map(usageCard).join('')}</div>
    </details>
  `;
}

// ---------------- Feedback log ----------------

async function feedbackTab() {
  const [fb, { institutions }] = await Promise.all([api.platform.feedback(showSandboxFeedback), api.platform.institutions()]);
  feedbackById = new Map(fb.feedback.map(f => [f.id, f]));
  const decisionTone = { Shipped: 'badge-good', 'In progress': 'badge-brand', Planned: 'badge-violet', "Won't do": 'badge-bad', New: 'badge-warn' };

  return `
    <div class="split-layout">
      <section>
        <div class="row between wrap g8" style="margin-bottom:10px">
          <p class="small muted">Newest first. Every shipped item needs a date and evidence; every “won't do” needs a reason.</p>
          <div class="row g8 wrap">
            <label class="row g6 small"><input type="checkbox" ${showSandboxFeedback ? 'checked' : ''} onchange="window._toggleSandboxFeedback(this.checked)"> Include sandbox</label>
            <button class="btn btn-sm btn-primary" onclick="window._downloadFeedbackCsv()">${icon('doc', 13)} Download for Google Sheets</button>
          </div>
        </div>
        ${fb.by_partner.length ? `<div class="row g8 wrap" style="margin-bottom:12px">${fb.by_partner.map(p => `<span class="chip">${esc(p.partner)}: <b>${p.entries}</b> entries · ${p.shipped} shipped</span>`).join('')}</div>` : ''}
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Partner & person</th><th>What they said</th><th>Type</th><th>Decision</th><th></th></tr></thead>
            <tbody>
              ${fb.feedback.map(f => `
                <tr>
                  <td class="small" style="white-space:nowrap">${fmt(f.received_on)}</td>
                  <td class="small">${esc(f.partner || '')}${f.is_sandbox ? ' <span class="badge">Sandbox</span>' : ''}<div class="tiny dim">${esc(f.person)}${f.person_role ? ` · ${esc(f.person_role)}` : ''} · ${esc(f.channel || '')}</div></td>
                  <td class="small" style="max-width:320px">“${esc(f.what_they_said)}”</td>
                  <td class="small">${esc(f.type)}</td>
                  <td><span class="badge ${decisionTone[f.decision] || ''}">${esc(f.decision)}</span>
                    ${f.shipped_on ? `<div class="tiny dim">${fmt(f.shipped_on)}</div>` : ''}${f.decision_reason ? `<div class="tiny dim">${esc(f.decision_reason)}</div>` : ''}</td>
                  <td><div class="row g6 end">
                    <button class="btn btn-sm" onclick="window._editFeedback('${esc(f.id)}')">Decide</button>
                    <button class="btn btn-sm btn-ghost" onclick="window._deleteFeedback('${esc(f.id)}')" aria-label="Delete">${icon('x', 13)}</button>
                  </div></td>
                </tr>
              `).join('') || '<tr><td colspan="6" class="muted small" style="text-align:center;padding:24px">No feedback yet. Partners can send it from the Feedback button, and you can log calls and visits on the right.</td></tr>'}
            </tbody>
          </table>
        </div>
      </section>
      <aside>
        <form class="card card-pad stack g10" onsubmit="window._logFeedback(event)">
          <h3>Log feedback from a call or visit</h3>
          <p class="tiny dim">Feedback you go looking for counts. Write their words, not your summary.</p>
          <div><label class="label" for="lf-date">Date</label><input class="input" id="lf-date" name="received_on" type="date" value="${today()}" required></div>
          <div><label class="label" for="lf-inst">Partner institution</label>
            <select class="select" id="lf-inst" name="institution_id">
              <option value="">Not on the platform yet (type below)</option>
              ${institutions.filter(i => !i.is_sandbox).map(i => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join('')}
            </select></div>
          <div><label class="label" for="lf-pname">…or partner name</label><input class="input" id="lf-pname" name="partner_name"></div>
          <div class="row g8">
            <div class="grow"><label class="label" for="lf-person">Person</label><input class="input" id="lf-person" name="person" required></div>
            <div class="grow"><label class="label" for="lf-role">Role</label><input class="input" id="lf-role" name="person_role" placeholder="e.g. Principal"></div>
          </div>
          <div class="row g8">
            <div class="grow"><label class="label" for="lf-chan">Channel</label>
              <select class="select" id="lf-chan" name="channel">${['Visit', 'Phone call', 'WhatsApp', 'Email', 'Video call', 'Sat with them while they used it'].map(c => `<option>${c}</option>`).join('')}</select></div>
            <div class="grow"><label class="label" for="lf-type">Type</label>
              <select class="select" id="lf-type" name="type">${fb.types.map(t => `<option>${esc(t)}</option>`).join('')}</select></div>
          </div>
          <div><label class="label" for="lf-said">What they said (their words)</label><textarea class="input" id="lf-said" name="what_they_said" rows="3" required></textarea></div>
          <p class="tiny form-err" style="color:var(--bad)"></p>
          <button type="submit" class="btn btn-primary">${icon('flag', 14)} Add to log</button>
        </form>
      </aside>
    </div>
  `;
}

// ---------------- Sandbox ----------------

function sandboxTab() {
  return `
    <div class="split-layout">
      <section class="card card-pad">
        <h2>Reviewer sandbox</h2>
        <p class="small muted" style="margin-top:6px">Faculty and other reviewers sign in to fictional institutions (Westbridge Institute of Technology, Lakeview College of Engineering,
          Meridian College of Commerce, Greenfield Public School and the just-registered, empty Northgate Arts &amp; Science College) that hold realistic sample data.
          The sandbox also holds a test feedback log and usage patterns for each “weeks used” case (3 of 3, 2 of 3, 0 of 3). Sandbox accounts can only see sandbox institutions, and real users never see them.
          Sandbox activity is excluded from revenue, usage evidence and the feedback log.</p>
        <p class="small muted" style="margin-top:8px">Rebuild the sandbox before a live review so the reviewer starts from a clean state. This only replaces the fictional institutions.</p>
        <button class="btn btn-primary" style="margin-top:14px" onclick="window._resetSandbox(this)">${icon('reset', 15)} Rebuild sandbox now</button>
      </section>
      <aside class="card card-pad">
        <h3>Test logins</h3>
        <p class="tiny dim" style="margin-top:4px">All use the shared sandbox password from the MVP access document.</p>
        <div class="stack g6 small" style="margin-top:10px">
          <div><b>Institution admin</b><div class="tiny dim">admin@westbridge.example</div></div>
          <div><b>Current student</b><div class="tiny dim">ishita@example.com</div></div>
          <div><b>Alumnus</b><div class="tiny dim">rohan@example.com</div></div>
          <div><b>Visiting student (Premium)</b><div class="tiny dim">meera.premium@example.com</div></div>
          <div><b>Empty new institution</b><div class="tiny dim">principal@northgate.example</div></div>
        </div>
      </aside>
    </div>
  `;
}

export async function renderPlatform() {
  const tab = currentTab();
  const body = tab === 'usage' ? await usageTab() : tab === 'feedback' ? await feedbackTab() : tab === 'sandbox' ? sandboxTab() : await institutionsTab();
  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Platform console</div>
      <h1 style="margin-top:4px">Run the service</h1>
      <p class="muted" style="margin-top:4px">${icon('shield', 13)} This console shows accounts, billing, aggregate usage and product feedback only. Member data is not accessible to platform staff.</p>
    </div>
    ${tabs(tab)}
    ${body}
  </div>
  `;
}
