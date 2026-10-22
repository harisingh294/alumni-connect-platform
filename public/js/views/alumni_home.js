import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, openModal, state } from '../state.js';

export async function renderAlumniHome() {
  let profile = null;
  let requests = [];

  try {
    const [pData, rData] = await Promise.all([
      api.alumni.getProfile(),
      api.alumni.getRequests()
    ]);
    profile = pData;
    requests = rData.requests || [];
  } catch (err) {
    console.error('Failed to load alumni dashboard:', err);
  }

  if (!profile) {
    return `<div class="page"><p class="muted">Could not load alumni profile.</p></div>`;
  }

  const pendingRequests = requests.filter(r => r.status === 'PENDING');
  const acceptedRequests = requests.filter(r => r.status === 'ACCEPTED');

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
      toast('Profile updated successfully', 'good');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  window._toggleAlumniMentorship = async (checked) => {
    try {
      await api.alumni.updateMentorship(checked, profile.mentorship_topics || []);
      toast(`Mentorship availability set to ${checked ? 'ON' : 'OFF'}`, 'good');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  window._toggleAlumniTopic = async (topic) => {
    const current = [...(profile.mentorship_topics || [])];
    const idx = current.indexOf(topic);
    if (idx > -1) current.splice(idx, 1);
    else current.push(topic);

    try {
      await api.alumni.updateMentorship(profile.is_open_to_mentoring, current);
      toast('Mentorship topics updated', 'good');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  window._confirmAlumniFreshness = async () => {
    try {
      await api.alumni.confirmFreshness(profile.location);
      toast('Career details confirmed as fresh!', 'good');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  window._openAcceptModal = (reqId, studentName) => {
    openModal('accept_mentorship', { request_id: reqId, student_name: studentName });
  };

  window._declineRequest = async (reqId) => {
    const reason = prompt('Optional reason for declining (e.g. traveling, busy with launch):');
    try {
      await api.alumni.respondRequest(reqId, 'DECLINED', reason || 'Unable to take mentorship session at this time.', null);
      toast('Request declined', 'default');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Alumni Workspace</div>
      <h1 style="margin-top:4px">Welcome back, ${esc(profile.full_name)}</h1>
      <p class="muted" style="margin-top:4px">
        ${esc(profile.institution_short)} · Class of ${profile.graduation_year} ·
        <span class="badge badge-good" style="vertical-align:middle">${icon('shield', 11)} Verified</span>
      </p>
    </div>

    <!-- Metrics Row -->
    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--warn)">${pendingRequests.length}</div>
        <div class="stat-lbl">Requests Awaiting You</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--good)">${acceptedRequests.length}</div>
        <div class="stat-lbl">Students Guided</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--violet)">${profile.is_open_to_mentoring ? 'Active' : 'Paused'}</div>
        <div class="stat-lbl">Mentorship Status</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num">${profile.stale_months === 0 ? 'Today' : profile.stale_months + ' mo ago'}</div>
        <div class="stat-lbl">Last Data Confirmation</div>
      </div>
    </div>

    <!-- Data Freshness Banner -->
    ${profile.stale_months >= 12 ? `
      <div class="card card-pad" style="margin-bottom:24px;border-color:var(--warn-line);background:var(--warn-soft)">
        <div class="row between wrap g12">
          <div>
            <div class="row g8" style="color:var(--warn)">
              ${icon('pin', 18)}
              <h3 style="color:var(--warn)">Confirm Your Career Details</h3>
            </div>
            <p class="small" style="margin-top:6px;color:var(--warn)">
              You last confirmed your location and role ${profile.stale_months} months ago. Students read this to guide their careers — one tap keeps your institution's records honest.
            </p>
          </div>
          <button class="btn btn-primary" onclick="_confirmAlumniFreshness()">
            ${icon('check', 15)} Still Correct in ${esc(profile.location)}
          </button>
        </div>
      </div>
    ` : ''}

    <div class="dir-layout">
      <!-- Left Column: Inbound Requests Inbox -->
      <section>
        <div class="row between" style="margin-bottom:14px">
          <h2>Mentorship Inquiries (${pendingRequests.length} Pending)</h2>
          <span class="tiny dim">Private handshake channel</span>
        </div>

        ${requests.length ? `
          <div class="stack g12" style="margin-bottom:32px">
            ${requests.map(r => {
              const tone = r.status === 'ACCEPTED' ? 'badge-good' : r.status === 'DECLINED' ? 'badge-bad' : 'badge-warn';
              return `
                <div class="card card-pad">
                  <div class="row between astart wrap g8">
                    <div>
                      <div class="row g8">
                        <span style="font-weight:700;font-size:1.02rem">${esc(r.student_name)}</span>
                        <span class="badge ${tone}">${esc(r.status)}</span>
                      </div>
                      <div class="small muted">${esc(r.student_institution)} · Class of ${r.student_batch} (${esc(r.student_branch)})</div>
                    </div>
                    <div class="row g6 wrap">
                      <span class="badge badge-violet">${esc(r.topic)}</span>
                      <span class="tiny dim num">${new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div style="margin-top:12px;background:var(--surface-2);padding:12px 14px;border-radius:var(--r-md);font-size:0.88rem">
                    <p style="color:var(--ink)">“${esc(r.message)}”</p>
                  </div>

                  ${r.status === 'PENDING' ? `
                    <div class="row g8" style="margin-top:14px">
                      <button class="btn btn-primary btn-sm" onclick="_openAcceptModal('${r.id}', '${esc(r.student_name)}')">
                        ${icon('check', 14)} Accept & Share Meeting Info
                      </button>
                      <button class="btn btn-sm" onclick="_declineRequest('${r.id}')">
                        Decline
                      </button>
                    </div>
                  ` : r.status === 'ACCEPTED' ? `
                    <div class="small" style="margin-top:12px;color:var(--good)">
                      ${icon('check', 14)} <b>Channel Opened:</b> Shared “${esc(r.meeting_info)}”
                    </div>
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

        <!-- Career Profile Editor -->
        <div class="card card-pad">
          <h2 style="margin-bottom:18px">Edit Career Profile</h2>
          <form onsubmit="_saveAlumniProfile(event)" class="stack g14">
            <div class="row g12 wrap">
              <div class="grow" style="min-width:200px">
                <label class="label">Current Employer / Company</label>
                <input class="input" name="company" value="${esc(profile.current_company)}" required>
              </div>
              <div class="grow" style="min-width:200px">
                <label class="label">Job Title / Role</label>
                <input class="input" name="role" value="${esc(profile.current_role)}" required>
              </div>
            </div>

            <div class="row g12 wrap">
              <div class="grow" style="min-width:200px">
                <label class="label">Industry</label>
                <select class="select" name="industry">
                  ${['Software & Internet', 'Fintech', 'Consulting', 'Financial Services', 'Semiconductors', 'E-commerce & Retail', 'Consumer Internet', 'Manufacturing', 'IT Services'].map(ind => `
                    <option value="${ind}" ${profile.industry === ind ? 'selected' : ''}>${ind}</option>
                  `).join('')}
                </select>
              </div>
              <div class="grow" style="min-width:200px">
                <label class="label">Location / City</label>
                <input class="input" name="location" value="${esc(profile.location)}" required>
              </div>
            </div>

            <div>
              <label class="label">Headline</label>
              <input class="input" name="headline" value="${esc(profile.headline || '')}" placeholder="e.g. Staff Engineer at Stripe. Former Razorpay and Amazon.">
            </div>

            <div>
              <label class="label">Bio</label>
              <textarea class="input" name="bio" rows="3">${esc(profile.bio || '')}</textarea>
            </div>

            <div class="row g12 wrap">
              <div class="grow" style="min-width:200px">
                <label class="label">LinkedIn Profile URL</label>
                <input class="input" name="linkedin" value="${esc(profile.linkedin_url || '')}">
              </div>
              <div class="grow" style="min-width:200px">
                <label class="label">Skills (comma separated)</label>
                <input class="input" name="skills" value="${esc((profile.skills || []).join(', '))}">
              </div>
            </div>

            <div>
              <label class="label">Profile Visibility</label>
              <select class="select" name="visibility">
                <option value="PUBLIC" ${profile.visibility === 'PUBLIC' ? 'selected' : ''}>Public (Discoverable by prospective & enrolled students)</option>
                <option value="STUDENTS_ONLY" ${profile.visibility === 'STUDENTS_ONLY' ? 'selected' : ''}>Students Only (Enrolled students of institution only)</option>
                <option value="HIDDEN" ${profile.visibility === 'HIDDEN' ? 'selected' : ''}>Hidden (Removed from directory, counted only in aggregates)</option>
              </select>
            </div>

            <button type="submit" class="btn btn-primary" style="margin-top:10px;align-self:flex-start">
              ${icon('check', 15)} Save Profile Details
            </button>
          </form>
        </div>
      </section>

      <!-- Right Column: Mentorship Availability & Topics -->
      <aside>
        <div class="card card-pad" style="border-color:var(--violet-line)">
          <div class="row between wrap g8" style="margin-bottom:14px">
            <div>
              <div class="row g8" style="color:var(--violet)">
                ${icon('spark', 18)}
                <h3>Mentorship Controls</h3>
              </div>
              <p class="small muted" style="margin-top:4px">Choose whether students can reach you.</p>
            </div>
            <label class="row g8" style="cursor:pointer">
              <input type="checkbox" ${profile.is_open_to_mentoring ? 'checked' : ''} onchange="_toggleAlumniMentorship(this.checked)">
              <span class="small font-semibold">${profile.is_open_to_mentoring ? 'Accepting' : 'Paused'}</span>
            </label>
          </div>

          ${profile.is_open_to_mentoring ? `
            <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
              <label class="label">Topics You Are Open to Discuss</label>
              <p class="tiny dim" style="margin-bottom:10px">Click topics to toggle on/off:</p>
              <div class="row wrap g6">
                ${[
                  'Resume Review',
                  'Career Guidance',
                  'Mock Interview',
                  'Career transitions',
                  'Placement preparation',
                  'Higher studies abroad'
                ].map(t => {
                  const on = (profile.mentorship_topics || []).includes(t);
                  return `
                    <span class="chip" style="cursor:pointer;${on ? 'background:var(--violet-soft);border-color:var(--violet-line);color:var(--violet-ink);font-weight:600' : ''}" onclick="_toggleAlumniTopic('${esc(t)}')">
                      ${on ? icon('check', 12) : ''} ${esc(t)}
                    </span>
                  `;
                }).join('')}
              </div>
            </div>
          ` : `
            <p class="small dim" style="margin-top:10px">Turn on availability to allow verified students from your institution to contact you.</p>
          `}
        </div>
      </aside>
    </div>
  </div>
  `;
}
