import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, state } from '../state.js';

let searchTimer;
let searchSeq = 0;

function renderCards(list) {
  if (!list.length) {
    return `
      <div class="card card-pad" style="text-align:center;padding:48px 24px">
        <div style="color:var(--ink-3);margin-bottom:12px">${icon('users', 36)}</div>
        <h3>No alumni match your filters</h3>
        <p class="small muted" style="margin-top:6px">Try widening your search or removing one of the filter dimensions.</p>
        <button class="btn btn-primary" style="margin-top:16px" onclick="_clearAllAlumFilters()">Clear all filters</button>
      </div>
    `;
  }

  return `
    <div class="alum-grid">
      ${list.map(a => {
        const initials = a.full_name.split(' ').map(w => w[0]).slice(0, 2).join('');
        const hue = (a.graduation_year * 57) % 360;
        return `
          <div class="alum-card" onclick="location.hash='#/alumni/${a.user_id}'">
            <div class="row between astart">
              <div class="row g10">
                <div class="av av-md" style="background:linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 45) % 360} 60% 45%))">
                  ${esc(initials)}
                </div>
                <div>
                  <div style="font-weight:650;font-size:0.95rem">${esc(a.full_name)}</div>
                  <div class="small muted truncate" style="max-width:160px">${esc(a.current_role)}</div>
                </div>
              </div>
              <button class="btn btn-ghost btn-sm" onclick="_toggleSaveAlum(event, '${a.profile_id}')" title="Save profile">
                ${icon('bookmark', 15)}
              </button>
            </div>

            <div class="stack g6 small" style="margin-top:2px">
              <div class="row g6 muted truncate">${icon('brief', 13)} <b>${esc(a.current_company)}</b> · ${esc(a.industry)}</div>
              <div class="row g6 muted truncate">${icon('cap', 13)} ${esc(a.institution_short)} · Class of ${a.graduation_year}</div>
              <div class="row g6 muted truncate">${icon('pin', 13)} ${esc(a.location)}</div>
            </div>

            <div class="row between wrap g6" style="margin-top:auto;padding-top:10px;border-top:1px solid var(--border)">
              <span class="badge badge-good">${icon('shield', 11)} Verified</span>
              ${a.is_open_to_mentoring ? `<span class="badge badge-violet">${icon('spark', 11)} Mentors</span>` : '<span class="tiny dim">—</span>'}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderChips(filters) {
  const chips = [];
  if (filters.q) chips.push(`<span class="chip">Search: ${esc(filters.q)} <span onclick="_clearFilter('q')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.inst) chips.push(`<span class="chip">Institution: ${esc(filters.inst)} <span onclick="_clearFilter('inst')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.batch) chips.push(`<span class="chip">Batch: ${esc(filters.batch)} <span onclick="_clearFilter('batch')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.industry) chips.push(`<span class="chip">Industry: ${esc(filters.industry)} <span onclick="_clearFilter('industry')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.company) chips.push(`<span class="chip">Company: ${esc(filters.company)} <span onclick="_clearFilter('company')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.role) chips.push(`<span class="chip">Role: ${esc(filters.role)} <span onclick="_clearFilter('role')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.location) chips.push(`<span class="chip">City: ${esc(filters.location)} <span onclick="_clearFilter('location')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  if (filters.mentor_only === '1' || filters.mentor_only === 'true') {
    chips.push(`<span class="chip" style="background:var(--violet-soft);color:var(--violet-ink)">Open to Mentoring <span onclick="_clearFilter('mentor_only')" style="cursor:pointer">${icon('x', 12)}</span></span>`);
  }

  if (!chips.length) return '';
  return `<div class="row g6 wrap" style="margin-bottom:16px">${chips.join('')}</div>`;
}

function getCurrentFilters() {
  const qEl = document.getElementById('alumQ');
  const instEl = document.getElementById('filter-inst');
  const batchEl = document.getElementById('filter-batch');
  const indEl = document.getElementById('filter-industry');
  const compEl = document.getElementById('filter-company');
  const roleEl = document.getElementById('filter-role');
  const locEl = document.getElementById('filter-location');
  const mentorEl = document.getElementById('filter-mentor');

  if (qEl) {
    return {
      q: qEl.value,
      inst: instEl ? instEl.value : '',
      batch: batchEl ? batchEl.value : '',
      industry: indEl ? indEl.value : '',
      company: compEl ? compEl.value : '',
      role: roleEl ? roleEl.value : '',
      location: locEl ? locEl.value : '',
      mentor_only: mentorEl && mentorEl.checked ? '1' : ''
    };
  }

  // Fallback to URL parameters if DOM elements not yet mounted
  const hash = location.hash;
  const qStr = hash.includes('?') ? hash.split('?')[1] : '';
  const params = new URLSearchParams(qStr);
  return {
    q: params.get('q') || '',
    inst: params.get('inst') || '',
    batch: params.get('batch') || '',
    industry: params.get('industry') || '',
    company: params.get('company') || '',
    role: params.get('role') || '',
    location: params.get('location') || '',
    mentor_only: params.get('mentor_only') || ''
  };
}

async function applyDirectoryFilters() {
  const filters = getCurrentFilters();

  // Sync address bar state without triggering full-page hashchange or destroying input focus
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) sp.set(k, v);
  }
  const newHash = '#/alumni' + (sp.toString() ? '?' + sp.toString() : '');
  history.replaceState(null, '', newHash);

  const seq = ++searchSeq;
  let data;
  try {
    data = await api.student.getAlumni(filters);
  } catch (err) {
    console.error('Directory search failed:', err);
    return;
  }
  if (seq !== searchSeq) return; // Discard stale response

  const list = data.results || [];
  const activeCount = Object.entries(filters).filter(([k, v]) => v && k !== 'q').length + (filters.q ? 1 : 0);

  // Dynamically update UI containers in-place while keeping input focus intact
  const countEl = document.getElementById('alum-count-text');
  if (countEl) {
    countEl.innerHTML = `Showing <b class="num">${list.length}</b> ${list.length === 1 ? 'graduate' : 'graduates'}.`;
  }

  const clearContainer = document.getElementById('alum-clear-container');
  if (clearContainer) {
    clearContainer.innerHTML = activeCount
      ? `<a class="tiny font-semibold" style="cursor:pointer;color:var(--brand)" onclick="_clearAllAlumFilters()">Clear (${activeCount})</a>`
      : '';
  }

  const chipsContainer = document.getElementById('alum-chips-container');
  if (chipsContainer) {
    chipsContainer.innerHTML = renderChips(filters);
  }

  const resultsContainer = document.getElementById('alum-results-container');
  if (resultsContainer) {
    resultsContainer.innerHTML = renderCards(list);
  }
}

// Window global bindings for DOM event handlers
window._onAlumSearch = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    applyDirectoryFilters();
  }, 200);
};

window._onAlumSearchKeyDown = (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    applyDirectoryFilters();
  }
};

window._onAlumFilterChange = () => {
  applyDirectoryFilters();
};

window._clearFilter = (key) => {
  if (key === 'q') {
    const el = document.getElementById('alumQ');
    if (el) el.value = '';
  } else if (key === 'inst') {
    const el = document.getElementById('filter-inst');
    if (el) el.value = '';
  } else if (key === 'batch') {
    const el = document.getElementById('filter-batch');
    if (el) el.value = '';
  } else if (key === 'industry') {
    const el = document.getElementById('filter-industry');
    if (el) el.value = '';
  } else if (key === 'company') {
    const el = document.getElementById('filter-company');
    if (el) el.value = '';
  } else if (key === 'role') {
    const el = document.getElementById('filter-role');
    if (el) el.value = '';
  } else if (key === 'location') {
    const el = document.getElementById('filter-location');
    if (el) el.value = '';
  } else if (key === 'mentor_only') {
    const el = document.getElementById('filter-mentor');
    if (el) el.checked = false;
  }
  applyDirectoryFilters();
};

window._clearAllAlumFilters = () => {
  const qEl = document.getElementById('alumQ');
  if (qEl) qEl.value = '';
  const instEl = document.getElementById('filter-inst');
  if (instEl) instEl.value = '';
  const batchEl = document.getElementById('filter-batch');
  if (batchEl) batchEl.value = '';
  const indEl = document.getElementById('filter-industry');
  if (indEl) indEl.value = '';
  const compEl = document.getElementById('filter-company');
  if (compEl) compEl.value = '';
  const roleEl = document.getElementById('filter-role');
  if (roleEl) roleEl.value = '';
  const locEl = document.getElementById('filter-location');
  if (locEl) locEl.value = '';
  const mentorEl = document.getElementById('filter-mentor');
  if (mentorEl) mentorEl.checked = false;
  applyDirectoryFilters();
};

window._toggleSaveAlum = async (e, profId) => {
  e.stopPropagation();
  try {
    const res = await api.student.toggleSave(profId);
    toast(res.message, res.saved ? 'good' : 'default');
  } catch (err) {
    toast(err.message, 'bad');
  }
};

export async function renderAlumniDirectory() {
  const filters = getCurrentFilters();

  let data = { results: [], total: 0, filter_options: {} };
  try {
    data = await api.student.getAlumni(filters);
  } catch (err) {
    console.error('Failed to load directory:', err);
  }

  const list = data.results || [];
  const opts = data.filter_options || {};
  const activeCount = Object.entries(filters).filter(([k, v]) => v && k !== 'q').length + (filters.q ? 1 : 0);

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Discovery Engine</div>
      <h1 style="margin-top:6px">Verified Alumni Directory</h1>
      <p class="muted" style="margin-top:4px" id="alum-count-text">
        Only institution-verified, active profiles are discoverable here. Showing <b class="num">${list.length}</b> ${list.length === 1 ? 'graduate' : 'graduates'}.
      </p>
    </div>

    <div class="dir-layout">
      <!-- 7-Dimension Filters Sidebar -->
      <aside>
        <div class="card card-pad">
          <div class="row between" style="margin-bottom:14px">
            <div class="eyebrow">Filter Dimensions</div>
            <div id="alum-clear-container">
              ${activeCount ? `<a class="tiny font-semibold" style="cursor:pointer;color:var(--brand)" onclick="_clearAllAlumFilters()">Clear (${activeCount})</a>` : ''}
            </div>
          </div>

          <div class="stack g12">
            <!-- Keyword search -->
            <div>
              <label class="label">Keyword</label>
              <input
                id="alumQ"
                class="input"
                value="${esc(filters.q)}"
                placeholder="Search name, company, skill…"
                oninput="_onAlumSearch()"
                onkeydown="_onAlumSearchKeyDown(event)"
                autocomplete="off"
              >
            </div>

            <!-- 1. Institution -->
            <div>
              <label class="label">Institution</label>
              <select class="select" id="filter-inst" onchange="_onAlumFilterChange()">
                <option value="">All Institutions</option>
                ${(opts.institutions || []).map(i => `<option value="${i.id}" ${filters.inst === i.id ? 'selected' : ''}>${esc(i.short_name)}</option>`).join('')}
              </select>
            </div>

            <!-- 2. Batch / Year -->
            <div>
              <label class="label">Graduating Batch</label>
              <select class="select" id="filter-batch" onchange="_onAlumFilterChange()">
                <option value="">All Batches</option>
                ${(opts.batches || []).map(b => `<option value="${b}" ${filters.batch == b ? 'selected' : ''}>Class of ${b}</option>`).join('')}
              </select>
            </div>

            <!-- 3. Industry -->
            <div>
              <label class="label">Industry</label>
              <select class="select" id="filter-industry" onchange="_onAlumFilterChange()">
                <option value="">All Industries</option>
                ${(opts.industries || []).map(ind => `<option value="${esc(ind)}" ${filters.industry === ind ? 'selected' : ''}>${esc(ind)}</option>`).join('')}
              </select>
            </div>

            <!-- 4. Company -->
            <div>
              <label class="label">Company</label>
              <select class="select" id="filter-company" onchange="_onAlumFilterChange()">
                <option value="">All Companies</option>
                ${(opts.companies || []).map(c => `<option value="${esc(c)}" ${filters.company === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              </select>
            </div>

            <!-- 5. Job Role -->
            <div>
              <label class="label">Job Role</label>
              <select class="select" id="filter-role" onchange="_onAlumFilterChange()">
                <option value="">All Roles</option>
                ${(opts.roles || []).map(r => `<option value="${esc(r)}" ${filters.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
              </select>
            </div>

            <!-- 6. Location -->
            <div>
              <label class="label">Location</label>
              <select class="select" id="filter-location" onchange="_onAlumFilterChange()">
                <option value="">All Locations</option>
                ${(opts.locations || []).map(loc => `<option value="${esc(loc)}" ${filters.location === loc ? 'selected' : ''}>${esc(loc)}</option>`).join('')}
              </select>
            </div>

            <!-- 7. Mentorship Availability Switch -->
            <label class="row g8" style="cursor:pointer;padding-top:6px;border-top:1px solid var(--border)">
              <input type="checkbox" id="filter-mentor" ${filters.mentor_only === '1' || filters.mentor_only === 'true' ? 'checked' : ''} onchange="_onAlumFilterChange()">
              <span class="small font-semibold">Open to Mentoring only</span>
            </label>
          </div>
        </div>
      </aside>

      <!-- Main Directory Content -->
      <section>
        <div id="alum-chips-container">
          ${renderChips(filters)}
        </div>

        <div id="alum-results-container">
          ${renderCards(list)}
        </div>
      </section>
    </div>
  </div>
  `;
}
