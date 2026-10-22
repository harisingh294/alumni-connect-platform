import { api, setToken, getToken } from './api.js';

export const state = {
  user: null,
  profile: null,
  theme: localStorage.getItem('acp_theme') || 'light',
  modal: null,
  personaMenuOpen: false
};

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

export function toast(message, tone = 'default') {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    wrap.className = 'toast-wrap';
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

export async function initAuth() {
  if (getToken()) {
    try {
      const data = await api.auth.getMe();
      state.user = data.user;
      state.profile = data.profile;
      notify();
      return state.user;
    } catch {
      setToken(null);
      state.user = null;
      notify();
    }
  } else {
    // Default to student demo user for immediate instant exploration
    try {
      const res = await api.auth.demoSwitch('student');
      setToken(res.token);
      state.user = res.user;
      notify();
      return state.user;
    } catch (e) {
      console.error('Demo auto-auth failed:', e);
    }
  }
  return null;
}

export async function switchPersona(roleKey) {
  try {
    const res = await api.auth.demoSwitch(roleKey);
    setToken(res.token);
    state.user = res.user;
    state.personaMenuOpen = false;

    let targetHash = '#/';
    if (res.user.role === 'ADMIN') targetHash = '#/admin';
    else if (res.user.role === 'ALUMNI') targetHash = '#/alumni-home';
    else if (res.user.role === 'STUDENT') targetHash = '#/student-home';

    toast(`Viewing as ${res.user.full_name} (${res.user.role})`);

    if (location.hash === targetHash) {
      notify();
    } else {
      location.hash = targetHash;
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

export function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem('acp_theme', state.theme);
  notify();
}
