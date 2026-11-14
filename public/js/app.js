import { icon, esc } from './icons.js';
import { state, subscribe, initAuth, toggleTheme, openModal, logout, homeFor, ROLE_LABEL, instSub } from './state.js';
import { renderLanding } from './views/landing.js';
import { renderPortalChooser, renderLogin, renderSignup } from './views/auth.js';
import { renderInstitutions } from './views/institutions.js';
import { renderInstitutionDetail } from './views/institution_detail.js';
import { renderAlumniDirectory } from './views/alumni_directory.js';
import { renderAlumniProfile } from './views/alumni_profile.js';
import { renderStudentHome } from './views/student_home.js';
import { renderExternalHome } from './views/external_home.js';
import { renderAlumniHome } from './views/alumni_home.js';
import { renderAdminHome } from './views/admin_home.js';
import { renderAdminAnalytics } from './views/admin_analytics.js';
import { renderAdminMembers } from './views/admin_members.js';
import { renderAdminEngagement, renderAdminMentorship } from './views/admin_engagement.js';
import { renderAdminInstitution, renderAdminTeam, renderAdminBilling, renderAdminPrivacy } from './views/admin_settings.js';
import { renderInternships } from './views/internships.js';
import { renderPremium } from './views/premium.js';
import { renderForInstitutions, renderRegisterInstitution } from './views/for_institutions.js';
import { renderTrust } from './views/trust.js';
import { renderPlatform } from './views/platform.js';
import { renderAccount } from './views/account.js';
import { renderModal } from './views/modals.js';

const ANY = ['STUDENT', 'EXTERNAL', 'ALUMNI', 'ADMIN', 'SUPERADMIN'];
const MEMBERS = ['STUDENT', 'EXTERNAL', 'ALUMNI', 'ADMIN'];
const ADMIN = ['ADMIN'];

// Route table. `roles` omitted = public. `guestOnly` = redirect signed-in users home.
const ROUTES = [
  { path: /^#\/$/, view: () => renderLanding() },
  { path: /^#\/login$/, view: () => renderPortalChooser('login'), guestOnly: true },
  { path: /^#\/login\/(student|alumni|external|admin|platform)$/, view: (m) => renderLogin(m[1]), guestOnly: true },
  { path: /^#\/signup$/, view: () => renderPortalChooser('signup'), guestOnly: true },
  { path: /^#\/signup\/(student|alumni|external)$/, view: (m) => renderSignup(m[1]), guestOnly: true },
  { path: /^#\/for-institutions$/, view: () => renderForInstitutions() },
  { path: /^#\/register-institution$/, view: () => renderRegisterInstitution(), guestOnly: true },
  { path: /^#\/trust$/, view: () => renderTrust() },
  { path: /^#\/institutions$/, view: () => renderInstitutions() },
  { path: /^#\/institutions\/([\w-]+)$/, view: (m) => renderInstitutionDetail(m[1]), roles: ANY },
  { path: /^#\/premium$/, view: () => renderPremium() },
  { path: /^#\/alumni$/, view: () => renderAlumniDirectory(), roles: MEMBERS },
  { path: /^#\/alumni\/([\w-]+)$/, view: (m) => renderAlumniProfile(m[1]), roles: MEMBERS },
  { path: /^#\/internships$/, view: () => renderInternships(), roles: MEMBERS },
  { path: /^#\/account$/, view: () => renderAccount(), roles: ANY },
  { path: /^#\/student-home$/, view: () => renderStudentHome(), roles: ['STUDENT'] },
  { path: /^#\/external-home$/, view: () => renderExternalHome(), roles: ['EXTERNAL'] },
  { path: /^#\/alumni-home$/, view: () => renderAlumniHome(), roles: ['ALUMNI'] },
  { path: /^#\/admin$/, view: () => renderAdminHome(), roles: ADMIN },
  { path: /^#\/admin\/members$/, view: () => renderAdminMembers(), roles: ADMIN },
  { path: /^#\/admin\/mentorship$/, view: () => renderAdminMentorship(), roles: ADMIN },
  { path: /^#\/admin\/engagement$/, view: () => renderAdminEngagement(), roles: ADMIN },
  { path: /^#\/admin\/institution$/, view: () => renderAdminInstitution(), roles: ADMIN },
  { path: /^#\/admin\/team$/, view: () => renderAdminTeam(), roles: ADMIN },
  { path: /^#\/admin\/billing$/, view: () => renderAdminBilling(), roles: ADMIN },
  { path: /^#\/admin\/privacy$/, view: () => renderAdminPrivacy(), roles: ADMIN },
  { path: /^#\/admin-analytics$/, view: () => renderAdminAnalytics(), roles: ADMIN },
  { path: /^#\/platform$/, view: () => renderPlatform(), roles: ['SUPERADMIN'] }
];

function navGroups(u) {
  if (!u) {
    return [['Explore', [
      ['#/', 'grid', 'Home'],
      ['#/institutions', 'building', 'Colleges'],
      ['#/premium', 'star', 'Premium for students'],
      ['#/for-institutions', 'cap', 'For institutions'],
      ['#/trust', 'shield', 'Trust & data']
    ]]];
  }
  switch (u.role) {
    case 'STUDENT':
      return [[u.institution_short, [
        ['#/student-home', 'grid', 'My Dashboard'],
        ['#/alumni', 'users', 'Alumni Mentors'],
        ['#/internships', 'brief', 'Internships'],
        ['#/institutions/' + u.institution_id, 'building', 'My Institution'],
        ['#/account', 'cog', 'Account & Privacy']
      ]]];
    case 'EXTERNAL':
      return [['Visiting student', [
        ['#/external-home', 'grid', 'My Dashboard'],
        ['#/institutions', 'building', 'Colleges & Courses'],
        ['#/alumni', 'users', 'Alumni Network'],
        ['#/internships', u.is_premium ? 'brief' : 'lock', 'Internships'],
        ['#/premium', 'star', u.is_premium ? 'My Premium' : 'Go Premium'],
        ['#/account', 'cog', 'Account & Privacy']
      ]]];
    case 'ALUMNI':
      return [[u.institution_short, [
        ['#/alumni-home', 'grid', 'Alumni Dashboard'],
        ['#/internships', 'brief', 'Post Internships'],
        ['#/alumni', 'users', 'Alumni Network'],
        ['#/institutions/' + u.institution_id, 'building', 'My Institution'],
        ['#/account', 'cog', 'Account & Privacy']
      ]]];
    case 'SUPERADMIN':
      return [['Platform', [
        ['#/platform', 'grid', 'Platform Console'],
        ['#/trust', 'shield', 'Trust & data'],
        ['#/account', 'cog', 'Account']
      ]]];
    default:
      return [
        [u.institution_short, [
          ['#/admin', 'grid', 'Overview'],
          ['#/admin/members', 'users', 'Students & Alumni'],
          ['#/admin/mentorship', 'spark', 'Mentorship'],
          ['#/internships', 'brief', 'Internships'],
          ['#/admin/engagement', 'flag', 'Announcements & Events'],
          ['#/admin-analytics', 'chart', 'Analytics & Value']
        ]],
        ['Institution', [
          ['#/admin/institution', 'building', 'Profile & Courses'],
          ['#/admin/team', 'users', 'Admin Team'],
          ['#/admin/billing', 'star', 'Plan & Billing'],
          ['#/admin/privacy', 'shield', 'Data & Privacy']
        ]]
      ];
  }
}

function currentPath() {
  return location.hash.split('?')[0] || '#/';
}

function topbar() {
  const u = state.user;
  const initials = u ? u.full_name.split(' ').map(w => w[0]).slice(0, 2).join('') : '';
  const badgeTone = !u ? '' : u.role === 'ALUMNI' ? 'badge-violet' : u.role === 'EXTERNAL' ? 'badge-warn' : u.role === 'STUDENT' ? 'badge-brand' : 'badge-good';

  return `
    <header class="topbar">
      <a class="logo" href="${u ? homeFor(u) : '#/'}" aria-label="AlumVerse home">
        <svg class="logo-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true">
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
        <span class="logo-word">AlumVerse</span>
      </a>

      <div class="grow"></div>

      ${!u ? `<a class="btn btn-ghost btn-sm hide-sm" href="#/for-institutions">For institutions</a>` : ''}
      ${u && u.role !== 'SUPERADMIN' ? `<button class="btn btn-ghost btn-sm" onclick="window._openFeedback()" title="Tell us what to improve">${icon('flag', 15)}<span class="hide-sm">Feedback</span></button>` : ''}

      <button class="btn btn-ghost btn-sm" onclick="window._toggleTheme()" title="Toggle theme" aria-label="Toggle theme">
        ${state.theme === 'dark' ? icon('sun', 16) : icon('moon', 16)}
      </button>

      ${u ? `
        ${u.role === 'EXTERNAL' && !u.is_premium ? `<a class="btn btn-sm btn-violet hide-sm" href="#/premium">${icon('star', 14)} Go Premium</a>` : ''}
        <div style="position:relative">
          <button class="btn btn-sm" onclick="window._toggleUserMenu(event)" aria-haspopup="true" aria-expanded="${state.menuOpen}">
            <span class="av av-sm" style="width:22px;height:22px;font-size:0.65rem;background:var(--brand)">${esc(initials)}</span>
            <span class="truncate hide-sm" style="max-width:140px">${esc(u.full_name)}</span>
            <span class="badge ${badgeTone}">${esc(ROLE_LABEL[u.role])}${u.is_premium ? ' · Premium' : ''}${u.admin_level === 'OWNER' ? ' · Owner' : ''}</span>
          </button>
          ${state.menuOpen ? `
            <div class="persona-menu" onclick="event.stopPropagation()">
              <div style="padding:8px 10px">
                <div style="font-weight:650">${esc(u.full_name)}</div>
                <div class="tiny dim truncate">${esc(u.email)}</div>
                ${u.institution_short ? `<div class="tiny dim">${esc(u.institution_short)}</div>` : ''}
              </div>
              <a class="persona-item" href="${homeFor(u)}">${icon('grid', 14)} <span class="small">My dashboard</span></a>
              <a class="persona-item" href="#/account">${icon('cog', 14)} <span class="small">Account & privacy</span></a>
              ${u.role === 'EXTERNAL' ? `<a class="persona-item" href="#/premium">${icon('star', 14)} <span class="small">${u.is_premium ? 'Manage Premium' : 'Upgrade to Premium'}</span></a>` : ''}
              ${u.role === 'ADMIN' ? `<a class="persona-item" href="#/admin/billing">${icon('star', 14)} <span class="small">Plan & billing</span></a>` : ''}
              <div style="border-top:1px solid var(--border);margin:6px 0"></div>
              <div class="persona-item" onclick="window._logout()">${icon('logout', 14)} <span class="small font-semibold">Log out</span></div>
            </div>
          ` : ''}
        </div>
      ` : `
        <a class="btn btn-sm btn-ghost" href="#/login">Log in</a>
        <a class="btn btn-sm btn-primary" href="#/signup">Sign up</a>
      `}
    </header>
  `;
}

function rail() {
  const u = state.user;
  const hash = currentPath();
  return `
    <nav class="rail" aria-label="Main">
      ${navGroups(u).map(([title, links]) => `
        <div class="rail-group">
          <div class="rail-title"><div class="eyebrow">${esc(title || ROLE_LABEL[u?.role] || 'Explore')}</div></div>
          ${links.map(([h, ic, lbl]) => `
            <a class="rail-link ${hash === h ? 'on' : ''}" href="${h}">${icon(ic, 17)}<span class="truncate">${esc(lbl)}</span></a>
          `).join('')}
        </div>
      `).join('')}
      ${u?.role === 'ADMIN' ? `
        <div class="rail-group" style="margin-top:auto">
          <a class="rail-link" onclick="window._openRosterImportModal()">${icon('doc', 16)} <span>Import roster</span></a>
        </div>
      ` : ''}
    </nav>
  `;
}

function mobileNav() {
  const hash = currentPath();
  const links = navGroups(state.user).flatMap(([, l]) => l);
  return `
    <nav class="mnav" aria-label="Main">
      ${links.map(([h, ic, lbl]) => `<a class="${hash === h ? 'on' : ''}" href="${h}">${icon(ic, 14)} ${esc(lbl)}</a>`).join('')}
    </nav>
  `;
}

// Subscription banners for institution admins and members.
function subscriptionBanner() {
  return [
    state.user?.is_sandbox ? `<div class="notice">${icon('shield', 14)} <span><b>Sandbox account.</b> Every institution, person and number here is fictional sample data for reviewers. Real partner data is never shown in the sandbox.</span></div>` : '',
    planBanner()
  ].join('');
}

function planBanner() {
  const u = state.user;
  const s = instSub();
  if (!u || !s || !['ADMIN', 'STUDENT', 'ALUMNI'].includes(u.role)) return '';
  if (!s.active) {
    return u.role === 'ADMIN'
      ? `<div class="notice notice-bad row between wrap g10"><span>${icon('lock', 14)} <b>Your subscription has ended.</b> Community features are paused for your students and alumni. Your data is safe and you can still export it.</span><a class="btn btn-sm btn-primary" href="#/admin/billing">Renew now</a></div>`
      : `<div class="notice notice-warn">${icon('lock', 14)} ${esc(u.institution_short)}’s platform subscription is paused, so mentorship and internships are unavailable for now. Your profile and data are safe.</div>`;
  }
  if (u.role === 'ADMIN' && s.state === 'TRIAL') {
    return `<div class="notice notice-brand row between wrap g10"><span>${icon('star', 14)} Free trial of <b>${esc(s.plan_name)}</b>: <b>${s.days_left}</b> days left.</span><a class="btn btn-sm" href="#/admin/billing">Choose a plan</a></div>`;
  }
  if (u.role === 'ADMIN' && s.state === 'CANCELLING') {
    return `<div class="notice notice-warn row between wrap g10"><span>${icon('flag', 14)} Your plan ends in ${s.days_left} days and will not renew.</span><a class="btn btn-sm" href="#/admin/billing">Manage</a></div>`;
  }
  return '';
}

function noAccessView() {
  return `
    <div class="page page-narrow">
      <div class="card card-pad" style="text-align:center;padding:44px 24px">
        <div style="color:var(--ink-3)">${icon('lock', 32)}</div>
        <h2 style="margin-top:10px">This section is not part of your workspace</h2>
        <p class="muted" style="margin-top:6px">You are signed in as ${esc(ROLE_LABEL[state.user.role])}. Each type of account has its own sections.</p>
        <a class="btn btn-primary" href="${homeFor(state.user)}" style="margin-top:16px">Go to my dashboard</a>
      </div>
    </div>
  `;
}

async function renderView() {
  const hash = currentPath();
  const u = state.user;

  for (const route of ROUTES) {
    const m = hash.match(route.path);
    if (!m) continue;
    if (route.guestOnly && u) {
      location.replace(homeFor(u));
      return null;
    }
    if (route.roles) {
      if (!u) {
        try { sessionStorage.setItem('acp_after_login', location.hash); } catch { /* ignore */ }
        location.replace('#/login');
        return null;
      }
      if (!route.roles.includes(u.role)) return noAccessView();
    }
    return await route.view(m);
  }

  return `
    <div class="page page-narrow" style="text-align:center;padding:50px 20px">
      <h2>Page not found</h2>
      <a class="btn btn-primary" href="${homeFor(u)}" style="margin-top:16px">Return home</a>
    </div>
  `;
}

let renderSeq = 0;
async function renderApp() {
  const app = document.getElementById('app');
  if (!app) return;
  const mySeq = ++renderSeq;

  let contentHtml;
  try {
    contentHtml = await renderView();
  } catch (err) {
    console.error(err);
    contentHtml = `<div class="page page-narrow"><div class="notice notice-bad">${icon('x', 14)} Something went wrong loading this page: ${esc(err.message)}</div></div>`;
  }
  if (mySeq !== renderSeq || contentHtml === null) return;

  app.innerHTML = `
    ${topbar()}
    ${mobileNav()}
    <div class="shell">
      ${rail()}
      <main class="main" id="main">
        ${subscriptionBanner() ? `<div class="page">${subscriptionBanner()}</div>` : ''}
        ${contentHtml}
      </main>
    </div>
    <div id="modal-container">${renderModal(state.modal)}</div>
  `;

  const firstField = document.querySelector('#modal-container [data-autofocus]');
  if (firstField) firstField.focus();
}

window._toggleTheme = () => toggleTheme();
window._toggleUserMenu = (e) => {
  e.stopPropagation();
  state.menuOpen = !state.menuOpen;
  renderApp();
};
window._logout = () => logout();
window._openRosterImportModal = () => openModal('roster_import');
window._openFeedback = () => openModal('feedback');

// Connection banner: updated in place so the page (and anything typed) is not re-rendered.
function updateNetBanner() {
  let el = document.getElementById('net-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'net-banner';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
  }
  el.className = navigator.onLine === false ? 'net-banner' : '';
  el.textContent = navigator.onLine === false ? 'You are offline. Changes will not be saved until your connection returns.' : '';
}
window.addEventListener('offline', updateNetBanner);
window.addEventListener('online', () => {
  updateNetBanner();
  renderApp(); // refresh data that may have failed to load
});

document.addEventListener('click', () => {
  if (state.menuOpen) {
    state.menuOpen = false;
    renderApp();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modal) window._closeModal?.();
});

subscribe(() => renderApp());
window.addEventListener('hashchange', () => {
  state.menuOpen = false;
  renderApp();
  window.scrollTo(0, 0);
});

initAuth().then(() => renderApp());
