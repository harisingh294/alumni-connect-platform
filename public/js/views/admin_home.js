import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, openModal } from '../state.js';

let dirSearchTimer;

export async function renderAdminHome() {
  const hash = location.hash;
  const qStr = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(qStr);
  const q = params.get('q') || '';
  const status = params.get('status') || '';

  let metrics = { total_alumni: 0, verified_alumni: 0, pending_review: 0, open_to_mentoring: 0, requests: {} };
  let queue = { pending: [], recent_decisions: [] };
  let dir = { rows: [] };

  try {
    const [mData, qData, dData] = await Promise.all([
      api.admin.getMetrics(),
      api.admin.getVerificationQueue(),
      api.admin.getDirectory(q, status)
    ]);
    metrics = mData;
    queue = qData;
    dir = dData;
  } catch (err) {
    console.error('Failed to load admin dashboard:', err);
  }

  window._onAdminDirSearch = (val) => {
    clearTimeout(dirSearchTimer);
    dirSearchTimer = setTimeout(() => {
      const p = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
      if (val) p.set('q', val.trim());
      else p.delete('q');
      location.hash = '#/admin' + (p.toString() ? '?' + p.toString() : '');
    }, 240);
  };

  window._onAdminStatusFilter = (st) => {
    const p = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
    if (st) p.set('status', st);
    else p.delete('status');
    location.hash = '#/admin' + (p.toString() ? '?' + p.toString() : '');
  };

  window._openReviewModal = (user) => {
    openModal('review_verification', user);
  };

  window._openRosterImportModal = () => {
    openModal('roster_import');
  };

  return `
  <div class="page">
    <div class="page-head">
      <div class="row between wrap g12">
        <div>
          <div class="eyebrow">Institution Admin Portal</div>
          <h1 style="margin-top:4px">Alumni Network & Verification Control</h1>
          <p class="muted" style="margin-top:4px">Manage institutional rosters, review pending claims, and observe network engagement.</p>
        </div>
        <div class="row g8">
          <button class="btn btn-primary" onclick="_openRosterImportModal()">
            ${icon('doc', 15)} Import CSV Roster
          </button>
          <a class="btn" href="#/admin-analytics">
            ${icon('chart', 15)} View Analytics
          </a>
        </div>
      </div>
    </div>

    <!-- Institutional KPI Metrics Row -->
    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile">
        <div class="stat-val font-bold num">${metrics.total_alumni}</div>
        <div class="stat-lbl">Alumni On Platform</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--good)">${metrics.verified_alumni}</div>
        <div class="stat-lbl">Verified Affiliations</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--warn)">${metrics.pending_review}</div>
        <div class="stat-lbl">Awaiting Review</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num" style="color:var(--violet)">${metrics.open_to_mentoring}</div>
        <div class="stat-lbl">Offering Mentorship</div>
      </div>
      <div class="stat-tile">
        <div class="stat-val font-bold num">${metrics.requests?.total || 0}</div>
        <div class="stat-lbl">Mentorship Inquiries (${metrics.requests?.accepted || 0} Accepted)</div>
      </div>
    </div>

    <!-- Verification Queue Section -->
    <section style="margin-bottom:36px">
      <div class="row between" style="margin-bottom:14px">
        <div>
          <h2>Verification Queue (${queue.pending.length} Pending)</h2>
          <p class="small muted">Profiles stay hidden from public search until someone at the institution verifies them.</p>
        </div>
      </div>

      ${queue.pending.length ? `
        <div class="stack g12">
          ${queue.pending.map(p => `
            <div class="card card-pad" style="border-left: 4px solid var(--warn)">
              <div class="row between astart wrap g12">
                <div>
                  <div class="row g8">
                    <span style="font-weight:700;font-size:1.05rem">${esc(p.full_name)}</span>
                    <span class="badge badge-warn">Pending Verification</span>
                  </div>
                  <div class="small muted" style="margin-top:2px">
                    ${esc(p.degree)} (${esc(p.branch)}) · Claimed Batch of <b>${p.graduation_year}</b>
                  </div>
                  <div class="row g16 wrap tiny dim" style="margin-top:8px">
                    <span>${icon('brief', 12)} ${esc(p.current_role)} at <b>${esc(p.current_company)}</b></span>
                    <span>${icon('pin', 12)} ${esc(p.location)}</span>
                    <span>${p.email}</span>
                  </div>
                </div>

                <div class="row g8">
                  <button class="btn btn-primary btn-sm" onclick='_openReviewModal(${JSON.stringify(p)})'>
                    ${icon('shield', 14)} Review Record
                  </button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="card card-pad" style="text-align:center;padding:32px">
          <div style="color:var(--good);margin-bottom:8px">${icon('check', 28)}</div>
          <h3>The verification queue is clear</h3>
          <p class="small muted" style="margin-top:4px">New submissions will appear here as graduates claim affiliation.</p>
        </div>
      `}
    </section>

    <!-- Alumni Directory Table -->
    <section style="margin-bottom:36px">
      <div class="row between wrap g12" style="margin-bottom:14px">
        <div>
          <h2>Institutional Alumni Directory</h2>
          <p class="small muted">${dir.rows.length} records matching current view.</p>
        </div>
        <div class="row g10 wrap">
          <input class="input" style="max-width:240px" value="${esc(q)}" placeholder="Search name, company, batch…" oninput="_onAdminDirSearch(this.value)">
          <select class="select" style="width:auto" onchange="_onAdminStatusFilter(this.value)">
            <option value="" ${!status ? 'selected' : ''}>All Statuses</option>
            <option value="VERIFIED" ${status === 'VERIFIED' ? 'selected' : ''}>Verified</option>
            <option value="PENDING" ${status === 'PENDING' ? 'selected' : ''}>Pending Review</option>
            <option value="REJECTED" ${status === 'REJECTED' ? 'selected' : ''}>Rejected</option>
          </select>
        </div>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Graduate Name</th>
              <th class="num">Batch</th>
              <th>Current Role & Company</th>
              <th>Location</th>
              <th>Mentoring</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${dir.rows.slice(0, 50).map(r => `
              <tr>
                <td>
                  <div style="font-weight:600">${esc(r.full_name)}</div>
                  <div class="tiny dim">${esc(r.email)}</div>
                </td>
                <td class="num">${r.graduation_year}</td>
                <td>
                  <div style="font-weight:550">${esc(r.current_role)}</div>
                  <div class="tiny dim">${esc(r.current_company)} · ${esc(r.industry)}</div>
                </td>
                <td class="small muted">${esc(r.location)}</td>
                <td>
                  ${r.is_open_to_mentoring ? `<span class="badge badge-violet">${icon('spark', 11)} Yes</span>` : '<span class="tiny dim">—</span>'}
                </td>
                <td>
                  <span class="badge ${r.verification_status === 'VERIFIED' ? 'badge-good' : r.verification_status === 'REJECTED' ? 'badge-bad' : 'badge-warn'}">
                    ${esc(r.verification_status)}
                  </span>
                </td>
                <td>
                  <div class="row g6 end">
                    ${r.verification_status === 'PENDING' ? `
                      <button class="btn btn-sm btn-primary" onclick='_openReviewModal(${JSON.stringify(r)})'>Review</button>
                    ` : ''}
                    <a class="btn btn-sm" href="#/alumni/${r.id}">View</a>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${dir.rows.length > 50 ? `<p class="tiny dim" style="margin-top:10px">Showing top 50 records. Narrow search to view more.</p>` : ''}
    </section>
  </div>
  `;
}
