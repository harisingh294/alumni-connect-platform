import { icon, esc, inr } from '../icons.js';
import { api } from '../api.js';
import { state, openModal, toast, refresh } from '../state.js';

const MODE_LABEL = { REMOTE: 'Remote', ONSITE: 'On-site', HYBRID: 'Hybrid' };
let byId = new Map();

window._openApplyModal = (id) => {
  const n = byId.get(id);
  if (n) openModal('apply_internship', { id: n.id, title: n.title, company: n.company });
};
window._openPostInternship = () => openModal('post_internship');
window._closeInternship = async (id) => {
  if (!confirm('Close this internship? Students will no longer see it.')) return;
  try {
    await api.internships.close(id);
    toast('Internship closed');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};
window._decideApplication = async (appId, status) => {
  try {
    await api.internships.decide(appId, status);
    toast(status === 'SHORTLISTED' ? 'Applicant shortlisted' : 'Applicant declined', status === 'SHORTLISTED' ? 'good' : 'default');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};

function meta(n) {
  return `
    <div class="row g16 wrap tiny muted" style="margin-top:8px">
      <span>${icon('pin', 12)} ${esc(n.location)} · ${esc(MODE_LABEL[n.mode] || n.mode)}</span>
      <span>${icon('brief', 12)} ${n.stipend_inr_month ? inr(n.stipend_inr_month) + '/month' : 'Unpaid'}</span>
      ${n.duration_weeks ? `<span>${n.duration_weeks} weeks</span>` : ''}
      ${n.deadline ? `<span>Apply by ${esc(n.deadline)}</span>` : ''}
    </div>
  `;
}

function learnerCard(n) {
  const applied = n.my_application;
  const tone = applied === 'SHORTLISTED' ? 'badge-good' : applied === 'REJECTED' ? 'badge-bad' : 'badge-brand';
  return `
    <div class="card card-pad">
      <div class="row between astart wrap g12">
        <div>
          <div class="row g8 wrap">
            <h3>${esc(n.title)}</h3>
            ${n.audience === 'OWN_COLLEGE' ? `<span class="badge">${esc(n.institution_short)} students only</span>` : ''}
          </div>
          <div class="small" style="margin-top:2px"><b>${esc(n.company)}</b> · posted by <a href="#/alumni/${esc(n.poster_id)}">${esc(n.poster_name)}</a> (${esc(n.institution_short)} alumni)</div>
          ${meta(n)}
        </div>
        ${applied
          ? `<span class="badge ${tone}">${applied === 'APPLIED' ? 'Applied' : esc(applied.charAt(0) + applied.slice(1).toLowerCase())}</span>`
          : `<button class="btn btn-primary btn-sm" onclick="window._openApplyModal('${esc(n.id)}')">Apply</button>`}
      </div>
      <p class="small" style="margin-top:12px">${esc(n.description)}</p>
      ${n.skills.length ? `<div class="row wrap g6" style="margin-top:10px">${n.skills.map(s => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : ''}
    </div>
  `;
}

function alumniView(postings, isAdmin = false) {
  const totalApps = postings.reduce((s, n) => s + n.applications.length, 0);
  return `
    <div class="page">
      <div class="page-head row between wrap g12">
        <div>
          <div class="eyebrow">${isAdmin ? 'Institution internship board' : 'Alumni · give back'}</div>
          <h1 style="margin-top:4px">${isAdmin ? 'Internships across your network' : 'Internships you have shared'}</h1>
          <p class="muted" style="margin-top:4px">${isAdmin
            ? `${postings.filter(n => n.status === 'OPEN').length} open listings · ${totalApps} applications. Post on behalf of ${esc(state.user.institution_short)} and moderate alumni listings.`
            : `Share openings with students of ${esc(state.user.institution_short)}, or with everyone including Premium students from other colleges.`}</p>
        </div>
        <button class="btn btn-primary" onclick="window._openPostInternship()">${icon('brief', 15)} Post an internship</button>
      </div>

      ${postings.length ? `<div class="stack g16">${postings.map(n => `
        <div class="card card-pad" style="${n.status === 'CLOSED' ? 'opacity:0.7' : ''}">
          <div class="row between astart wrap g12">
            <div>
              <div class="row g8 wrap">
                <h3>${esc(n.title)}</h3>
                <span class="badge ${n.status === 'OPEN' ? 'badge-good' : ''}">${esc(n.status)}</span>
                <span class="badge">${n.audience === 'ALL' ? 'Visible to all students' : 'Own college only'}</span>
              </div>
              <div class="small"><b>${esc(n.company)}</b>${isAdmin ? ` · posted by ${esc(n.poster_name)}${n.poster_role === 'ADMIN' ? ' (admin)' : ''}` : ''}</div>
              ${meta(n)}
            </div>
            ${n.status === 'OPEN' ? `<button class="btn btn-sm" onclick="window._closeInternship('${esc(n.id)}')">Close</button>` : ''}
          </div>
          <h4 style="margin-top:16px">Applicants (${n.applications.length})</h4>
          ${n.applications.length ? `
            <div class="stack g8" style="margin-top:8px">
              ${n.applications.map(a => `
                <div style="background:var(--surface-2);padding:10px 12px;border-radius:var(--r-md)">
                  <div class="row between wrap g8">
                    <div>
                      <b>${esc(a.applicant_name)}</b>
                      <span class="badge ${a.applicant_role === 'EXTERNAL' ? 'badge-warn' : 'badge-brand'}">${a.applicant_role === 'EXTERNAL' ? 'Other institution' : 'Your institution'}</span>
                      <div class="tiny dim">${esc(a.applicant_institution || '')} · ${esc(a.applicant_email)}</div>
                    </div>
                    ${a.status === 'APPLIED' ? `
                      <div class="row g6">
                        <button class="btn btn-sm btn-primary" onclick="window._decideApplication('${esc(a.id)}','SHORTLISTED')">Shortlist</button>
                        <button class="btn btn-sm" onclick="window._decideApplication('${esc(a.id)}','REJECTED')">Decline</button>
                      </div>
                    ` : `<span class="badge ${a.status === 'SHORTLISTED' ? 'badge-good' : 'badge-bad'}">${esc(a.status)}</span>`}
                  </div>
                  <p class="small" style="margin-top:6px;color:var(--ink)">“${esc(a.note)}”</p>
                </div>
              `).join('')}
            </div>
          ` : '<p class="tiny dim" style="margin-top:6px">No applications yet.</p>'}
        </div>
      `).join('')}</div>` : `
        <div class="card card-pad" style="text-align:center;padding:36px">
          <p class="muted">You have not posted any internships yet.</p>
          <button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="window._openPostInternship()">Post your first internship</button>
        </div>
      `}
    </div>
  `;
}

export async function renderInternships() {
  const u = state.user;

  if (u.role === 'ALUMNI' || u.role === 'ADMIN') {
    try {
      const data = await api.internships.manage();
      return alumniView(data.internships || [], u.role === 'ADMIN');
    } catch (err) {
      return `<div class="page"><p class="muted">${esc(err.message)}</p></div>`;
    }
  }

  let list = [];
  let blocked = null;
  try {
    list = (await api.internships.list()).internships || [];
  } catch (err) {
    blocked = err;
  }
  byId = new Map(list.map(n => [n.id, n]));

  const admin = u.role === 'ADMIN' || u.role === 'SUPERADMIN';

  if (blocked) {
    const premium = blocked.code === 'PREMIUM_REQUIRED';
    return `
      <div class="page page-narrow">
        <div class="card card-pad lock-card">
          <div style="color:var(--violet)">${icon('lock', 34)}</div>
          <h2 style="margin-top:10px">${premium ? 'Internships are a Premium feature' : 'Internships are locked for now'}</h2>
          <p class="muted" style="margin-top:6px">${esc(blocked.message)}</p>
          ${premium && blocked.data?.open_count ? `<p class="small" style="margin-top:6px"><b>${blocked.data.open_count}</b> internships from the alumni network are open right now.</p>` : ''}
          ${premium ? `<a class="btn btn-violet" style="margin-top:16px" href="#/premium">${icon('star', 14)} Unlock with Premium</a>` : ''}
        </div>
      </div>
    `;
  }

  return `
    <div class="page">
      <div class="page-head">
        <div class="eyebrow">${admin ? 'Admin view' : 'Opportunities from alumni'}</div>
        <h1 style="margin-top:4px">Internships</h1>
        <p class="muted" style="margin-top:4px">
          ${u.role === 'STUDENT' ? `Openings shared by ${esc(u.institution_short)} alumni, plus openings shared with all students.`
            : u.role === 'EXTERNAL' ? 'Openings that alumni have shared with students from every college. Included in your Premium plan.'
              : 'Internships posted by alumni of your institution.'}
        </p>
      </div>
      ${list.length
        ? `<div class="stack g16">${list.map(n => admin ? `
            <div class="card card-pad">
              <div class="row g8 wrap"><h3>${esc(n.title)}</h3><span class="badge ${n.status === 'OPEN' ? 'badge-good' : ''}">${esc(n.status)}</span></div>
              <div class="small"><b>${esc(n.company)}</b> · posted by ${esc(n.poster_name)}</div>
              ${meta(n)}
            </div>` : learnerCard(n)).join('')}</div>`
        : '<div class="card card-pad" style="text-align:center;padding:36px"><p class="muted">No open internships right now. Check back soon.</p></div>'}
    </div>
  `;
}
