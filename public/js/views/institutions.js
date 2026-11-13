import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { state } from '../state.js';

export async function renderInstitutions() {
  let list = [];
  try {
    list = (await api.institutions.list()).institutions || [];
  } catch (err) {
    console.error('Failed to load institutions:', err);
  }
  const signedIn = Boolean(state.user);

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Partner colleges</div>
      <h1 style="margin-top:4px">Colleges on the platform</h1>
      <p class="muted" style="margin-top:4px">Courses, placement records and verified alumni outcomes for each partner college.
        ${signedIn ? '' : '<a href="#/signup">Sign up free</a> to see full details.'}</p>
    </div>

    <div class="stack g16">
      ${list.map(i => `
        <a class="card card-pad card-hover" style="display:block;color:inherit" href="#/institutions/${esc(i.id)}">
          <div class="row between astart wrap g16">
            <div class="row g16 astart">
              <div class="crest" style="background:linear-gradient(135deg, hsl(${i.hue} 60% 50%), hsl(${(i.hue + 35) % 360} 55% 40%))">${esc(i.abbr)}</div>
              <div>
                <div class="row g10 wrap">
                  <h3>${esc(i.short_name)}</h3>
                  <span class="badge badge-brand">${esc(i.type)}</span>
                </div>
                <p class="small muted" style="margin-top:3px">${esc(i.name)} · ${esc(i.city)}, ${esc(i.state)}</p>
                <p class="small" style="margin-top:8px;max-width:70ch">${esc(i.about)}</p>
                <div class="row g20 wrap tiny dim" style="margin-top:12px">
                  <span class="row g6">${icon('book', 13)} <b class="num" style="color:var(--ink)">${i.course_count || 0}</b> courses</span>
                  <span class="row g6">${icon('users', 13)} <b class="num" style="color:var(--ink)">${i.verified_count || 0}</b> verified alumni</span>
                  <span class="row g6">${icon('spark', 13)} <b class="num" style="color:var(--violet)">${i.mentor_count || 0}</b> mentoring</span>
                  <span>Est. ${i.founded}</span>
                </div>
              </div>
            </div>
            <span class="btn btn-primary btn-sm">${signedIn ? 'View college' : 'Sign up to view'} ${icon('arrow', 13)}</span>
          </div>
        </a>
      `).join('')}
    </div>
  </div>
  `;
}
