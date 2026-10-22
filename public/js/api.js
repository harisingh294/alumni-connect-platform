// API Client for Alumni Connect Platform MVP

let authToken = localStorage.getItem('acp_token') || null;

export function setToken(token) {
  authToken = token;
  if (token) localStorage.setItem('acp_token', token);
  else localStorage.removeItem('acp_token');
}

export function getToken() {
  return authToken;
}

async function request(endpoint, options = {}) {
  const headers = options.headers || {};
  if (authToken && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  options.headers = headers;
  const res = await fetch(endpoint, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }
  return data;
}

export const api = {
  auth: {
    login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
    register: (payload) => request('/api/auth/register', { method: 'POST', body: payload }),
    getMe: () => request('/api/auth/me'),
    demoSwitch: (persona) => request('/api/auth/demo-switch', { method: 'POST', body: { persona } })
  },
  admin: {
    getMetrics: () => request('/api/admin/metrics'),
    getDirectory: (q = '', status = '') => request(`/api/admin/directory?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`),
    getVerificationQueue: () => request('/api/admin/verification-queue'),
    decideVerification: (id, decision, reject_reason) => request(`/api/admin/verification/${id}/decide`, {
      method: 'POST',
      body: { decision, reject_reason }
    }),
    uploadRosterCsv: (csv_text) => request('/api/admin/roster/upload', {
      method: 'POST',
      body: { csv_text }
    }),
    getRoster: () => request('/api/admin/roster'),
    getAnalytics: () => request('/api/admin/analytics')
  },
  alumni: {
    getProfile: () => request('/api/alumni/profile'),
    updateProfile: (data) => request('/api/alumni/profile', { method: 'PUT', body: data }),
    updateMentorship: (is_open_to_mentoring, mentorship_topics) => request('/api/alumni/mentorship', {
      method: 'PUT',
      body: { is_open_to_mentoring, mentorship_topics }
    }),
    confirmFreshness: (location) => request('/api/alumni/confirm-freshness', { method: 'POST', body: { location } }),
    getRequests: () => request('/api/alumni/requests'),
    respondRequest: (id, status, response_note, meeting_info) => request(`/api/alumni/requests/${id}/respond`, {
      method: 'POST',
      body: { status, response_note, meeting_info }
    })
  },
  student: {
    getAlumni: (params = {}) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v) sp.set(k, v);
      }
      return request(`/api/discovery/alumni?${sp.toString()}`);
    },
    getAlumnus: (id) => request(`/api/discovery/alumni/${id}`),
    getInstitutions: () => request('/api/discovery/institutions'),
    toggleSave: (profId) => request(`/api/student/save/${profId}`, { method: 'POST' }),
    getSaved: () => request('/api/student/saved'),
    sendRequest: (alumni_id, topic, message) => request('/api/student/requests', {
      method: 'POST',
      body: { alumni_id, topic, message }
    }),
    getMyRequests: () => request('/api/student/requests')
  }
};
