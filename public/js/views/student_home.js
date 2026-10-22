import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, state } from '../state.js';

export async function renderStudentHome() {
  let myRequests = [];
  let savedAlumni = [];
  let suggestions = [];

  try {
    const [reqData, savedData, alumData] = await Promise.all([
      api.student.getMyRequests(),
      api.student.getSaved(),
      api.student.getAlumni({ mentor_only: '1' })
    ]);
    myRequests = reqData.requests || [];
    savedAlumni = savedData.saved || [];
    suggestions = (alumData.results || []).slice(0, 3);
  } catch (err) {
    console.error('Failed to load student dashboard:', err);
  }

  const pendingCount = myRequests.filter(r => r.status === 'PENDING').length;
  const acceptedCount = myRequests.filter(r => r.status === 'ACCEPTED').length;

  window._toggleSaveStudentHome = async (profId) => {
    try {
      await api.student.toggleSave(profId);
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Student Workspace</div>
      <h1 style="margin-top:4px">Welcome back, ${esc(state.user?.full_name || 'Student')}</h1>
      <p class="muted" style="margin-top:4px">Discover verified career trajectories and connect with alumni mentors from your institution.</p>
    </div>

    <!-- KPI Metrics Tiles -->
    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--brand)">${savedAlumni.length}</div>
        <div class="stat-lbl">Saved Alumni Profiles</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--warn)">${pendingCount}</div>
        <div class="stat-lbl">Requests Awaiting Reply</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--good)">${acceptedCount}</div>
        <div class="stat-lbl">Mentors Connected</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num">${myRequests.length}</div>
        <div class="stat-lbl">Total Inquiries Sent</div>
      </div>
    </div>

    <!-- Quick Action Banner -->
    <div class="card card-pad" style="margin-bottom:28px">
      <h3>Explore Verified Paths</h3>
      <p class="small muted" style="margin-top:4px">Search alumni working in consulting, fintech, software infrastructure, or working abroad.</p>
      <div class="row g10 wrap" style="margin-top:14px">
        <a class="btn btn-primary" href="#/alumni?mentor_only=1">${icon('spark', 15)} Find Open Mentors</a>
        <a class="btn" href="#/alumni?industry=Fintech">Alumni in Fintech</a>
        <a class="btn" href="#/alumni?location=San%20Francisco%20Bay%20Area">Alumni Abroad</a>
        <a class="btn" href="#/institutions">${icon('building', 15)} Browse Institutions</a>
      </div>
    </div>

    <!-- Sent Mentorship Requests Section -->
    <section style="margin-bottom:32px">
      <div class="row between" style="margin-bottom:14px">
        <h2>My Mentorship Requests</h2>
        <span class="tiny dim">${myRequests.length} requests on record</span>
      </div>

      ${myRequests.length ? `
        <div class="stack g12">
          ${myRequests.map(r => {
            const tone = r.status === 'ACCEPTED' ? 'badge-good' : r.status === 'DECLINED' ? 'badge-bad' : 'badge-warn';
            return `
              <div class="card card-pad" style="border-left: 4px solid var(--${r.status === 'ACCEPTED' ? 'good' : r.status === 'DECLINED' ? 'bad' : 'warn'})">
                <div class="row between astart wrap g12">
                  <div>
                    <div class="row g8">
                      <a href="#/alumni/${r.alumni_user_id}" style="font-weight:700;font-size:1.05rem;color:var(--ink)">
                        ${esc(r.alumni_name)}
                      </a>
                      <span class="badge ${tone}">${esc(r.status)}</span>
                    </div>
                    <div class="small muted" style="margin-top:2px">
                      ${esc(r.alumni_role)} at <b>${esc(r.alumni_company)}</b> · ${esc(r.alumni_institution)} Class of ${r.alumni_batch}
                    </div>
                  </div>
                  <div class="row g8 wrap">
                    <span class="badge badge-violet">${esc(r.topic)}</span>
                    <span class="tiny dim num">${new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                <div style="margin-top:12px;background:var(--surface-2);padding:12px 14px;border-radius:var(--r-md);font-size:0.88rem">
                  <span class="dim font-semibold">Your Message:</span>
                  <p style="margin-top:4px;color:var(--ink)">“${esc(r.message)}”</p>
                </div>

                ${r.status === 'ACCEPTED' ? `
                  <!-- Unlocked Meeting Coordinates Card -->
                  <div class="card card-pad" style="margin-top:14px;background:var(--good-soft);border-color:var(--good-line)">
                    <div class="row g8" style="color:var(--good);margin-bottom:6px">
                      ${icon('spark', 16)}
                      <h4 style="color:var(--good)">Request Accepted · Channel Unlocked</h4>
                    </div>
                    ${r.response_note ? `<p class="small" style="color:var(--good);margin-bottom:8px"><b>Alumnus Note:</b> ${esc(r.response_note)}</p>` : ''}
                    <div style="background:var(--surface);padding:10px 14px;border-radius:var(--r-sm);border:1px solid var(--good-line)">
                      <div class="eyebrow" style="color:var(--good);margin-bottom:4px">Meeting / Contact Details:</div>
                      <div style="font-weight:600;color:var(--ink);word-break:break-all">${esc(r.meeting_info)}</div>
                    </div>
                  </div>
                ` : r.status === 'DECLINED' ? `
                  <div style="margin-top:10px;font-size:0.84rem;color:var(--bad)">
                    ${icon('x', 13)} Request was declined. ${r.response_note ? `Reason: “${esc(r.response_note)}”` : ''}
                  </div>
                ` : `
                  <p class="tiny dim" style="margin-top:10px">
                    ${icon('inbox', 12)} Awaiting response from alumnus. Contact details are revealed once accepted.
                  </p>
                `}
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div class="card card-pad" style="text-align:center;padding:36px">
          <p class="muted">You have not sent any mentorship requests yet.</p>
          <a class="btn btn-primary btn-sm" href="#/alumni?mentor_only=1" style="margin-top:12px">Explore Mentors</a>
        </div>
      `}
    </section>

    <!-- Saved Alumni Profiles Section -->
    <section style="margin-bottom:32px">
      <h2 style="margin-bottom:14px">Saved Profiles (${savedAlumni.length})</h2>
      ${savedAlumni.length ? `
        <div class="alum-grid">
          ${savedAlumni.map(s => `
            <div class="alum-card" onclick="location.hash='#/alumni/${s.user_id}'">
              <div class="row between">
                <div style="font-weight:650">${esc(s.full_name)}</div>
                <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();_toggleSaveStudentHome('${s.id}')" title="Remove">
                  ${icon('x', 14)}
                </button>
              </div>
              <div class="small muted">${esc(s.current_role)} at <b>${esc(s.current_company)}</b></div>
              <div class="tiny dim">${esc(s.institution_short)} · Class of ${s.graduation_year}</div>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="card card-pad" style="text-align:center;padding:24px">
          <p class="small muted">Bookmark alumni whose career journeys you wish to track.</p>
        </div>
      `}
    </section>

    <!-- Suggested Mentors Section -->
    <section>
      <h2 style="margin-bottom:14px">Mentors You Could Ask This Week</h2>
      <div class="alum-grid">
        ${suggestions.map(a => `
          <div class="alum-card" onclick="location.hash='#/alumni/${a.user_id}'">
            <div style="font-weight:650">${esc(a.full_name)}</div>
            <div class="small muted">${esc(a.current_role)} at <b>${esc(a.current_company)}</b></div>
            <div class="row wrap g6" style="margin-top:8px">
              ${(a.mentorship_topics || []).map(t => `<span class="badge badge-violet">${esc(t)}</span>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  </div>
  `;
}
