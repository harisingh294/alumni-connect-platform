import { api, setToken, getToken } from './api.js';

function readTheme() {
  try { return localStorage.getItem('acp_theme') || 'light'; } catch { return 'light'; }
}

export const state = {
  user: null,
  profile: null,
  subscription: null,
  institution: null,
  config: { demo_login: false },
  theme: readTheme(),
  modal: null,
  menuOpen: false
};

document.documentElement.dataset.theme = state.theme;

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) fn(state);
}

export function openModal(type, data = {}) {
  state.modal = { type, data };
  notify();
}

export function closeModal() {
  state.modal = null;
  notify();
}

// Re-render the current route (after a mutation).
export function refresh() {
  notify();
}

export function toast(message, tone = 'default') {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    wrap.className = 'toast-wrap';
    wrap.setAttribute('role', 'status');
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  if (tone === 'good') el.style.background = 'var(--good)';
  if (tone === 'bad') el.style.background = 'var(--bad)';
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    el.style.transition = 'all 0.2s';
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

export const ROLE_LABEL = {
  STUDENT: 'Current Student',
  ALUMNI: 'Alumni',
  EXTERNAL: 'Visiting Student',
  ADMIN: 'Institution Admin',
  SUPERADMIN: 'Platform Team'
};

export function homeFor(user) {
  if (!user) return '#/';
  switch (user.role) {
    case 'STUDENT': return '#/student-home';
    case 'ALUMNI': return '#/alumni-home';
    case 'EXTERNAL': return '#/external-home';
    case 'ADMIN': return '#/admin';
    case 'SUPERADMIN': return '#/platform';
    default: return '#/';
  }
}

export function applySession(res) {
  if (res.token) setToken(res.token);
  state.user = res.user || null;
  state.profile = res.profile || null;
  state.subscription = res.subscription || null;
  state.institution = res.institution || null;
}

// Institution subscription state for the signed-in member/admin.
export function instSub() {
  return state.institution?.subscription || null;
}

export function hasInstFeature(f) {
  const s = instSub();
  return Boolean(s?.active && s.features?.includes(f));
}

// Save JSON or text as a file in the browser.
export function download(filename, content, type = 'application/json') {
  const blob = new Blob([typeof content === 'string' ? content : JSON.stringify(content, null, 2)], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export async function refreshSession() {
  try {
    applySession(await api.auth.getMe());
  } catch {
    setToken(null);
    applySession({});
  }
}

// After login/signup: go to the page the user originally wanted, or their home.
export function goAfterLogin() {
  let target = null;
  try { target = sessionStorage.getItem('acp_after_login'); sessionStorage.removeItem('acp_after_login'); } catch { /* ignore */ }
  const dest = target || homeFor(state.user);
  if (location.hash === dest) notify();
  else location.hash = dest;
}

export function logout() {
  setToken(null);
  applySession({});
  state.menuOpen = false;
  toast('You have been logged out');
  if (location.hash === '#/') notify();
  else location.hash = '#/';
}

export async function initAuth() {
  try { state.config = await api.auth.config(); } catch { /* keep defaults */ }
  if (getToken()) await refreshSession();
}

export async function demoLogin(persona) {
  try {
    applySession(await api.auth.demoSwitch(persona));
    toast(`Signed in as ${state.user.full_name} (${ROLE_LABEL[state.user.role]})`, 'good');
    goAfterLogin();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  try { localStorage.setItem('acp_theme', state.theme); } catch { /* ignore */ }
  notify();
}
