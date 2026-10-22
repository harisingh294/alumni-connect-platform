import { icon, esc } from './icons.js';
import { state, subscribe, initAuth, switchPersona, toggleTheme, openModal, closeModal } from './state.js';
import { renderLanding } from './views/landing.js';
import { renderInstitutions } from './views/institutions.js';
import { renderAlumniDirectory } from './views/alumni_directory.js';
import { renderAlumniProfile } from './views/alumni_profile.js';
import { renderStudentHome } from './views/student_home.js';
import { renderAlumniHome } from './views/alumni_home.js';
import { renderAdminHome } from './views/admin_home.js';
import { renderAdminAnalytics } from './views/admin_analytics.js';
import { renderModal } from './views/modals.js';

function topbar() {
  const u = state.user;
  const initials = u ? u.full_name.split(' ').map(w => w[0]).slice(0, 2).join('') : '?';
  const roleLabel = u ? (u.role === 'ADMIN' ? 'Institution Admin' : u.role === 'ALUMNI' ? 'Alumni' : 'Student') : 'Guest';

  return `
    <header class="topbar">
      <a class="logo" href="#/">
        <svg class="logo-mark" viewBox="0 0 48 48" fill="none">
          <g stroke="var(--brand)" stroke-width="2.8" stroke-linecap="round">
            <path d="M11 37 Q22.6 29.0 36.7 28.7"/>
            <path d="M11 37 Q17.7 24.6 30.1 17.9"/>
            <path d="M11 37 Q11.4 22.9 19.3 11.3"/>
          </g>
          <circle cx="11" cy="37" r="4.4" fill="var(--brand)"/>
          <circle cx="36.7" cy="28.7" r="3.2" fill="var(--brand)"/>
          <circle cx="30.1" cy="17.9" r="3.2" fill="var(--brand)"/>
          <circle cx="19.3" cy="11.3" r="3.4" fill="var(--cyan)"/>
        </svg>
        <span class="logo-word">Alumni Connect</span>
      </a>

      <nav class="row g6" style="margin-left:14px">
        <a class="btn btn-ghost btn-sm" href="#/alumni">Alumni Directory</a>
        <a class="btn btn-ghost btn-sm" href="#/institutions">Institutions</a>
      </nav>

      <div class="grow"></div>

      <!-- Theme Switcher -->
      <button class="btn btn-ghost btn-sm" onclick="window._toggleTheme()" title="Toggle Theme">
        ${state.theme === 'dark' ? icon('sun', 16) : icon('moon', 16)}
      </button>

      <!-- Role / Persona Quick Switcher -->
      <div style="position:relative">
        <button class="btn btn-sm" onclick="window._togglePersonaMenu(event)">
          <span class="av av-sm" style="width:20px;height:20px;font-size:0.65rem;background:var(--brand)">
            ${esc(initials)}
          </span>
          <span class="truncate" style="max-width:140px">${esc(u?.full_name || 'Sign In')}</span>
          <span class="badge ${u?.role === 'ADMIN' ? 'badge-good' : u?.role === 'ALUMNI' ? 'badge-violet' : 'badge-brand'}">
            ${esc(roleLabel)}
          </span>
        </button>

        ${state.personaMenuOpen ? `
          <div class="persona-menu" onclick="event.stopPropagation()">
            <div class="eyebrow" style="padding:6px 10px">Evaluate MVP Role Workspaces</div>

            <div class="persona-item ${u?.role === 'STUDENT' ? 'on' : ''}" onclick="window._switchPersona('student')">
              <span class="av av-sm" style="background:var(--brand)">IR</span>
              <div class="grow">
                <div style="font-weight:600;font-size:0.85rem">Ishita Rao</div>
                <div class="tiny dim">Student · Class of 2027</div>
              </div>
              ${u?.role === 'STUDENT' ? icon('check', 14) : ''}
            </div>

            <div class="persona-item ${u?.role === 'ALUMNI' ? 'on' : ''}" onclick="window._switchPersona('alumni')">
              <span class="av av-sm" style="background:var(--violet)">RD</span>
              <div class="grow">
                <div style="font-weight:600;font-size:0.85rem">Rohan Deshpande</div>
                <div class="tiny dim">Alumnus · Stripe, Class of 2016</div>
              </div>
              ${u?.role === 'ALUMNI' ? icon('check', 14) : ''}
            </div>

            <div class="persona-item ${u?.role === 'ADMIN' ? 'on' : ''}" onclick="window._switchPersona('admin')">
              <span class="av av-sm" style="background:var(--good)">PM</span>
              <div class="grow">
                <div style="font-weight:600;font-size:0.85rem">Priya Menon</div>
                <div class="tiny dim">Institution Admin · IIT Bombay</div>
              </div>
              ${u?.role === 'ADMIN' ? icon('check', 14) : ''}
            </div>

            <div style="border-top:1px solid var(--border);margin:6px 0;padding-top:6px">
              <div class="persona-item" onclick="window._openAuthModal()">
                ${icon('users', 14)} <span class="small font-semibold">Custom Sign In / Register</span>
              </div>
            </div>
          </div>
        ` : ''}
      </div>
    </header>
  `;
}

function rail() {
  const u = state.user;
  if (!u) return '';
  const hash = location.hash.split('?')[0] || '#/';

  let links = [];
  if (u.role === 'STUDENT') {
    links = [
      ['#/student-home', 'grid', 'Student Home'],
      ['#/alumni', 'users', 'Explore Alumni'],
      ['#/institutions', 'building', 'Institutions']
    ];
  } else if (u.role === 'ALUMNI') {
    links = [
      ['#/alumni-home', 'grid', 'Alumni Dashboard'],
      ['#/alumni', 'users', 'Explore Network'],
      ['#/institutions', 'building', 'Institutions']
    ];
  } else if (u.role === 'ADMIN' || u.role === 'SUPERADMIN') {
    links = [
      ['#/admin', 'grid', 'Admin Overview'],
      ['#/admin-analytics', 'chart', 'Outcome Analytics'],
      ['#/alumni', 'users', 'Network Directory'],
      ['#/institutions', 'building', 'Institutions']
    ];
  }

  return `
    <nav class="rail">
      <div class="rail-group">
        <div class="rail-title"><div class="eyebrow">${esc(u.institution_short || 'Platform')}</div></div>
        ${links.map(([h, ic, lbl]) => `
          <a class="rail-link ${hash === h ? 'on' : ''}" href="${h}">
            ${icon(ic, 17)}
            <span class="truncate">${esc(lbl)}</span>
          </a>
        `).join('')}
      </div>

      <div class="rail-group" style="margin-top:auto">
        <div class="rail-title"><div class="eyebrow">Demo Controls</div></div>
        <a class="rail-link" onclick="window._openRosterImportModal()">
          ${icon('doc', 16)} <span>Import CSV Roster</span>
        </a>
      </div>
    </nav>
  `;
}

// Router & Route Dispatcher
async function renderView() {
  const hash = location.hash.split('?')[0] || '#/';

  if (hash === '#/' || hash === '') {
    return await renderLanding();
  }
  if (hash === '#/institutions') {
    return await renderInstitutions();
  }
  if (hash === '#/alumni') {
    return await renderAlumniDirectory();
  }
  if (hash.startsWith('#/alumni/')) {
    const id = hash.replace('#/alumni/', '');
    return await renderAlumniProfile(id);
  }
  if (hash === '#/student-home') {
    return await renderStudentHome();
  }
  if (hash === '#/alumni-home') {
    return await renderAlumniHome();
  }
  if (hash === '#/admin') {
    return await renderAdminHome();
  }
  if (hash === '#/admin-analytics') {
    return await renderAdminAnalytics();
  }

  return `
    <div class="page page-narrow" style="text-align:center;padding:50px 20px">
      <h2>Page Not Found</h2>
      <a class="btn btn-primary" href="#/" style="margin-top:16px">Return Home</a>
    </div>
  `;
}

async function renderApp() {
  const app = document.getElementById('app');
  if (!app) return;

  const contentHtml = await renderView();
  const railHtml = rail();

  app.innerHTML = `
    ${topbar()}
    <div class="shell">
      ${railHtml}
      <main class="main">
        ${contentHtml}
      </main>
    </div>
    <div id="modal-container">
      ${renderModal(state.modal)}
    </div>
  `;
}

// Global window event bindings
window._toggleTheme = () => toggleTheme();
window._togglePersonaMenu = (e) => {
  e.stopPropagation();
  state.personaMenuOpen = !state.personaMenuOpen;
  renderApp();
};
window._switchPersona = (role) => switchPersona(role);
window._openAuthModal = () => {
  state.personaMenuOpen = false;
  openModal('auth');
};
window._openRosterImportModal = () => openModal('roster_import');

document.addEventListener('click', () => {
  if (state.personaMenuOpen) {
    state.personaMenuOpen = false;
    renderApp();
  }
});

// Reactivity & Hash routing
subscribe(() => renderApp());
window.addEventListener('hashchange', () => renderApp());

// Initialize application on load
initAuth().then(() => renderApp());
