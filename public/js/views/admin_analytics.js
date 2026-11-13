import { icon, esc } from '../icons.js';
import { api, downloadFile } from '../api.js';
import { hasInstFeature, download } from '../state.js';

const SERIES = [
  ['mentorship_requests', 'Mentorship requests', 'var(--violet)'],
  ['mentorships_accepted', 'Mentorships accepted', 'var(--good)'],
  ['messages', 'Mentorship messages', 'var(--brand)'],
  ['internship_applications', 'Internship applications', 'var(--cyan)'],
  ['event_rsvps', 'Event RSVPs', 'var(--warn)'],
  ['new_members', 'New members joined', 'var(--ink-2)']
];

const monthLabel = (m) => new Date(m + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short' });

function delta(cur, prev) {
  if (!prev && !cur) return '<span class="tiny dim">—</span>';
  if (!prev) return '<span class="tiny" style="color:var(--good)">new</span>';
  const pct = Math.round(((cur - prev) / prev) * 100);
  const tone = pct >= 0 ? 'var(--good)' : 'var(--bad)';
  return `<span class="tiny" style="color:${tone}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs previous 30 days</span>`;
}

window._downloadOwnUsage = async () => {
  try {
    await downloadFile('/api/admin/usage.csv', `usage-report-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (err) { alert(err.message); }
};

const shortDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function usageBlock(u) {
  return `
    <section class="card card-pad" style="margin-bottom:28px">
      <div class="row between wrap g8">
        <div>
          <div class="eyebrow">Usage report</div>
          <h3 style="margin-top:2px">How your community used the platform, week by week</h3>
          <p class="tiny dim">Counts only, no personal data. ${u.totals.active_users_30d} people active in the last 30 days.</p>
        </div>
        <button class="btn btn-sm" onclick="window._downloadOwnUsage()">${icon('doc', 13)} Download CSV</button>
      </div>
      <div class="table-wrap" style="margin-top:12px">
        <table>
          <thead><tr><th>Week</th><th class="num">Active people</th><th class="num">New members</th><th class="num">Mentorship requests</th><th class="num">Messages</th><th class="num">Internship applications</th><th class="num">Event RSVPs</th></tr></thead>
          <tbody>
            ${u.weeks.map(w => `<tr><td class="small">${shortDate(w.week_start)} – ${shortDate(w.week_end)}</td><td class="num small">${w.active_users}</td><td class="num small">${w.new_members}</td>
              <td class="num small">${w.mentorship_requests}</td><td class="num small">${w.messages}</td><td class="num small">${w.internship_applications}</td><td class="num small">${w.event_rsvps}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

let lastReport = null;
window._downloadValueReport = () => {
  if (lastReport) download(`value-report-${new Date().toISOString().slice(0, 10)}.json`, lastReport);
};

function valueReport(vr) {
  lastReport = vr;
  const l = vr.last_30_days;
  const healthTone = vr.health.score >= 70 ? 'var(--good)' : vr.health.score >= 45 ? 'var(--warn)' : 'var(--bad)';
  return `
    <section style="margin-bottom:32px">
      <div class="row between wrap g8" style="margin-bottom:14px">
        <div>
          <div class="eyebrow">Value report</div>
          <h2 style="margin-top:4px">What your community delivered</h2>
        </div>
        <button class="btn btn-sm" onclick="window._downloadValueReport()">${icon('doc', 13)} Download report</button>
      </div>

      <div class="split-layout" style="margin-bottom:16px">
        <div class="stat-row">
          ${[
            ['mentorships_accepted', 'Mentorships started'],
            ['messages', 'Mentorship messages'],
            ['internship_applications', 'Internship applications'],
            ['event_rsvps', 'Event RSVPs'],
            ['mentorship_requests', 'Mentorship requests'],
            ['new_members', 'New members']
          ].map(([k, label]) => `
            <div class="stat-tile">
              <div class="stat-val num">${l[k].current}</div>
              <div class="stat-lbl">${label} · last 30 days</div>
              <div style="margin-top:4px">${delta(l[k].current, l[k].previous)}</div>
            </div>
          `).join('')}
        </div>
        <aside class="card card-pad" style="text-align:center">
          <div class="eyebrow">Community health score</div>
          <div class="health-ring" style="--pct:${vr.health.score};--tone:${healthTone}"><span class="num">${vr.health.score}</span></div>
          <div class="stack g6" style="text-align:left;margin-top:10px">
            ${vr.health.components.map(c => `
              <div class="tiny"><div class="row between"><span class="muted">${esc(c.label)}</span><b class="num">${c.value}%</b></div>
                <div class="cbar-track" style="height:5px;margin-top:3px"><div class="cbar-fill" style="width:${c.value}%"></div></div></div>
            `).join('')}
          </div>
        </aside>
      </div>

      <div class="stat-row" style="margin-bottom:16px">
        <div class="stat-tile"><div class="stat-val num">${vr.community.active_members_30d}<span class="small muted"> / ${vr.community.verified_members}</span></div><div class="stat-lbl">Verified members active in last 30 days</div></div>
        <div class="stat-tile"><div class="stat-val num">${vr.responsiveness.response_rate_pct}%</div><div class="stat-lbl">Mentorship requests answered by alumni</div></div>
        <div class="stat-tile"><div class="stat-val num">${vr.responsiveness.median_response_hours ?? '—'}${vr.responsiveness.median_response_hours != null ? ' h' : ''}</div><div class="stat-lbl">Median time to a reply</div></div>
        <div class="stat-tile"><div class="stat-val num" style="color:${vr.community.stale_alumni_profiles ? 'var(--warn)' : 'var(--good)'}">${vr.community.stale_alumni_profiles}</div><div class="stat-lbl">Alumni profiles older than a year</div></div>
      </div>

      <div class="trend-grid">
        ${SERIES.map(([key, label, color]) => {
          const vals = vr.series[key];
          const max = Math.max(1, ...vals);
          return `
            <div class="card card-pad">
              <div class="row between"><h4>${esc(label)}</h4><span class="tiny dim">6 months</span></div>
              <div class="cols" role="img" aria-label="${esc(label)} per month: ${vals.join(', ')}">
                ${vals.map((v, i) => `
                  <div class="col"><span class="col-val num">${v}</span><div class="col-bar" style="height:${Math.max(2, (v / max) * 100)}%;background:${color}"></div><span class="col-lbl">${monthLabel(vr.months[i])}</span></div>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
      ${vr.community.stale_alumni_profiles ? `<p class="small muted" style="margin-top:12px">${icon('flag', 13)} Tip: post an announcement to alumni asking them to confirm their career details. It keeps your outcome data accurate for accreditation.</p>` : ''}
    </section>
  `;
}

export async function renderAdminAnalytics() {
  let analytics = { by_batch: [], by_employer: [], by_industry: [], by_location: [], mentor_by_batch: [], freshness: {} };
  let vr = null;
  let usage = null;
  try {
    [analytics, vr, usage] = await Promise.all([
      api.admin.getAnalytics(),
      hasInstFeature('value_report') ? api.admin.valueReport() : Promise.resolve(null),
      api.admin.usage()
    ]);
  } catch (err) {
    return `<div class="page"><div class="notice notice-bad row between wrap g10"><span>${icon('x', 14)} Analytics could not be loaded. ${esc(err.message)}</span>
      <button class="btn btn-sm" onclick="window.dispatchEvent(new Event('hashchange'))">Try again</button></div></div>`;
  }
  const usageHtml = usage ? usageBlock(usage) : '';
  const valueHtml = vr ? valueReport(vr) : `
    <div class="card card-pad" style="margin-bottom:28px;background:var(--violet-soft);border-color:var(--violet-line)">
      <div class="row between wrap g12">
        <div><h3 style="color:var(--violet-ink)">${icon('lock', 15)} Monthly value report</h3>
          <p class="small" style="color:var(--violet-ink);margin-top:4px">Engagement trends, response times and a community health score are included in Growth and Enterprise.</p></div>
        <a class="btn btn-violet btn-sm" href="#/admin/billing">Compare plans</a>
      </div>
    </div>`;

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
      <div class="eyebrow">Analytics & value</div>
      <h1 style="margin-top:4px">Engagement and career outcomes</h1>
      <p class="muted" style="margin-top:4px">
        Figures cover verified members of your institution only. They are computed for you and never shared with anyone else.
      </p>
    </div>

    ${usageHtml}

    ${valueHtml}

    <div class="eyebrow" style="margin-bottom:10px">Career outcomes of verified alumni</div>

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
