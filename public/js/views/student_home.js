import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, state, refresh } from '../state.js';
import { renderFeed } from './feed.js';

window._toggleSaveFromHome = async (profId) => {
  try {
    await api.learner.toggleSave(profId);
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

// Shared by the current-student and visiting-student dashboards.
export function requestList(myRequests, emptyCta) {
  if (!myRequests.length) {
    return `
      <div class="card card-pad" style="text-align:center;padding:32px">
        <p class="muted">You have not sent any mentorship requests yet.</p>
        ${emptyCta}
      </div>
    `;
  }
  return `
    <div class="stack g12">
      ${myRequests.map(r => {
        const toneVar = r.status === 'ACCEPTED' ? 'good' : r.status === 'DECLINED' ? 'bad' : 'warn';
        return `
          <div class="card card-pad" style="border-left:4px solid var(--${toneVar})">
            <div class="row between astart wrap g12">
              <div>
                <div class="row g8 wrap">
                  <a href="#/alumni/${esc(r.alumni_user_id)}" style="font-weight:700;font-size:1.05rem;color:var(--ink)">${esc(r.alumni_name)}</a>
                  <span class="badge badge-${toneVar}">${esc(r.status)}</span>
                </div>
                <div class="small muted" style="margin-top:2px">${esc(r.alumni_role)} at <b>${esc(r.alumni_company)}</b> · ${esc(r.alumni_institution)} Class of ${r.alumni_batch}</div>
              </div>
              <div class="row g8 wrap">
                <span class="badge badge-violet">${esc(r.topic)}</span>
                <span class="tiny dim num">${new Date(r.created_at.replace(' ', 'T')).toLocaleDateString()}</span>
              </div>
            </div>
            <div style="margin-top:12px;background:var(--surface-2);padding:12px 14px;border-radius:var(--r-md);font-size:0.88rem">
              <span class="dim font-semibold">Your message:</span>
              <p style="margin-top:4px;color:var(--ink)">“${esc(r.message)}”</p>
            </div>
            ${r.status === 'ACCEPTED' ? `
              <div class="card card-pad" style="margin-top:14px;background:var(--good-soft);border-color:var(--good-line)">
                <div class="row g8" style="color:var(--good);margin-bottom:6px">${icon('spark', 16)}<h4 style="color:var(--good)">Accepted · contact details unlocked</h4></div>
                ${r.response_note ? `<p class="small" style="color:var(--good);margin-bottom:8px"><b>Note from alumnus:</b> ${esc(r.response_note)}</p>` : ''}
                <div style="background:var(--surface);padding:10px 14px;border-radius:var(--r-sm);border:1px solid var(--good-line)">
                  <div class="eyebrow" style="color:var(--good);margin-bottom:4px">Meeting / contact details</div>
                  <div style="font-weight:600;color:var(--ink);word-break:break-all">${esc(r.meeting_info)}</div>
                </div>
                <button class="btn btn-sm" style="margin-top:10px" onclick="window._openConversation('${esc(r.id)}')">${icon('inbox', 13)} Messages (${r.message_count || 0})</button>
                ${r.program_id ? '<span class="badge badge-violet" style="margin-left:6px">Program match</span>' : ''}
              </div>
            ` : r.status === 'DECLINED' ? `
              <div style="margin-top:10px;font-size:0.84rem;color:var(--bad)">${icon('x', 13)} Request was declined. ${r.response_note ? `Reason: “${esc(r.response_note)}”` : ''}</div>
            ` : `
              <p class="tiny dim" style="margin-top:10px">${icon('inbox', 12)} Awaiting response. Contact details are revealed once accepted.</p>
            `}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

export function savedGrid(savedAlumni) {
  if (!savedAlumni.length) {
    return `<div class="card card-pad" style="text-align:center;padding:24px"><p class="small muted">Bookmark alumni whose career journeys you want to follow.</p></div>`;
  }
  return `
    <div class="alum-grid">
      ${savedAlumni.map(s => `
        <div class="alum-card" onclick="location.hash='#/alumni/${esc(s.user_id)}'">
          <div class="row between">
            <div style="font-weight:650">${esc(s.full_name)}</div>
            <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window._toggleSaveFromHome('${esc(s.id)}')" title="Remove" aria-label="Remove from saved">${icon('x', 14)}</button>
          </div>
          <div class="small muted">${esc(s.current_role)} at <b>${esc(s.current_company)}</b></div>
          <div class="tiny dim">${esc(s.institution_short)} · Class of ${s.graduation_year}</div>
        </div>
      `).join('')}
    </div>
  `;
}

export async function renderStudentHome() {
  const u = state.user;
  const verified = u.verification_status === 'VERIFIED';
  let myRequests = [];
  let savedAlumni = [];
  let suggestions = [];
  let internships = [];

  const [reqData, savedData, alumData, internData] = await Promise.allSettled([
    api.learner.getMyRequests(),
    api.learner.getSaved(),
    api.discovery.getAlumni({ inst: u.institution_id, mentor_only: '1' }),
    verified ? api.internships.list() : Promise.resolve({ internships: [] })
  ]);
  if (reqData.status === 'fulfilled') myRequests = reqData.value.requests || [];
  if (savedData.status === 'fulfilled') savedAlumni = savedData.value.saved || [];
  if (alumData.status === 'fulfilled') suggestions = (alumData.value.results || []).slice(0, 3);
  if (internData.status === 'fulfilled') internships = internData.value.internships || [];

  const pendingCount = myRequests.filter(r => r.status === 'PENDING').length;
  const acceptedCount = myRequests.filter(r => r.status === 'ACCEPTED').length;
  const feedHtml = verified ? await renderFeed() : '';

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Current student · ${esc(u.institution_short)}</div>
      <h1 style="margin-top:4px">Welcome back, ${esc(u.full_name)}</h1>
      <p class="muted" style="margin-top:4px">Mentorship, career guidance and internships from your college's alumni are free for you.</p>
    </div>

    ${verified ? '' : `
      <div class="notice notice-warn">${icon('shield', 14)} <span>Your account is waiting for verification by the ${esc(u.institution_short)} admin. You can explore now. Sending mentorship requests and applying to internships unlock once you are verified.</span></div>
    `}
    ${u.verification_status === 'REJECTED' ? `<div class="notice notice-bad">${icon('x', 14)} Verification was rejected: ${esc(u.reject_reason || '')}</div>` : ''}

    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile"><div class="stat-val num" style="color:var(--brand)">${savedAlumni.length}</div><div class="stat-lbl">Saved alumni</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--warn)">${pendingCount}</div><div class="stat-lbl">Awaiting reply</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${acceptedCount}</div><div class="stat-lbl">Mentors connected</div></div>
      <div class="stat-tile"><div class="stat-val num">${internships.length}</div><div class="stat-lbl">Open internships for you</div></div>
    </div>

    ${feedHtml}

    <div class="card card-pad" style="margin-bottom:28px">
      <h3>Find guidance</h3>
      <div class="row g10 wrap" style="margin-top:12px">
        <a class="btn btn-primary" href="#/alumni?inst=${esc(u.institution_id)}&mentor_only=1">${icon('spark', 15)} Mentors from ${esc(u.institution_short)}</a>
        <a class="btn" href="#/internships">${icon('brief', 15)} Internships</a>
        <a class="btn" href="#/institutions/${esc(u.institution_id)}">${icon('building', 15)} My institution's courses & placements</a>
      </div>
    </div>

    <section style="margin-bottom:32px">
      <div class="row between" style="margin-bottom:14px">
        <h2>My mentorship requests</h2>
        <span class="tiny dim">${myRequests.length} on record</span>
      </div>
      ${requestList(myRequests, `<a class="btn btn-primary btn-sm" href="#/alumni?inst=${esc(u.institution_id)}&mentor_only=1" style="margin-top:12px">Find a mentor</a>`)}
    </section>

    <section style="margin-bottom:32px">
      <h2 style="margin-bottom:14px">Saved profiles (${savedAlumni.length})</h2>
      ${savedGrid(savedAlumni)}
    </section>

    ${suggestions.length ? `
      <section>
        <h2 style="margin-bottom:14px">Mentors from your college you could ask this week</h2>
        <div class="alum-grid">
          ${suggestions.map(a => `
            <div class="alum-card" onclick="location.hash='#/alumni/${esc(a.user_id)}'">
              <div style="font-weight:650">${esc(a.full_name)}</div>
              <div class="small muted">${esc(a.current_role)} at <b>${esc(a.current_company)}</b></div>
              <div class="row wrap g6" style="margin-top:8px">${(a.mentorship_topics || []).map(t => `<span class="badge badge-violet">${esc(t)}</span>`).join('')}</div>
            </div>
          `).join('')}
        </div>
      </section>
    ` : ''}
  </div>
  `;
}
