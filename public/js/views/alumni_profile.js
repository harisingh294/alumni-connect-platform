import { icon, esc, safeUrl } from '../icons.js';
import { api } from '../api.js';
import { openModal, state, toast, refresh } from '../state.js';

let current = null;

window._openMentorshipRequestModal = () => {
  if (!current) return;
  openModal('request_mentorship', {
    alumni_id: current.user_id,
    name: current.full_name,
    role: current.current_role,
    company: current.current_company,
    topics: current.mentorship_topics || [],
    is_external: state.user?.role === 'EXTERNAL'
  });
};

window._toggleSaveProfile = async () => {
  if (!current) return;
  try {
    const res = await api.learner.toggleSave(current.id);
    toast(res.message, res.saved ? 'good' : 'default');
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

function mentorshipPanel(alum, isSelf) {
  const access = alum.access || {};
  const learner = state.user && (state.user.role === 'STUDENT' || state.user.role === 'EXTERNAL');

  if (!alum.is_open_to_mentoring) {
    return '<p class="small muted">This alumnus is not currently accepting mentorship requests.</p>';
  }

  const topics = `
    <div style="margin-top:14px">
      <div class="eyebrow" style="color:var(--violet-ink);margin-bottom:8px">Topics open to discuss</div>
      <div class="row wrap g6">${(alum.mentorship_topics || []).map(t => `<span class="badge badge-violet">${esc(t)}</span>`).join('')}</div>
    </div>
    <p class="tiny" style="margin-top:12px;color:var(--violet-ink)">
      ${alum.open_to_external ? `${icon('check', 11)} Also mentors students from other colleges (Premium)` : `${icon('shield', 11)} Mentors students of ${esc(alum.institution_short)} only`}
    </p>
  `;

  let action = '';
  if (isSelf || !learner) {
    action = '';
  } else if (access.can_request) {
    action = `
      <p class="tiny" style="margin-top:12px;color:var(--violet-ink)">${esc(access.reason)}</p>
      <button class="btn btn-violet btn-sm" style="width:100%;margin-top:10px" onclick="window._openMentorshipRequestModal()">
        ${icon('spark', 14)} Send structured request
      </button>
    `;
  } else if (access.code === 'PREMIUM_REQUIRED') {
    action = `
      <div class="notice notice-violet" style="margin-top:14px;margin-bottom:0">${icon('lock', 13)} ${esc(access.reason)}</div>
      <a class="btn btn-violet btn-sm" style="width:100%;margin-top:10px" href="#/premium">${icon('star', 14)} Unlock with Premium</a>
    `;
  } else {
    action = `<div class="notice" style="margin-top:14px;margin-bottom:0">${icon('lock', 13)} ${esc(access.reason)}</div>`;
  }

  return `
    <p class="small" style="color:var(--violet-ink);line-height:1.5">
      Contact details stay private until the alumnus reviews and accepts a request.
    </p>
    ${topics}
    ${action}
  `;
}

export async function renderAlumniProfile(id) {
  let alum = null;
  try {
    alum = await api.discovery.getAlumnus(id);
  } catch (err) {
    current = null;
    return `
      <div class="page page-narrow">
        <div class="card card-pad" style="text-align:center;padding:48px 24px">
          <h2>Profile not found</h2>
          <p class="muted" style="margin-top:8px">This profile does not exist or is not visible to your account.</p>
          <a class="btn btn-primary" href="#/alumni" style="margin-top:16px">${icon('back', 14)} Back to directory</a>
        </div>
      </div>
    `;
  }
  current = alum;

  const initials = alum.full_name.split(' ').map(w => w[0]).slice(0, 2).join('');
  const hue = (alum.graduation_year * 57) % 360;
  const isSelf = state.user && state.user.id === alum.user_id;
  const learner = state.user && (state.user.role === 'STUDENT' || state.user.role === 'EXTERNAL');
  const steps = alum.career_steps || [];
  const linkedin = safeUrl(alum.linkedin_url);
  const verified = alum.verification_status === 'VERIFIED';

  return `
  <div class="page">
    <a class="small font-semibold muted row g6" href="#/alumni" style="margin-bottom:18px">${icon('back', 14)} Back to alumni directory</a>

    <div class="card card-pad" style="margin-bottom:24px">
      <div class="row between astart wrap g16">
        <div class="row g20 astart wrap">
          <div class="av av-lg" style="background:linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 45) % 360} 60% 45%))">${esc(initials)}</div>
          <div>
            <div class="row g10 wrap">
              <h1>${esc(alum.full_name)}</h1>
              ${verified
                ? `<span class="badge badge-good">${icon('shield', 12)} Verified alumnus</span>`
                : `<span class="badge badge-warn">${esc(alum.verification_status)}</span>`}
            </div>
            <p style="font-size:1.15rem;font-weight:600;margin-top:4px">${esc(alum.current_role)} at <b style="color:var(--ink)">${esc(alum.current_company)}</b></p>
            <div class="row g16 wrap muted small" style="margin-top:8px">
              <span class="row g6">${icon('cap', 14)} ${esc(alum.institution_short)} · ${esc(alum.degree)} (${esc(alum.branch)}) · Class of ${alum.graduation_year}</span>
              <span class="row g6">${icon('pin', 14)} ${esc(alum.location)}</span>
              <span class="row g6">${icon('brief', 14)} ${esc(alum.industry)}</span>
            </div>
            ${alum.verified_at && verified ? `<p class="tiny dim" style="margin-top:8px">${icon('shield', 11)} Affiliation verified by ${esc(alum.institution_short)} on ${esc(alum.verified_at)}</p>` : ''}
          </div>
        </div>

        <div class="row g8 wrap">
          ${learner && !isSelf ? `
            <button class="btn" onclick="window._toggleSaveProfile()">${icon('bookmark', 15)} ${alum.is_saved ? 'Saved' : 'Save'}</button>
          ` : ''}
          ${linkedin ? `<a class="btn" href="${esc(linkedin)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : ''}
          ${alum.linkedin_locked ? `<a class="btn" href="#/premium" title="Premium feature">${icon('lock', 13)} LinkedIn</a>` : ''}
        </div>
      </div>
      ${alum.headline ? `<div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)"><p style="font-size:0.95rem;color:var(--ink)">${esc(alum.headline)}</p></div>` : ''}
    </div>

    <div class="split-layout">
      <section>
        <div class="card card-pad" style="margin-bottom:20px">
          <div class="row between" style="margin-bottom:16px">
            <h3>Career journey</h3>
            <span class="tiny dim">${Math.max(0, new Date().getFullYear() - alum.graduation_year)} years after graduation</span>
          </div>
          <div class="traj">
            <div class="traj-line">
              ${steps.map(s => `
                <div class="traj-step ${s.is_current ? 'now' : ''}">
                  <span class="traj-dot"></span>
                  <div class="traj-body">
                    <div class="traj-year">${s.year}</div>
                    <div class="traj-role">${esc(s.role)}</div>
                    <div class="traj-co">${esc(s.company)}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <div class="card card-pad">
          <h3>Education</h3>
          <div class="stack g12" style="margin-top:14px">
            <div class="row g12 astart">
              <span class="dim" style="margin-top:2px">${icon('cap', 18)}</span>
              <div>
                <div style="font-weight:650">${esc(alum.degree)} in ${esc(alum.branch)}</div>
                <div class="small muted">${esc(alum.institution_name)} · Graduated ${alum.graduation_year}</div>
              </div>
            </div>
            ${alum.higher_ed ? `
              <div class="row g12 astart" style="padding-top:10px;border-top:1px solid var(--border)">
                <span class="dim" style="margin-top:2px">${icon('doc', 18)}</span>
                <div><div style="font-weight:650">${esc(alum.higher_ed)}</div><div class="tiny dim">Post-graduate study</div></div>
              </div>
            ` : ''}
          </div>
        </div>
      </section>

      <aside>
        <div class="card card-pad" style="margin-bottom:20px;${alum.is_open_to_mentoring ? 'border-color:var(--violet-line);background:var(--violet-soft)' : ''}">
          <div class="row g8" style="color:var(--violet-ink);margin-bottom:10px">${icon('spark', 18)}<h3 style="color:var(--violet-ink)">Mentorship</h3></div>
          ${mentorshipPanel(alum, isSelf)}
        </div>

        <div class="card card-pad">
          <h3 style="margin-bottom:12px">Skills</h3>
          <div class="row wrap g6">${(alum.skills || []).map(s => `<span class="chip">${esc(s)}</span>`).join('') || '<span class="tiny dim">None listed</span>'}</div>
        </div>
      </aside>
    </div>
  </div>
  `;
}
