import { icon, esc, safeUrl, inr } from '../icons.js';
import { api } from '../api.js';
import { state } from '../state.js';

const LEVEL_LABEL = { UG: 'Undergraduate', PG: 'Postgraduate', DOCTORAL: 'Doctoral', DIPLOMA: 'Diploma' };

function bars(items) {
  if (!items?.length) return '<p class="tiny dim">No data yet</p>';
  const max = Math.max(...items.map(i => i.count), 1);
  return `
    <div class="stack g10">
      ${items.map(i => `
        <div class="cbar">
          <div class="cbar-lbl truncate" title="${esc(i.label)}">${esc(i.label)}</div>
          <div class="cbar-track"><div class="cbar-fill" style="width:${(i.count / max) * 100}%"></div></div>
          <div class="cbar-val num">${i.count}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function mentorshipCta(inst) {
  const u = state.user;
  if (u.role === 'STUDENT' && u.institution_id === inst.id) {
    return `
      <div class="card card-pad" style="border-color:var(--brand-line);background:var(--brand-soft)">
        <h3 style="color:var(--brand-ink)">This is your college</h3>
        <p class="small" style="margin-top:4px;color:var(--brand-ink)">Mentorship from ${inst.mentor_count} alumni here is free for you.</p>
        <a class="btn btn-primary btn-sm" style="margin-top:12px" href="#/alumni?inst=${esc(inst.id)}&mentor_only=1">${icon('spark', 14)} Find a mentor</a>
      </div>
    `;
  }
  if (u.role === 'EXTERNAL') {
    return u.is_premium ? `
      <div class="card card-pad" style="border-color:var(--violet-line);background:var(--violet-soft)">
        <h3 style="color:var(--violet-ink)">${icon('star', 15)} Talk to alumni of ${esc(inst.short_name)}</h3>
        <p class="small" style="margin-top:4px;color:var(--violet-ink)">Your Premium plan covers mentorship from the alumni who opted in to mentor students from other colleges.</p>
        <a class="btn btn-violet btn-sm" style="margin-top:12px" href="#/alumni?inst=${esc(inst.id)}&external_only=1">${icon('spark', 14)} See available mentors</a>
      </div>
    ` : `
      <div class="card card-pad" style="border-color:var(--violet-line);background:var(--violet-soft)">
        <h3 style="color:var(--violet-ink)">${icon('lock', 15)} Want personal guidance from these alumni?</h3>
        <p class="small" style="margin-top:4px;color:var(--violet-ink)">With Premium you can ask alumni of ${esc(inst.short_name)} about admissions, courses and careers, and apply to internships they share.</p>
        <a class="btn btn-violet btn-sm" style="margin-top:12px" href="#/premium">${icon('star', 14)} Unlock with Premium</a>
      </div>
    `;
  }
  return '';
}

export async function renderInstitutionDetail(id) {
  let data;
  try {
    data = await api.institutions.get(id);
  } catch (err) {
    return `
      <div class="page page-narrow"><div class="card card-pad" style="text-align:center;padding:40px">
        <h2>College not found</h2>
        <a class="btn btn-primary" href="#/institutions" style="margin-top:14px">${icon('back', 14)} All colleges</a>
      </div></div>
    `;
  }

  const { institution: i, courses, placements, network } = data;
  const latest = placements[0];
  const website = safeUrl(i.website);

  return `
  <div class="page">
    <a class="small font-semibold muted row g6" href="#/institutions" style="margin-bottom:16px">${icon('back', 14)} All colleges</a>

    <div class="card card-pad" style="margin-bottom:20px">
      <div class="row between astart wrap g16">
        <div class="row g16 astart">
          <div class="crest" style="width:60px;height:60px;font-size:1.2rem;background:linear-gradient(135deg, hsl(${i.hue} 60% 50%), hsl(${(i.hue + 35) % 360} 55% 40%))">${esc(i.abbr)}</div>
          <div>
            <div class="row g10 wrap"><h1>${esc(i.short_name)}</h1><span class="badge badge-brand">${esc(i.type)}</span></div>
            <p class="muted small" style="margin-top:4px">${esc(i.name)} · ${esc(i.city)}, ${esc(i.state)} · Est. ${i.founded}</p>
            <p style="margin-top:10px;max-width:75ch">${esc(i.about)}</p>
          </div>
        </div>
        ${website ? `<a class="btn btn-sm" href="${esc(website)}" target="_blank" rel="noopener noreferrer">Official website ${icon('arrow', 13)}</a>` : ''}
      </div>
    </div>

    <div class="stat-row" style="margin-bottom:24px">
      <div class="stat-tile"><div class="stat-val num">${courses.length}</div><div class="stat-lbl">Courses offered</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--good)">${latest ? latest.placement_rate + '%' : '—'}</div><div class="stat-lbl">Placed in ${latest ? latest.year : '—'}</div></div>
      <div class="stat-tile"><div class="stat-val num">${latest ? '₹' + latest.median_ctc_lpa + ' L' : '—'}</div><div class="stat-lbl">Median package (${latest ? latest.year : '—'})</div></div>
      <div class="stat-tile"><div class="stat-val num" style="color:var(--violet)">${network.verified_alumni}</div><div class="stat-lbl">Verified alumni</div></div>
    </div>

    <div class="split-layout">
      <div class="stack g20">
        <section class="card card-pad">
          <div class="row between wrap g8" style="margin-bottom:12px">
            <h2>Courses</h2>
            <span class="tiny dim">Fees are indicative annual tuition</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Programme</th><th>Level</th><th class="num">Duration</th><th class="num">Seats</th><th class="num">Annual fee</th><th>Admission</th></tr></thead>
              <tbody>
                ${courses.map(c => `
                  <tr>
                    <td><div style="font-weight:600">${esc(c.name)}</div><div class="tiny dim">${esc(c.description || '')}</div></td>
                    <td class="small">${esc(LEVEL_LABEL[c.level] || c.level)}</td>
                    <td class="num small">${c.duration_years} yr</td>
                    <td class="num small">${c.seats ?? '—'}</td>
                    <td class="num small">${inr(c.annual_fee_inr)}</td>
                    <td class="small muted">${esc(c.eligibility || '')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="card card-pad">
          <h2 style="margin-bottom:12px">Placement record</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Year</th><th class="num">Placed</th><th class="num">Median</th><th class="num">Average</th><th class="num">Highest</th><th>Top recruiters</th></tr></thead>
              <tbody>
                ${placements.map(p => `
                  <tr>
                    <td class="num" style="font-weight:600">${p.year}</td>
                    <td class="num small">${p.students_placed} / ${p.students_eligible}<div class="tiny dim">${p.placement_rate}%</div></td>
                    <td class="num small">₹${p.median_ctc_lpa} L</td>
                    <td class="num small">₹${p.average_ctc_lpa} L</td>
                    <td class="num small">₹${p.highest_ctc_lpa} L</td>
                    <td class="small muted">${p.top_recruiters.map(esc).join(', ')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <p class="tiny dim" style="margin-top:8px">Packages are in lakh rupees per annum (LPA). Sample figures for the demo.</p>
        </section>
      </div>

      <aside class="stack g20">
        ${mentorshipCta(i)}

        <section class="card card-pad">
          <h3>Alumni network</h3>
          <div class="stack g8 small" style="margin-top:10px">
            <div class="row between"><span class="muted">Verified alumni</span><b class="num">${network.verified_alumni}</b></div>
            <div class="row between"><span class="muted">Mentoring own college</span><b class="num">${network.open_to_mentoring}</b></div>
            <div class="row between"><span class="muted">Mentoring other students</span><b class="num">${network.open_to_external}</b></div>
            <div class="row between"><span class="muted">Working abroad</span><b class="num">${network.abroad}</b></div>
            <div class="row between"><span class="muted">Higher studies</span><b class="num">${network.higher_studies}</b></div>
          </div>
          <a class="btn btn-sm" style="margin-top:14px;width:100%" href="#/alumni?inst=${esc(i.id)}">${icon('users', 14)} Browse alumni</a>
        </section>

        <section class="card card-pad"><h3 style="margin-bottom:12px">Where alumni work</h3>${bars(network.top_employers)}</section>
        <section class="card card-pad"><h3 style="margin-bottom:12px">Industries</h3>${bars(network.top_industries)}</section>
        <section class="card card-pad"><h3 style="margin-bottom:12px">Cities</h3>${bars(network.top_cities)}</section>
      </aside>
    </div>
  </div>
  `;
}
