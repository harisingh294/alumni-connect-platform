import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { openModal, state } from '../state.js';

export async function renderAlumniProfile(id) {
  let alum = null;
  try {
    alum = await api.student.getAlumnus(id);
  } catch (err) {
    return `
      <div class="page page-narrow">
        <div class="card card-pad" style="text-align:center;padding:48px 24px">
          <h2>Profile Not Found</h2>
          <p class="muted" style="margin-top:8px">This profile could not be loaded or may be private.</p>
          <a class="btn btn-primary" href="#/alumni" style="margin-top:16px">${icon('back', 14)} Back to Directory</a>
        </div>
      </div>
    `;
  }

  const initials = alum.full_name.split(' ').map(w => w[0]).slice(0, 2).join('');
  const hue = (alum.graduation_year * 57) % 360;
  const isSelf = state.user && state.user.id === alum.user_id;
  const isStudent = state.user && state.user.role === 'STUDENT';
  const steps = alum.career_steps || [];

  window._openMentorshipRequestModal = () => {
    if (!state.user) {
      openModal('auth');
      return;
    }
    openModal('request_mentorship', {
      alumni_id: alum.user_id,
      name: alum.full_name,
      role: alum.current_role,
      company: alum.current_company,
      topics: alum.mentorship_topics || []
    });
  };

  return `
  <div class="page">
    <a class="small font-semibold muted row g6" href="#/alumni" style="margin-bottom:18px">
      ${icon('back', 14)} Back to alumni directory
    </a>

    <!-- Profile Header Card -->
    <div class="card card-pad" style="margin-bottom:24px">
      <div class="row between astart wrap g16">
        <div class="row g20 astart wrap">
          <div class="av av-lg" style="background:linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 45) % 360} 60% 45%))">
            ${esc(initials)}
          </div>
          <div>
            <div class="row g10 wrap">
              <h1>${esc(alum.full_name)}</h1>
              <span class="badge badge-good">${icon('shield', 12)} Verified Alumnus</span>
            </div>
            <p style="font-size:1.15rem;font-weight:600;margin-top:4px">
              ${esc(alum.current_role)} at <b style="color:var(--ink)">${esc(alum.current_company)}</b>
            </p>
            <div class="row g16 wrap muted small" style="margin-top:8px">
              <span class="row g6">${icon('cap', 14)} ${esc(alum.institution_short)} · ${esc(alum.degree)} (${esc(alum.branch)}) · Class of ${alum.graduation_year}</span>
              <span class="row g6">${icon('pin', 14)} ${esc(alum.location)}</span>
              <span class="row g6">${icon('brief', 14)} ${esc(alum.industry)}</span>
            </div>
            ${alum.verified_at ? `
              <p class="tiny dim" style="margin-top:8px">
                ${icon('shield', 11)} Affiliation verified by ${esc(alum.institution_short)} on ${esc(alum.verified_at)}
              </p>
            ` : ''}
          </div>
        </div>

        <div class="row g8">
          ${alum.is_open_to_mentoring && !isSelf ? `
            <button class="btn btn-violet" onclick="_openMentorshipRequestModal()">
              ${icon('spark', 15)} Request Mentorship
            </button>
          ` : ''}
          ${alum.linkedin_url ? `
            <a class="btn" href="${esc(alum.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>
          ` : ''}
        </div>
      </div>

      ${alum.headline ? `
        <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border)">
          <p style="font-size:0.95rem;color:var(--ink)">${esc(alum.headline)}</p>
        </div>
      ` : ''}
    </div>

    <div class="dir-layout">
      <!-- Left Column: Career Journey & Education -->
      <section>
        <!-- Career Timeline -->
        <div class="card card-pad" style="margin-bottom:20px">
          <div class="row between" style="margin-bottom:16px">
            <h3>Verified Career Journey</h3>
            <span class="tiny dim">${2026 - alum.graduation_year} years post-graduation</span>
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

        <!-- Education Card -->
        <div class="card card-pad">
          <h3>Education & Academics</h3>
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
                <div>
                  <div style="font-weight:650">${esc(alum.higher_ed)}</div>
                  <div class="tiny dim">Post-graduate study</div>
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      </section>

      <!-- Right Column: Mentorship & Skills -->
      <aside>
        <!-- Mentorship Availability Card -->
        <div class="card card-pad" style="margin-bottom:20px;${alum.is_open_to_mentoring ? 'border-color:var(--violet-line);background:var(--violet-soft)' : ''}">
          <div class="row g8" style="color:var(--violet-ink);margin-bottom:10px">
            ${icon('spark', 18)}
            <h3 style="color:var(--violet-ink)">Mentorship Channel</h3>
          </div>
          ${alum.is_open_to_mentoring ? `
            <p class="small" style="color:var(--violet-ink);line-height:1.5">
              This alumnus is currently <b>open to mentoring students</b>. Contact details remain private until they review and accept your structured request.
            </p>
            <div style="margin-top:14px">
              <div class="eyebrow" style="color:var(--violet-ink);margin-bottom:8px">Topics Open to Discuss:</div>
              <div class="row wrap g6">
                ${(alum.mentorship_topics || []).map(t => `<span class="badge badge-violet">${esc(t)}</span>`).join('')}
              </div>
            </div>
            ${!isSelf ? `
              <button class="btn btn-violet btn-sm" style="width:100%;margin-top:18px" onclick="_openMentorshipRequestModal()">
                ${icon('spark', 14)} Send Structured Inquiry
              </button>
            ` : ''}
          ` : `
            <p class="small muted">This alumnus is not currently accepting mentorship inquiries.</p>
          `}
        </div>

        <!-- Skills Card -->
        <div class="card card-pad">
          <h3 style="margin-bottom:12px">Skills & Competencies</h3>
          <div class="row wrap g6">
            ${(alum.skills || []).map(s => `<span class="chip">${esc(s)}</span>`).join('')}
          </div>
        </div>
      </aside>
    </div>
  </div>
  `;
}
