import { icon, esc } from '../icons.js';
import { api, getToken } from '../api.js';
import { openModal, toast, refresh, download } from '../state.js';

let rowsById = new Map();
let searchTimer;

function params() {
  const p = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  return { type: p.get('type') === 'ALUMNI' ? 'ALUMNI' : 'STUDENT', status: p.get('status') || '', q: p.get('q') || '' };
}

function setParam(key, val) {
  const p = new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '');
  if (val) p.set(key, val); else p.delete(key);
  location.hash = '#/admin/members?' + p.toString();
}

window._membersTab = (t) => { const p = new URLSearchParams(); p.set('type', t); location.hash = '#/admin/members?' + p.toString(); };
window._membersStatus = (v) => setParam('status', v);
window._membersSearch = (v) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => setParam('q', v.trim()), 350); };
window._reviewMember = (id) => { const r = rowsById.get(id); if (r) openModal('review_verification', r); };
window._editMember = (id) => { const r = rowsById.get(id); if (r) openModal('edit_member', r); };
window._importRoster = (type) => openModal('roster_import', { record_type: type });

window._toggleMemberActive = async (id) => {
  const r = rowsById.get(id);
  if (!r) return;
  if (r.is_active && !confirm(`Deactivate ${r.full_name}? They will be signed out and hidden from the community until reactivated.`)) return;
  try {
    if (r.is_active) await api.admin.deactivate(id); else await api.admin.reactivate(id);
    toast(r.is_active ? 'Member deactivated' : 'Member reactivated', 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};

window._exportMembersCsv = async () => {
  try {
    const res = await fetch('/api/admin/members.csv', { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!res.ok) throw new Error('Export failed');
    download('members.csv', await res.text(), 'text/csv');
    toast('Member list exported (recorded in your audit log)', 'good');
  } catch (err) { toast(err.message, 'bad'); }
};

const lastSeen = (s) => {
  if (!s) return 'Never';
  const days = Math.floor((Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime()) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
};

export async function renderAdminMembers() {
  const { type, status, q } = params();
  let data = { rows: [] };
  try {
    data = await api.admin.members({ type, status, q });
  } catch (err) {
    return `<div class="page"><div class="notice notice-bad">${esc(err.message)}</div></div>`;
  }
  rowsById = new Map(data.rows.map(r => [r.id, r]));
  const isStudent = type === 'STUDENT';

  return `
  <div class="page">
    <div class="page-head row between wrap g12">
      <div>
        <div class="eyebrow">Member records</div>
        <h1 style="margin-top:4px">Students & alumni</h1>
        <p class="muted" style="margin-top:4px">Verify, correct and manage the records of everyone in your community.</p>
      </div>
      <div class="row g8 wrap">
        <button class="btn" onclick="window._exportMembersCsv()">${icon('doc', 15)} Export CSV</button>
        <button class="btn btn-primary" onclick="window._importRoster('${type}')">${icon('doc', 15)} Import ${isStudent ? 'student' : 'alumni'} roster</button>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button role="tab" class="tab ${isStudent ? 'on' : ''}" aria-selected="${isStudent}" onclick="window._membersTab('STUDENT')">${icon('cap', 14)} Current students</button>
      <button role="tab" class="tab ${!isStudent ? 'on' : ''}" aria-selected="${!isStudent}" onclick="window._membersTab('ALUMNI')">${icon('users', 14)} Alumni</button>
    </div>

    <div class="row g10 wrap" style="margin:14px 0">
      <input class="input" style="max-width:280px" value="${esc(q)}" placeholder="Search name, email, roll no., batch…" aria-label="Search members" oninput="window._membersSearch(this.value)">
      <select class="select" style="width:auto" aria-label="Filter by status" onchange="window._membersStatus(this.value)">
        ${[['', 'All statuses'], ['VERIFIED', 'Verified'], ['PENDING', 'Pending review'], ['REJECTED', 'Rejected'], ['DEACTIVATED', 'Deactivated']]
          .map(([v, l]) => `<option value="${v}" ${status === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="tiny dim">${data.rows.length} records${data.rows.length === 200 ? ' (first 200 — refine your search)' : ''}</span>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Name</th>
          <th>${isStudent ? 'Programme' : 'Batch & programme'}</th>
          <th>${isStudent ? 'Roll no.' : 'Current role'}</th>
          <th>Status</th>
          <th>Last active</th>
          <th class="num">Mentorships</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${data.rows.map(r => `
            <tr style="${r.is_active ? '' : 'opacity:0.6'}">
              <td><div style="font-weight:600">${esc(r.full_name)}</div><div class="tiny dim">${esc(r.email)}</div></td>
              <td class="small">${esc(r.degree)} · ${esc(r.branch)}<div class="tiny dim">${isStudent ? 'Graduating ' : 'Class of '}${esc(r.graduation_year)}</div></td>
              <td class="small">${isStudent ? esc(r.roll_number || '—') : `${esc(r.current_role || '—')}<div class="tiny dim">${esc(r.current_company || '')}</div>`}</td>
              <td>
                ${!r.is_active ? '<span class="badge">Deactivated</span>' : `<span class="badge ${r.verification_status === 'VERIFIED' ? 'badge-good' : r.verification_status === 'REJECTED' ? 'badge-bad' : 'badge-warn'}">${esc(r.verification_status)}</span>`}
              </td>
              <td class="small muted">${lastSeen(r.last_active_at)}</td>
              <td class="num small">${r.mentorship_count}</td>
              <td>
                <div class="row g6 end">
                  ${r.verification_status === 'PENDING' ? `<button class="btn btn-sm btn-primary" onclick="window._reviewMember('${esc(r.id)}')">Review</button>` : ''}
                  <button class="btn btn-sm" onclick="window._editMember('${esc(r.id)}')">Edit</button>
                  <button class="btn btn-sm btn-ghost" onclick="window._toggleMemberActive('${esc(r.id)}')">${r.is_active ? 'Deactivate' : 'Reactivate'}</button>
                </div>
              </td>
            </tr>
          `).join('') || `<tr><td colspan="7" style="text-align:center;padding:28px" class="muted">No ${isStudent ? 'students' : 'alumni'} match this view yet. Import a roster to invite your community.</td></tr>`}
        </tbody>
      </table>
    </div>
    <p class="tiny dim" style="margin-top:10px">${icon('shield', 11)} Every verification, edit, deactivation and export is recorded in your institution’s audit log.</p>
  </div>
  `;
}
