import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, openModal, refresh, state } from '../state.js';
import { renderFeed } from './feed.js';

const TOPICS = ['Resume Review', 'Career Guidance', 'Mock Interview', 'Career transitions', 'Placement preparation', 'Higher studies abroad'];
const INDUSTRIES = ['Software & Internet', 'Fintech', 'Consulting', 'Financial Services', 'Semiconductors', 'E-commerce & Retail',
  'Consumer Internet', 'Manufacturing', 'IT Services', 'Government & Public Sector', 'Education', 'Other'];

let profile = null;
let requestsById = new Map();

async function updateMentorship(patch, message) {
  try {
    await api.alumni.updateMentorship(patch);
    toast(message, 'good');
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

window._saveAlumniProfile = async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api.alumni.updateProfile({
      current_company: form.company.value.trim(),
      current_role: form.role.value.trim(),
      industry: form.industry.value,
      location: form.location.value.trim(),
      headline: form.headline.value.trim(),
      bio: form.bio.value.trim(),
      linkedin_url: form.linkedin.value.trim(),
      visibility: form.visibility.value,
      skills: form.skills.value.split(',').map(s => s.trim()).filter(Boolean)
    });
    toast('Profile updated', 'good');
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

window._toggleAlumniMentorship = (checked) =>
  updateMentorship({ is_open_to_mentoring: checked }, `Mentorship ${checked ? 'turned on' : 'paused'}`);

window._toggleAlumniExternal = (checked) =>
  updateMentorship({ open_to_external: checked }, checked
    ? 'Premium students from other colleges can now request you'
    : 'Now mentoring students of your own college only');

window._toggleAlumniTopic = (idx) => {
  const topic = TOPICS[idx];
  const current = new Set(profile.mentorship_topics || []);
  if (current.has(topic)) current.delete(topic); else current.add(topic);
  updateMentorship({ mentorship_topics: [...current] }, 'Topics updated');
};

window._confirmAlumniFreshness = async () => {
  try {
    await api.alumni.confirmFreshness(profile.location);
    toast('Career details confirmed', 'good');
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

window._openAcceptModal = (reqId) => {
  const r = requestsById.get(reqId);
  if (r) openModal('accept_mentorship', { request_id: r.id, student_name: r.student_name });
};

window._declineRequest = async (reqId) => {
  const reason = prompt('Optional reason for declining (e.g. travelling, busy with a launch):');
  if (reason === null) return;
  try {
    await api.alumni.respondRequest(reqId, 'DECLINED', reason || 'Unable to take a mentorship session at this time.', null);
    toast('Request declined');
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

function requesterLine(r) {
  if (r.is_external) {
    const level = r.external_level === 'SCHOOL' ? 'School student' : 'College student';
    return `${level} · ${esc(r.student_institution)}${r.external_year ? ' · ' + esc(r.external_year) : ''}${r.external_interest ? ' · Interested in ' + esc(r.external_interest) : ''}`;
  }
  return `${esc(r.student_institution)} · Class of ${r.student_batch} (${esc(r.student_branch)})`;
}

export async function renderAlumniHome() {
  let requests = [];
  try {
    const [pData, rData] = await Promise.all([api.alumni.getProfile(), api.alumni.getRequests()]);
    profile = pData;
    requests = rData.requests || [];
  } catch (err) {
    console.error('Failed to load alumni dashboard:', err);
    profile = null;
  }
  if (!profile) return '<div class="page"><p class="muted">Could not load your alumni profile.</p></div>';

  requestsById = new Map(requests.map(r => [r.id, r]));
  const feedHtml = profile.verification_status === 'VERIFIED' ? await renderFeed() : '';
  const instSharing = state.institution?.data_sharing;
  const pending = requests.filter(r => r.status === 'PENDING');
  const accepted = requests.filter(r => r.status === 'ACCEPTED');
  const verified = profile.verification_status === 'VERIFIED';
  const statusBadge = verified
    ? `<span class="badge badge-good">${icon('shield', 11)} Verified</span>`
    : profile.verification_status === 'PENDING'
      ? '<span class="badge badge-warn">Awaiting verification</span>'
      : '<span class="badge badge-bad">Verification rejected</span>';

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Alumni workspace</div>
      <h1 style="margin-top:4px">Welcome back, ${esc(profile.full_name)}</h1>
      <p class="muted row g8 wrap" style="margin-top:4px">${esc(profile.institution_short)} · Class of ${profile.graduation_year} ${statusBadge}</p>
    </div>

    ${profile.verification_status === 'PENDING' ? `
      <div class="notice notice-warn">${icon('shield', 14)} <span>${esc(profile.institution_short)} is reviewing your alumni claim. Your profile becomes visible to students and you can post internships once it is approved.</span></div>
    ` : ''}

    ${feedHtml}

    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile"><div class="stat-val num" style="color:var(--warn)">${pending.length}</div><div class="stat-lbl">Requests awaiting you</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${accepted.length}</div><div class="stat-lbl">Students guided</div></div>
      <div class="stat-tile"><div class="stat-val" style="color:var(--violet)">${profile.is_open_to_mentoring ? 'Active' : 'Paused'}</div><div class="stat-lbl">Mentorship status</div></div>
      <div class="stat-tile"><div class="stat-val">${profile.stale_months === 0 ? 'Up to date' : profile.stale_months + ' mo ago'}</div><div class="stat-lbl">Last details confirmation</div></div>
    </div>

    ${profile.stale_months >= 12 ? `
      <div class="card card-pad" style="margin-bottom:24px;border-color:var(--warn-line);background:var(--warn-soft)">
        <div class="row between wrap g12">
          <div>
            <div class="row g8" style="color:var(--warn)">${icon('pin', 18)}<h3 style="color:var(--warn)">Confirm your career details</h3></div>
            <p class="small" style="margin-top:6px;color:var(--warn)">You last confirmed your role and city ${profile.stale_months} months ago. Students rely on this to plan their careers.</p>
          </div>
          <button class="btn btn-primary" onclick="window._confirmAlumniFreshness()">${icon('check', 15)} Still correct</button>
        </div>
      </div>
    ` : ''}

    <div class="split-layout">
      <section>
        <div class="row between" style="margin-bottom:14px">
          <h2>Mentorship requests (${pending.length} pending)</h2>
          <a class="small" href="#/internships">${icon('brief', 13)} Manage internships</a>
        </div>

        ${requests.length ? `
          <div class="stack g12" style="margin-bottom:32px">
            ${requests.map(r => {
              const tone = r.status === 'ACCEPTED' ? 'badge-good' : r.status === 'DECLINED' ? 'badge-bad' : 'badge-warn';
              return `
                <div class="card card-pad">
                  <div class="row between astart wrap g8">
                    <div>
                      <div class="row g8 wrap">
                        <span style="font-weight:700;font-size:1.02rem">${esc(r.student_name)}</span>
                        <span class="badge ${tone}">${esc(r.status)}</span>
                        ${r.is_external
                          ? `<span class="badge badge-warn">${icon('star', 10)} Premium · other college</span>`
                          : '<span class="badge badge-brand">Your institution</span>'}
                        ${r.program_id ? '<span class="badge badge-violet">Program match</span>' : ''}
                      </div>
                      <div class="small muted">${requesterLine(r)}</div>
                    </div>
                    <div class="row g6 wrap">
                      <span class="badge badge-violet">${esc(r.topic)}</span>
                      <span class="tiny dim num">${new Date(r.created_at.replace(' ', 'T')).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style="margin-top:12px;background:var(--surface-2);padding:12px 14px;border-radius:var(--r-md);font-size:0.88rem">
                    <p style="color:var(--ink)">“${esc(r.message)}”</p>
                  </div>
                  ${r.status === 'PENDING' ? `
                    <div class="row g8" style="margin-top:14px">
                      <button class="btn btn-primary btn-sm" onclick="window._openAcceptModal('${esc(r.id)}')">${icon('check', 14)} Accept & share meeting info</button>
                      <button class="btn btn-sm" onclick="window._declineRequest('${esc(r.id)}')">Decline</button>
                    </div>
                  ` : r.status === 'ACCEPTED' ? `
                    <div class="small" style="margin-top:12px;color:var(--good)">${icon('check', 14)} <b>Shared:</b> ${esc(r.meeting_info)}</div>
                    <button class="btn btn-sm" style="margin-top:10px" onclick="window._openConversation('${esc(r.id)}')">${icon('inbox', 13)} Messages (${r.message_count || 0})</button>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <div class="card card-pad" style="text-align:center;padding:32px;margin-bottom:32px">
            <p class="muted">No mentorship requests yet. Requests appear here when students contact you.</p>
          </div>
        `}

        <div class="card card-pad">
          <h2 style="margin-bottom:18px">Edit career profile</h2>
          <form onsubmit="window._saveAlumniProfile(event)" class="stack g14">
            <div class="row g12 wrap">
              <div class="grow" style="min-width:200px"><label class="label" for="ap-company">Current company</label><input class="input" id="ap-company" name="company" value="${esc(profile.current_company)}" required></div>
              <div class="grow" style="min-width:200px"><label class="label" for="ap-role">Job title</label><input class="input" id="ap-role" name="role" value="${esc(profile.current_role)}" required></div>
            </div>
            <div class="row g12 wrap">
              <div class="grow" style="min-width:200px">
                <label class="label" for="ap-industry">Industry</label>
                <select class="select" id="ap-industry" name="industry">
                  ${[...new Set([profile.industry, ...INDUSTRIES])].map(ind => `<option value="${esc(ind)}" ${profile.industry === ind ? 'selected' : ''}>${esc(ind)}</option>`).join('')}
                </select>
              </div>
              <div class="grow" style="min-width:200px"><label class="label" for="ap-location">City</label><input class="input" id="ap-location" name="location" value="${esc(profile.location)}" required></div>
            </div>
            <div><label class="label" for="ap-headline">Headline</label><input class="input" id="ap-headline" name="headline" value="${esc(profile.headline || '')}"></div>
            <div><label class="label" for="ap-bio">Bio</label><textarea class="input" id="ap-bio" name="bio" rows="3">${esc(profile.bio || '')}</textarea></div>
            <div class="row g12 wrap">
              <div class="grow" style="min-width:200px"><label class="label" for="ap-linkedin">LinkedIn URL</label><input class="input" id="ap-linkedin" name="linkedin" type="url" placeholder="https://www.linkedin.com/in/..." value="${esc(profile.linkedin_url || '')}"></div>
              <div class="grow" style="min-width:200px"><label class="label" for="ap-skills">Skills (comma separated)</label><input class="input" id="ap-skills" name="skills" value="${esc((profile.skills || []).join(', '))}"></div>
            </div>
            <div>
              <label class="label" for="ap-vis">Profile visibility</label>
              <select class="select" id="ap-vis" name="visibility">
                <option value="PUBLIC" ${profile.visibility === 'PUBLIC' ? 'selected' : ''}>Public: all signed-in students, including other colleges</option>
                <option value="STUDENTS_ONLY" ${profile.visibility === 'STUDENTS_ONLY' ? 'selected' : ''}>My college only: students and alumni of ${esc(profile.institution_short)}</option>
                <option value="HIDDEN" ${profile.visibility === 'HIDDEN' ? 'selected' : ''}>Hidden: counted only in aggregate statistics</option>
              </select>
            </div>
            <button type="submit" class="btn btn-primary" style="margin-top:10px;align-self:flex-start">${icon('check', 15)} Save profile</button>
          </form>
        </div>
      </section>

      <aside class="stack g20">
        <div class="card card-pad" style="border-color:var(--violet-line)">
          <div class="row between wrap g8">
            <div class="row g8" style="color:var(--violet)">${icon('spark', 18)}<h3>Mentorship</h3></div>
            <label class="row g8" style="cursor:pointer">
              <input type="checkbox" ${profile.is_open_to_mentoring ? 'checked' : ''} onchange="window._toggleAlumniMentorship(this.checked)">
              <span class="small font-semibold">${profile.is_open_to_mentoring ? 'Accepting' : 'Paused'}</span>
            </label>
          </div>
          <p class="small muted" style="margin-top:6px">Students of ${esc(profile.institution_short)} can request you for free.</p>

          ${profile.is_open_to_mentoring ? `
            ${instSharing === 'PRIVATE' ? `
            <p class="tiny dim" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">${icon('lock', 11)} ${esc(profile.institution_short)} keeps its community private, so you mentor its own students only.</p>
            ` : `
            <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
              <label class="row g8 astart" style="cursor:pointer">
                <input type="checkbox" style="margin-top:3px" ${profile.open_to_external ? 'checked' : ''} onchange="window._toggleAlumniExternal(this.checked)">
                <span>
                  <span class="small font-semibold">Also mentor students from other colleges & schools</span>
                  <span class="tiny dim" style="display:block">Only Premium subscribers can request you. Leave this off to mentor your own college only.</span>
                </span>
              </label>
            </div>
            `}

            <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
              <div class="label">Topics you are open to</div>
              <div class="row wrap g6" style="margin-top:6px">
                ${TOPICS.map((t, idx) => {
                  const on = (profile.mentorship_topics || []).includes(t);
                  return `<button type="button" class="chip" aria-pressed="${on}" style="cursor:pointer;${on ? 'background:var(--violet-soft);border-color:var(--violet-line);color:var(--violet-ink);font-weight:600' : ''}" onclick="window._toggleAlumniTopic(${idx})">${on ? icon('check', 12) : ''} ${esc(t)}</button>`;
                }).join('')}
              </div>
            </div>
          ` : `<p class="small dim" style="margin-top:10px">Turn on availability so students can reach you.</p>`}
        </div>

        <div class="card card-pad">
          <div class="row g8">${icon('brief', 18)}<h3>Share an internship</h3></div>
          <p class="small muted" style="margin-top:6px">Post openings at your company for students of your college, or for everyone.</p>
          <a class="btn btn-sm" style="margin-top:12px" href="#/internships">Post or manage internships</a>
        </div>
      </aside>
    </div>
  </div>
  `;
}
