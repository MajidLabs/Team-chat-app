// Point this at wherever the backend is running.
const API_BASE = 'http://localhost:4000';

const Auth = {
  getAccessToken: () => localStorage.getItem('accessToken'),
  getRefreshToken: () => localStorage.getItem('refreshToken'),
  setTokens: (accessToken, refreshToken) => {
    localStorage.setItem('accessToken', accessToken);
    if (refreshToken) localStorage.setItem('refreshToken', refreshToken);
  },
  clear: () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
  },
  getUser: () => JSON.parse(localStorage.getItem('user') || 'null'),
  setUser: (user) => localStorage.setItem('user', JSON.stringify(user)),
};

async function tryRefresh() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: Auth.getRefreshToken() }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    Auth.setTokens(data.accessToken);
    return true;
  } catch {
    return false;
  }
}

// Authenticated fetch wrapper: attaches the access token and retries once
// after a silent refresh if the server says the token expired.
async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  const token = Auth.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

  let res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401 && Auth.getRefreshToken()) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${Auth.getAccessToken()}`;
      res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    }
  }
  return res;
}

const Api = {
  register: (username, email, password) =>
    fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password }),
    }).then((r) => r.json().then((data) => ({ ok: r.ok, data }))),

  login: (email, password) =>
    fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }).then((r) => r.json().then((data) => ({ ok: r.ok, data }))),

  me: () => apiFetch('/api/users/me').then((r) => r.json()),
  listUsers: () => apiFetch('/api/users').then((r) => r.json()),

  listChannels: () => apiFetch('/api/channels').then((r) => r.json()),
  discoverChannels: () => apiFetch('/api/channels/discover').then((r) => r.json()),
  createChannel: (name, type = 'public') =>
    apiFetch('/api/channels', { method: 'POST', body: JSON.stringify({ name, type }) }).then((r) => r.json()),
  joinChannel: (id) => apiFetch(`/api/channels/${id}/join`, { method: 'POST' }).then((r) => r.json()),
  openDm: (userId) =>
    apiFetch('/api/channels/dm', { method: 'POST', body: JSON.stringify({ userId }) }).then((r) => r.json()),
  channelMembers: (id) => apiFetch(`/api/channels/${id}/members`).then((r) => r.json()),

  history: (channelId, before) =>
    apiFetch(`/api/messages/${channelId}${before ? `?before=${encodeURIComponent(before)}` : ''}`).then((r) => r.json()),
  markRead: (channelId) => apiFetch(`/api/messages/${channelId}/read`, { method: 'POST' }),

  uploadFile: (file) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch('/api/files/upload', { method: 'POST', body: form }).then((r) => r.json());
  },

  notifications: () => apiFetch('/api/notifications').then((r) => r.json()),
  markNotifRead: (id) => apiFetch(`/api/notifications/${id}/read`, { method: 'POST' }),
};
