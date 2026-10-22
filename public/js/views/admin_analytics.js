import { icon, esc } from '../icons.js';
import { api } from '../api.js';

export async function renderAdminAnalytics() {
  let analytics = { by_batch: [], by_employer: [], by_industry: [], by_location: [], mentor_by_batch: [], freshness: {} };
  try {
    analytics = await api.admin.getAnalytics();
  } catch (err) {
    console.error('Failed to load analytics:', err);
  }

  const f = analytics.freshness || { fresh: 0, aging: 0, stale: 0, total: 1 };
  const freshPct = Math.round(((f.fresh || 0) / Math.max(f.total || 1, 1)) * 100);

  function renderBarList(items, keyProp, countProp, isViolet = false) {
    if (!items || !items.length) return `<p class="tiny dim">No data available</p>`;
    const maxVal = Math.max(...items.map(i => i[countProp]), 1);
    return `
      <div class="stack g10">
        ${items.map(item => `
          <div class="cbar">
            <div class="cbar-lbl truncate" style="font-weight:550">${esc(item[keyProp])}</div>
            <div class="cbar-track">
              <div class="cbar-fill ${isViolet ? 'cbar-fill-violet' : ''}" style="width:${(item[countProp] / maxVal) * 100}%"></div>
            </div>
            <div class="cbar-val num font-bold">${item[countProp]}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  return `
  <div class="page">
    <div class="page-head">
      <a class="small font-semibold muted row g6" href="#/admin" style="margin-bottom:12px">
        ${icon('back', 14)} Back to Admin Dashboard
      </a>
      <div class="eyebrow">Institutional Intelligence</div>
      <h1 style="margin-top:4px">Alumni Career Outcome Analytics</h1>
      <p class="muted" style="margin-top:4px">
        Real outcome distribution across verified graduates. Unverified records are strictly excluded from these institutional figures.
      </p>
    </div>

    <!-- Freshness Panel -->
    <div class="card card-pad" style="margin-bottom:28px">
      <div class="row between wrap g12" style="margin-bottom:8px">
        <div>
          <h3>Data Freshness Index</h3>
          <p class="small muted" style="margin-top:4px">
            How recently alumni confirmed their current city and employer. Accreditation boards and prospective students depend on this metric.
          </p>
        </div>
        <div style="text-align:right">
          <div class="stat-val font-bold" style="color:${freshPct >= 60 ? 'var(--good)' : 'var(--warn)'}">${freshPct}%</div>
          <div class="stat-lbl">Confirmed within the last 12 months</div>
        </div>
      </div>

      <div class="row" style="margin-top:14px;height:12px;border-radius:6px;overflow:hidden;gap:2px;background:var(--surface-2)">
        <div style="width:${((f.fresh || 0) / f.total) * 100}%;background:var(--good);height:100%"></div>
        <div style="width:${((f.aging || 0) / f.total) * 100}%;background:var(--warn);height:100%"></div>
        <div style="width:${((f.stale || 0) / f.total) * 100}%;background:var(--bad);height:100%"></div>
      </div>

      <div class="row g20 wrap" style="margin-top:12px">
        <span class="row g6 tiny">
          <span style="width:8px;height:8px;border-radius:2px;background:var(--good)"></span>
          <span class="muted">Fresh (&lt;12 mo):</span> <b class="num">${f.fresh || 0}</b>
        </span>
        <span class="row g6 tiny">
          <span style="width:8px;height:8px;border-radius:2px;background:var(--warn)"></span>
          <span class="muted">Aging (12-24 mo):</span> <b class="num">${f.aging || 0}</b>
        </span>
        <span class="row g6 tiny">
          <span style="width:8px;height:8px;border-radius:2px;background:var(--bad)"></span>
          <span class="muted">Stale (&gt;24 mo):</span> <b class="num">${f.stale || 0}</b>
        </span>
      </div>
    </div>

    <!-- Charts 2-Column Grid -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(340px, 1fr));gap:20px;margin-bottom:28px">
      <!-- By Graduating Batch -->
      <div class="card card-pad">
        <h3 style="margin-bottom:16px">Verified Alumni by Graduating Batch</h3>
        ${renderBarList(analytics.by_batch, 'batch', 'count')}
      </div>

      <!-- Top Employers -->
      <div class="card card-pad">
        <h3 style="margin-bottom:16px">Top Verified Employers</h3>
        ${renderBarList(analytics.by_employer, 'company', 'count')}
      </div>

      <!-- Top Industries -->
      <div class="card card-pad">
        <h3 style="margin-bottom:16px">Industries Entered</h3>
        ${renderBarList(analytics.by_industry, 'industry', 'count')}
      </div>

      <!-- Top Cities -->
      <div class="card card-pad">
        <h3 style="margin-bottom:16px">Geographic Distribution (Cities)</h3>
        ${renderBarList(analytics.by_location, 'location', 'count')}
      </div>
    </div>

    <!-- Mentorship Cohort Participation -->
    <div class="card card-pad">
      <h3 style="margin-bottom:14px">Mentorship Supply by Cohort</h3>
      <p class="small muted" style="margin-bottom:16px">Which batches are most actively guiding junior students:</p>
      ${renderBarList(analytics.mentor_by_batch, 'batch', 'count', true)}
    </div>
  </div>
  `;
}
