import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { openModal, state } from '../state.js';

let recordsById = new Map();

window._openReviewModal = (id) => {
  const rec = recordsById.get(id);
  if (rec) openModal('review_verification', rec);
};

export function meter(used, limit, label) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const tone = pct >= 90 ? 'var(--bad)' : pct >= 75 ? 'var(--warn)' : 'var(--brand)';
  return `
    <div>
      <div class="row between small"><span class="muted">${esc(label)}</span><b class="num">${used}${limit ? ' / ' + limit : ' (unlimited)'}</b></div>
      <div class="cbar-track" style="margin-top:6px"><div class="cbar-fill" style="width:${limit ? pct : 4}%;background:${tone}"></div></div>
    </div>
  `;
}

export async function renderAdminHome() {
  let ov;
  let queue = { pending: [] };
  try {
    [ov, queue] = await Promise.all([api.admin.overview(), api.admin.getVerificationQueue()]);
  } catch (err) {
    return `<div class="page"><div class="notice notice-bad">${esc(err.message)}</div></div>`;
  }
  recordsById = new Map(queue.pending.map(r => [r.id, r]));
  const m = ov.metrics;
  const sub = ov.subscription;
  const done = ov.checklist.filter(c => c.done).length;
  const pendingStudents = queue.pending.filter(p => p.role === 'STUDENT');
  const pendingAlumni = queue.pending.filter(p => p.role !== 'STUDENT');
  const responseRate = m.requests.total ? Math.round(((m.requests.accepted + m.requests.declined) / m.requests.total) * 100) : 0;

  const queueCard = (p) => `
    <div class="card card-pad" style="border-left:4px solid var(--warn)">
      <div class="row between astart wrap g12">
        <div>
          <div class="row g8 wrap">
            <span style="font-weight:700">${esc(p.full_name)}</span>
            <span class="badge ${p.role === 'STUDENT' ? 'badge-brand' : 'badge-violet'}">${p.role === 'STUDENT' ? 'Current student' : 'Alumni claim'}</span>
          </div>
          <div class="small muted" style="margin-top:2px">
            ${esc(p.degree)} (${esc(p.branch)}) · ${p.role === 'STUDENT' ? `Graduating ${esc(p.graduation_year)} · Roll no. ${esc(p.roll_number || '—')}` : `Claimed batch of ${esc(p.graduation_year)}`}
          </div>
          <div class="tiny dim" style="margin-top:4px">${esc(p.email)}${p.current_company ? ` · ${esc(p.current_role)} at ${esc(p.current_company)}` : ''}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="window._openReviewModal('${esc(p.id)}')">${icon('shield', 14)} Review</button>
      </div>
    </div>
  `;

  return `
  <div class="page">
    <div class="page-head row between wrap g12">
      <div>
        <div class="eyebrow">${esc(ov.institution.kind === 'SCHOOL' ? 'School' : 'College')} admin · ${esc(ov.institution.short_name)}${state.user.admin_level === 'OWNER' ? ' · Owner' : ''}</div>
        <h1 style="margin-top:4px">Welcome, ${esc(state.user.full_name.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').split(' ')[0])}</h1>
        <p class="muted" style="margin-top:4px">Your community at a glance: members, mentorship, opportunities and engagement.</p>
      </div>
      <div class="row g8 wrap">
        <button class="btn btn-primary" onclick="window._openRosterImportModal()">${icon('doc', 15)} Import roster</button>
        <a class="btn" href="#/admin-analytics">${icon('chart', 15)} Value report</a>
      </div>
    </div>

    <div class="split-layout" style="margin-bottom:24px">
      <div class="stack g16">
        <div class="stat-row stat-row-4">
          <div class="stat-tile"><div class="stat-val num" style="color:var(--brand)">${m.current_students}</div><div class="stat-lbl">Verified current students</div></div>
          <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${m.verified_alumni}</div><div class="stat-lbl">Verified alumni</div></div>
          <div class="stat-tile"><div class="stat-val num">${m.active_members_30d}</div><div class="stat-lbl">Members active in last 30 days</div></div>
          <div class="stat-tile"><div class="stat-val num" style="color:var(--warn)">${m.pending_review + m.pending_students}</div><div class="stat-lbl">Awaiting your review</div></div>
        </div>
        <div class="stat-row stat-row-4">
          <div class="stat-tile"><div class="stat-val num" style="color:var(--violet)">${m.open_to_mentoring}</div><div class="stat-lbl">Alumni offering mentorship</div></div>
          <div class="stat-tile"><div class="stat-val num">${m.requests.accepted}</div><div class="stat-lbl">Mentorships accepted (${responseRate}% of requests answered)</div></div>
          <div class="stat-tile"><div class="stat-val num">${m.internships_open}</div><div class="stat-lbl">Open internships</div></div>
          <div class="stat-tile"><div class="stat-val num">${m.roster.total ? Math.round((m.roster.claimed / m.roster.total) * 100) : 0}%</div><div class="stat-lbl">Roster claimed (${m.roster.claimed}/${m.roster.total})</div></div>
        </div>
      </div>

      <aside class="card card-pad">
        <div class="row between">
          <div>
            <div class="eyebrow">Your plan</div>
            <h3 style="margin-top:2px">${esc(sub.plan?.name || '—')} ${sub.state === 'TRIAL' ? '<span class="badge badge-brand">Trial</span>' : sub.active ? '<span class="badge badge-good">Active</span>' : '<span class="badge badge-bad">Expired</span>'}</h3>
          </div>
          <a class="btn btn-sm" href="#/admin/billing">Billing</a>
        </div>
        <p class="tiny dim" style="margin-top:4px">${sub.active ? `${sub.state === 'TRIAL' ? 'Trial ends' : sub.state === 'CANCELLING' ? 'Ends' : 'Renews'} in ${sub.days_left} days` : 'Renew to restore community features'}</p>
        <div class="stack g12" style="margin-top:14px">
          ${meter(ov.usage.members, ov.usage.member_limit, 'Verified members')}
          ${meter(ov.usage.admins, ov.usage.admin_seats, 'Admin seats')}
        </div>
      </aside>
    </div>

    ${done < ov.checklist.length ? `
      <section class="card card-pad" style="margin-bottom:24px">
        <div class="row between wrap g8">
          <h3>Get set up (${done}/${ov.checklist.length})</h3>
          <div class="cbar-track" style="width:180px"><div class="cbar-fill" style="width:${(done / ov.checklist.length) * 100}%"></div></div>
        </div>
        <div class="checklist">
          ${ov.checklist.map(c => `
            <a class="checklist-item ${c.done ? 'done' : ''}" href="${c.href}">
              <span class="check-dot">${c.done ? icon('check', 12) : ''}</span>
              <span>${esc(c.label)}</span>
            </a>
          `).join('')}
        </div>
      </section>
    ` : ''}

    <section style="margin-bottom:28px">
      <div class="row between wrap g8" style="margin-bottom:12px">
        <div>
          <h2>Verification queue (${queue.pending.length})</h2>
          <p class="small muted">Unverified alumni stay hidden. Unverified students cannot message alumni or apply to internships.</p>
        </div>
        <a class="btn btn-sm" href="#/admin/members">All members ${icon('arrow', 13)}</a>
      </div>
      ${queue.pending.length ? `
        ${pendingStudents.length ? `<h4 style="margin:8px 0">Current students (${pendingStudents.length})</h4><div class="stack g10" style="margin-bottom:16px">${pendingStudents.map(queueCard).join('')}</div>` : ''}
        ${pendingAlumni.length ? `<h4 style="margin:8px 0">Alumni claims (${pendingAlumni.length})</h4><div class="stack g10">${pendingAlumni.map(queueCard).join('')}</div>` : ''}
      ` : `
        <div class="card card-pad" style="text-align:center;padding:28px">
          <div style="color:var(--good);margin-bottom:6px">${icon('check', 26)}</div>
          <h3>The verification queue is clear</h3>
        </div>
      `}
    </section>

    <section class="quick-grid">
      <a class="card card-pad card-hover" href="#/admin/mentorship"><div style="color:var(--violet)">${icon('spark', 22)}</div><h4 style="margin-top:8px">Mentorship programs</h4><p class="tiny muted">Run structured programs and match students with alumni.</p></a>
      <a class="card card-pad card-hover" href="#/admin/engagement"><div style="color:var(--brand)">${icon('flag', 22)}</div><h4 style="margin-top:8px">Announcements & events</h4><p class="tiny muted">Keep alumni connected with meetups and updates.</p></a>
      <a class="card card-pad card-hover" href="#/internships"><div style="color:var(--good)">${icon('brief', 22)}</div><h4 style="margin-top:8px">Internship board</h4><p class="tiny muted">Post and moderate opportunities from your network.</p></a>
      <a class="card card-pad card-hover" href="#/admin/privacy"><div style="color:var(--warn)">${icon('shield', 22)}</div><h4 style="margin-top:8px">Data & privacy</h4><p class="tiny muted">Sharing controls, audit log, export and deletion.</p></a>
    </section>
  </div>
  `;
}
