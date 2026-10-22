import { icon, esc } from '../icons.js';
import { api } from '../api.js';

export async function renderInstitutions() {
  let list = [];
  try {
    const data = await api.student.getInstitutions();
    list = data.institutions || [];
  } catch (err) {
    console.error('Failed to load institutions:', err);
  }

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Partner Network</div>
      <h1 style="margin-top:4px">Partner Institutions</h1>
      <p class="muted" style="margin-top:4px">Educational institutions maintaining verified alumni outcome registries on the platform.</p>
    </div>

    <div class="stack g16">
      ${list.map(i => `
        <div class="card card-pad card-hover" style="cursor:pointer" onclick="location.hash='#/alumni?inst=${i.id}'">
          <div class="row between astart wrap g16">
            <div class="row g16 astart">
              <div class="crest" style="background:linear-gradient(135deg, hsl(${i.hue} 60% 50%), hsl(${(i.hue + 35) % 360} 55% 40%))">
                ${esc(i.abbr)}
              </div>
              <div>
                <div class="row g10 wrap">
                  <h3>${esc(i.short_name)}</h3>
                  <span class="badge badge-brand">${esc(i.type)}</span>
                </div>
                <p class="small muted" style="margin-top:3px">${esc(i.name)} · ${esc(i.city)}, ${esc(i.state)}</p>
                <p class="small" style="margin-top:8px;max-width:70ch">${esc(i.about)}</p>

                <div class="row g20 wrap tiny dim" style="margin-top:12px">
                  <span class="row g6">${icon('users', 13)} <b class="num" style="color:var(--ink)">${i.verified_count || 0}</b> Verified Alumni</span>
                  <span class="row g6">${icon('spark', 13)} <b class="num" style="color:var(--violet)">${i.mentor_count || 0}</b> Open to Mentoring</span>
                  <span>Est. ${i.founded}</span>
                </div>
              </div>
            </div>

            <div class="row g8">
              <a class="btn btn-primary btn-sm" href="#/alumni?inst=${i.id}">
                Explore Alumni ${icon('arrow', 13)}
              </a>
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  </div>
  `;
}
