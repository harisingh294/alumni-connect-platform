// API client for AlumVerse

let authToken = null;
try { authToken = localStorage.getItem('acp_token'); } catch { /* storage blocked */ }

export function setToken(token) {
  authToken = token || null;
  try {
    if (token) localStorage.setItem('acp_token', token);
    else localStorage.removeItem('acp_token');
  } catch { /* storage blocked */ }
}

export function getToken() {
  return authToken;
}

async function request(endpoint, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (authToken && !headers.Authorization) headers.Authorization = `Bearer ${authToken}`;

  const opts = { ...options, headers };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }

  let res;
  try {
    res = await fetch(endpoint, opts);
  } catch {
    // Lost connection or server unreachable: say so plainly instead of a raw "Failed to fetch".
    const err = new Error(navigator.onLine === false
      ? 'You are offline. Check your internet connection — nothing was saved.'
      : 'Could not reach AlumVerse. Check your connection and try again — nothing was saved.');
    err.code = 'NETWORK';
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed with status ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
};

// Download an authenticated file (CSV) and hand it to the browser.
export async function downloadFile(endpoint, filename) {
  let res;
  try {
    res = await fetch(endpoint, { headers: authToken ? { Authorization: `Bearer ${authToken}` } : {} });
  } catch {
    throw new Error('Could not reach AlumVerse. Check your connection and try again.');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export const api = {
  auth: {
    config: () => request('/api/auth/config'),
    login: (email, password, portal) => request('/api/auth/login', { method: 'POST', body: { email, password, portal } }),
    register: (portal, payload) => request(`/api/auth/register/${portal}`, { method: 'POST', body: payload }),
    getMe: () => request('/api/auth/me'),
    demoSwitch: (persona) => request('/api/auth/demo-switch', { method: 'POST', body: { persona } })
  },
  institutions: {
    list: () => request('/api/institutions'),
    joinable: () => request('/api/institutions/joinable'),
    get: (id) => request(`/api/institutions/${encodeURIComponent(id)}`),
    register: (payload) => request('/api/auth/register/institution', { method: 'POST', body: payload })
  },
  billing: {
    plans: () => request('/api/billing/plans'),
    get: () => request('/api/billing'),
    checkout: (plan_id, billing_cycle) => request('/api/billing/checkout', { method: 'POST', body: { plan_id, billing_cycle } }),
    cancel: () => request('/api/billing/cancel', { method: 'POST' }),
    resume: () => request('/api/billing/resume', { method: 'POST' })
  },
  inst: {
    get: () => request('/api/admin/institution'),
    update: (data) => request('/api/admin/institution', { method: 'PUT', body: data }),
    settings: (data) => request('/api/admin/institution/settings', { method: 'PUT', body: data }),
    addCourse: (data) => request('/api/admin/institution/courses', { method: 'POST', body: data }),
    deleteCourse: (id) => request(`/api/admin/institution/courses/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    savePlacement: (data) => request('/api/admin/institution/placements', { method: 'POST', body: data }),
    deletePlacement: (year) => request(`/api/admin/institution/placements/${encodeURIComponent(year)}`, { method: 'DELETE' }),
    team: () => request('/api/admin/institution/team'),
    addAdmin: (data) => request('/api/admin/institution/team', { method: 'POST', body: data }),
    removeAdmin: (id) => request(`/api/admin/institution/team/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    audit: (limit = 200) => request(`/api/admin/institution/audit?limit=${limit}`),
    exportData: () => request('/api/admin/institution/export'),
    remove: (confirm_name, password) => request('/api/admin/institution/delete', { method: 'POST', body: { confirm_name, password } })
  },
  engage: {
    announcements: () => request('/api/admin/community/announcements'),
    postAnnouncement: (data) => request('/api/admin/community/announcements', { method: 'POST', body: data }),
    deleteAnnouncement: (id) => request(`/api/admin/community/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    events: () => request('/api/admin/community/events'),
    createEvent: (data) => request('/api/admin/community/events', { method: 'POST', body: data }),
    deleteEvent: (id) => request(`/api/admin/community/events/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    programs: () => request('/api/admin/community/programs'),
    program: (id) => request(`/api/admin/community/programs/${encodeURIComponent(id)}`),
    createProgram: (data) => request('/api/admin/community/programs', { method: 'POST', body: data }),
    closeProgram: (id) => request(`/api/admin/community/programs/${encodeURIComponent(id)}/close`, { method: 'POST' }),
    matchProgram: (id) => request(`/api/admin/community/programs/${encodeURIComponent(id)}/match`, { method: 'POST' }),
    mentorship: () => request('/api/admin/community/mentorship')
  },
  community: {
    feed: () => request('/api/community/feed'),
    rsvp: (id) => request(`/api/community/events/${encodeURIComponent(id)}/rsvp`, { method: 'POST' }),
    joinProgram: (id) => request(`/api/community/programs/${encodeURIComponent(id)}/join`, { method: 'POST' }),
    leaveProgram: (id) => request(`/api/community/programs/${encodeURIComponent(id)}/leave`, { method: 'POST' }),
    messages: (reqId) => request(`/api/community/conversations/${encodeURIComponent(reqId)}/messages`),
    send: (reqId, body) => request(`/api/community/conversations/${encodeURIComponent(reqId)}/messages`, { method: 'POST', body: { body } })
  },
  me: {
    updateProfile: (data) => request('/api/me/profile', { method: 'PUT', body: data }),
    changePassword: (current_password, new_password) => request('/api/me/password', { method: 'POST', body: { current_password, new_password } }),
    exportData: () => request('/api/me/export'),
    remove: (password) => request('/api/me/delete', { method: 'POST', body: { password } })
  },
  feedback: {
    send: (type, message) => request('/api/feedback', { method: 'POST', body: { type, message } }),
    mine: () => request('/api/feedback/mine')
  },
  platform: {
    usage: () => request('/api/platform/usage'),
    feedback: (includeSandbox) => request(`/api/platform/feedback${includeSandbox ? '?include_sandbox=1' : ''}`),
    logFeedback: (data) => request('/api/platform/feedback', { method: 'POST', body: data }),
    updateFeedback: (id, data) => request(`/api/platform/feedback/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    deleteFeedback: (id) => request(`/api/platform/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    resetSandbox: () => request('/api/platform/sandbox/reset', { method: 'POST' }),
    institutions: () => request('/api/platform/institutions'),
    verify: (id, verified) => request(`/api/platform/institutions/${encodeURIComponent(id)}/verify`, { method: 'POST', body: { verified } }),
    revenue: () => request('/api/platform/revenue'),
    log: () => request('/api/platform/log')
  },
  discovery: {
    getAlumni: (params = {}) => request(`/api/discovery/alumni${qs(params)}`),
    getAlumnus: (id) => request(`/api/discovery/alumni/${encodeURIComponent(id)}`)
  },
  learner: {
    toggleSave: (profId) => request(`/api/student/save/${encodeURIComponent(profId)}`, { method: 'POST' }),
    getSaved: () => request('/api/student/saved'),
    sendRequest: (alumni_id, topic, message) => request('/api/student/requests', { method: 'POST', body: { alumni_id, topic, message } }),
    getMyRequests: () => request('/api/student/requests')
  },
  subscriptions: {
    plans: () => request('/api/subscriptions/plans'),
    me: () => request('/api/subscriptions/me'),
    checkout: (plan_id) => request('/api/subscriptions/checkout', { method: 'POST', body: { plan_id } }),
    cancel: () => request('/api/subscriptions/cancel', { method: 'POST' })
  },
  internships: {
    list: () => request('/api/internships'),
    manage: () => request('/api/internships/posted'),
    posted: () => request('/api/internships/posted'),
    create: (data) => request('/api/internships', { method: 'POST', body: data }),
    close: (id) => request(`/api/internships/${encodeURIComponent(id)}/close`, { method: 'POST' }),
    apply: (id, note) => request(`/api/internships/${encodeURIComponent(id)}/apply`, { method: 'POST', body: { note } }),
    decide: (appId, status) => request(`/api/internships/applications/${encodeURIComponent(appId)}/decide`, { method: 'POST', body: { status } })
  },
  admin: {
    overview: () => request('/api/admin/overview'),
    members: (params = {}) => request(`/api/admin/members${qs(params)}`),
    updateMember: (id, data) => request(`/api/admin/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    deactivate: (id) => request(`/api/admin/members/${encodeURIComponent(id)}/deactivate`, { method: 'POST' }),
    reactivate: (id) => request(`/api/admin/members/${encodeURIComponent(id)}/reactivate`, { method: 'POST' }),
    valueReport: () => request('/api/admin/value-report'),
    usage: () => request('/api/admin/usage'),
    getMetrics: () => request('/api/admin/metrics'),
    getDirectory: (q = '', status = '') => request(`/api/admin/directory${qs({ q, status })}`),
    getVerificationQueue: () => request('/api/admin/verification-queue'),
    decideVerification: (id, decision, reject_reason) => request(`/api/admin/verification/${encodeURIComponent(id)}/decide`, {
      method: 'POST', body: { decision, reject_reason }
    }),
    uploadRosterCsv: (csv_text, record_type = 'ALUMNI') => request('/api/admin/roster/upload', { method: 'POST', body: { csv_text, record_type } }),
    getRoster: () => request('/api/admin/roster'),
    getAnalytics: () => request('/api/admin/analytics')
  },
  alumni: {
    getProfile: () => request('/api/alumni/profile'),
    updateProfile: (data) => request('/api/alumni/profile', { method: 'PUT', body: data }),
    updateMentorship: (data) => request('/api/alumni/mentorship', { method: 'PUT', body: data }),
    confirmFreshness: (location) => request('/api/alumni/confirm-freshness', { method: 'POST', body: { location } }),
    getRequests: () => request('/api/alumni/requests'),
    respondRequest: (id, status, response_note, meeting_info) => request(`/api/alumni/requests/${encodeURIComponent(id)}/respond`, {
      method: 'POST', body: { status, response_note, meeting_info }
    })
  }
};
