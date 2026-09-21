const state = {
  user: null,
  channels: [],
  users: [],
  currentChannelId: null,
  presence: {},
  pendingAttachment: null,
  typingTimeout: null,
};

const el = (id) => document.getElementById(id);

// Holds the socket event-handler set built in startApp(), so handleAuthExpired
// can reconnect with the same handlers after refreshing the token.
let socketCallbacks = null;

// ---------- Auth view ----------

function initAuthView() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      el('login-form').classList.toggle('hidden', tab !== 'login');
      el('register-form').classList.toggle('hidden', tab !== 'register');
    });
  });

  el('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('login-error').textContent = '';
    const email = el('login-email').value.trim();
    const password = el('login-password').value;
    const { ok, data } = await Api.login(email, password);
    if (!ok) { el('login-error').textContent = data.error || 'Login failed'; return; }
    Auth.setTokens(data.accessToken, data.refreshToken);
    Auth.setUser(data.user);
    startApp(data.user);
  });

  el('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('register-error').textContent = '';
    const username = el('register-username').value.trim();
    const email = el('register-email').value.trim();
    const password = el('register-password').value;
    const { ok, data } = await Api.register(username, email, password);
    if (!ok) { el('register-error').textContent = data.error || 'Registration failed'; return; }
    Auth.setTokens(data.accessToken, data.refreshToken);
    Auth.setUser(data.user);
    startApp(data.user);
  });
}

// ---------- App bootstrap ----------

async function startApp(user) {
  state.user = user;
  el('auth-view').classList.add('hidden');
  el('app-view').classList.remove('hidden');
  el('me-username').textContent = user.username;

  // Create the socket before loading channels/users. `loadChannels` can call
  // `selectChannel` -> `joinChannelRoom`, which needs a live socket; if a
  // 401 mid-load triggers a token refresh that takes a moment, channels can
  // resolve before the socket exists, and joinChannelRoom would crash on a
  // null socket. Creating the socket first removes that ordering hazard -
  // io() returns a socket instance immediately and queues emits until the
  // connection is actually established.
  socketCallbacks = {
    onConnect: () => console.log('[socket] connected'),
    onMessageNew: handleIncomingMessage,
    onPresenceSnapshot: (statuses) => {
      state.presence = { ...state.presence, ...statuses };
      renderUserList();
    },
    onPresenceUpdate: ({ userId, status }) => {
      state.presence[userId] = status;
      renderUserList();
    },
    onTypingUpdate: handleTypingUpdate,
    onNotificationNew: handleIncomingNotification,
    onUserNew: (u) => {
      if (u.id !== state.user.id && !state.users.find((x) => x.id === u.id)) {
        state.users.push({ ...u, status: 'offline' });
        renderUserList();
      }
    },
    onChannelAdded: (channel) => {
      if (!state.channels.find((c) => c.id === channel.id)) {
        state.channels.push(channel);
        renderChannelList();
      }
    },
    onAuthExpired: handleAuthExpired,
  };
  connectSocket(socketCallbacks);

  await Promise.all([loadChannels(), loadUsers()]);

  loadNotifications();
}

function logout() {
  Auth.clear();
  if (socket) socket.disconnect();
  location.reload();
}

// Fires when the server disconnects the socket because the access token
// expired without a successful reauth (see ARCHITECTURE.md, "Socket auth
// lifecycle"). Without this handler the UI just goes silently unresponsive -
// sending/receiving stops with no indication why. Try a silent refresh
// (the refresh token has a much longer lifetime than the access token) and
// reconnect; only fall back to forcing a re-login if that refresh fails too.
async function handleAuthExpired() {
  console.warn('[socket] session expired without a successful reauth; refreshing and reconnecting');
  const refreshed = await tryRefresh();
  if (refreshed && socketCallbacks) {
    connectSocket(socketCallbacks);
    return;
  }
  alert('Your session has expired. Please log in again.');
  logout();
}

// ---------- Channels ----------

async function loadChannels() {
  const result = await Api.listChannels();
  if (!Array.isArray(result)) {
    console.error('[loadChannels] unexpected response, expected an array:', result);
    state.channels = [];
    renderChannelList();
    return;
  }
  state.channels = result;
  renderChannelList();
  if (!state.currentChannelId && state.channels.length > 0) {
    selectChannel(state.channels[0].id);
  }
}

function renderChannelList() {
  const list = el('channel-list');
  list.innerHTML = '';
  state.channels.forEach((ch) => {
    const li = document.createElement('li');
    li.textContent = ch.type === 'dm' ? dmLabel(ch) : `# ${ch.name}`;
    li.className = ch.id === state.currentChannelId ? 'active' : '';
    li.addEventListener('click', () => selectChannel(ch.id));
    list.appendChild(li);
  });
}

function dmLabel(channel) {
  return channel.otherUsername ? `@ ${channel.otherUsername}` : 'Direct message';
}

el('new-channel-btn').addEventListener('click', async () => {
  const name = prompt('Channel name:');
  if (!name) return;
  await Api.createChannel(name.trim(), 'public');
  await loadChannels();
});

el('browse-channel-btn').addEventListener('click', async () => {
  const list = el('discover-list');
  const willShow = list.classList.contains('hidden');
  list.classList.toggle('hidden');
  if (!willShow) return;

  const channels = await Api.discoverChannels();
  list.innerHTML = '';
  if (channels.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'No public channels to join';
    list.appendChild(li);
    return;
  }
  channels.forEach((ch) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `# ${ch.name}`;
    const btn = document.createElement('button');
    btn.textContent = 'Join';
    btn.addEventListener('click', async () => {
      await Api.joinChannel(ch.id);
      await loadChannels();
      list.classList.add('hidden');
    });
    li.appendChild(label);
    li.appendChild(btn);
    list.appendChild(li);
  });
});

async function selectChannel(channelId) {
  state.currentChannelId = channelId;
  renderChannelList();

  const channel = state.channels.find((c) => c.id === channelId);
  el('current-channel-name').textContent = channel ? (channel.type === 'dm' ? dmLabel(channel) : `# ${channel.name}`) : '';

  joinChannelRoom(channelId, () => {});
  setActiveChannel(channelId);

  const { messages } = await Api.history(channelId);
  renderMessages(messages);
  Api.markRead(channelId);
}

// ---------- Users / presence ----------

async function loadUsers() {
  const users = await Api.listUsers();
  state.users = users.filter((u) => u.id !== state.user.id);
  renderUserList();
}

function renderUserList() {
  const list = el('user-list');
  list.innerHTML = '';
  state.users.forEach((u) => {
    const status = state.presence[u.id] || u.status || 'offline';
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `status-dot ${status}`;
    li.appendChild(dot);
    li.appendChild(document.createTextNode(u.username));
    li.addEventListener('click', async () => {
      const { id } = await Api.openDm(u.id);
      await loadChannels();
      selectChannel(id);
    });
    list.appendChild(li);
  });
}

// ---------- Messages ----------

function renderMessages(messages) {
  const box = el('messages');
  box.innerHTML = '';
  messages.forEach((m) => box.appendChild(renderMessageEl(m)));
  box.scrollTop = box.scrollHeight;
}

function renderMessageEl(m) {
  const div = document.createElement('div');
  div.className = 'message' + (m.senderId === state.user.id ? ' mine' : '');
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let attachmentHtml = '';
  if (m.attachment) {
    const isImage = (m.attachment.mimeType || '').startsWith('image/');
    const url = `${API_BASE}${m.attachment.fileUrl}`;
    attachmentHtml = isImage
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="attachment-img" src="${escapeHtml(url)}" alt="${escapeHtml(m.attachment.fileName)}" /></a>`
      : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="attachment-file">${escapeHtml(m.attachment.fileName)}</a>`;
  }

  div.innerHTML = `
    <div class="message-meta"><strong>${escapeHtml(m.senderUsername || 'Unknown')}</strong> <span class="time">${time}</span></div>
    ${m.content ? `<div class="message-content">${escapeHtml(m.content)}</div>` : ''}
    ${attachmentHtml}
  `;
  return div;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function handleIncomingMessage(msg) {
  if (msg.channelId === state.currentChannelId) {
    const box = el('messages');
    box.appendChild(renderMessageEl(msg));
    box.scrollTop = box.scrollHeight;
    Api.markRead(msg.channelId);
  }
}

el('message-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = el('message-input');
  const content = input.value.trim();
  if (!content && !state.pendingAttachment) return;
  if (!state.currentChannelId) return;

  sendMessage(state.currentChannelId, content, state.pendingAttachment, (res) => {
    if (!res?.ok) alert(res?.error || 'Failed to send message');
  });

  input.value = '';
  state.pendingAttachment = null;
  el('upload-preview').classList.add('hidden');
  emitTyping(state.currentChannelId, false);
});

el('message-input').addEventListener('input', () => {
  if (!state.currentChannelId) return;
  emitTyping(state.currentChannelId, true);
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => emitTyping(state.currentChannelId, false), 1500);
});

function handleTypingUpdate({ channelId, username, isTyping }) {
  if (channelId !== state.currentChannelId) return;
  const indicator = el('typing-indicator');
  if (isTyping) {
    indicator.textContent = `${username} is typing...`;
    indicator.classList.remove('hidden');
  } else {
    indicator.classList.add('hidden');
  }
}

// ---------- File attachments ----------

el('attach-btn').addEventListener('click', () => el('file-input').click());

el('file-input').addEventListener('change', async () => {
  const file = el('file-input').files[0];
  if (!file) return;
  const meta = await Api.uploadFile(file);
  state.pendingAttachment = meta;
  el('upload-preview').textContent = `Attached: ${meta.fileName}`;
  el('upload-preview').classList.remove('hidden');
});

// ---------- Notifications ----------

async function loadNotifications() {
  const notifs = await Api.notifications();
  renderNotifications(notifs);
}

function renderNotifications(notifs) {
  const unread = notifs.filter((n) => !n.isRead).length;
  updateNotifBadge(unread);

  const panel = el('notif-panel');
  panel.innerHTML = '';
  notifs.slice(0, 20).forEach((n) => panel.appendChild(renderNotifEl(n)));
}

function renderNotifEl(n) {
  const div = document.createElement('div');
  div.className = 'notif-item' + (n.isRead ? '' : ' unread');
  div.textContent = `${n.payload.senderUsername}: ${n.payload.preview}`;
  div.addEventListener('click', async () => {
    await Api.markNotifRead(n.id);
    selectChannel(n.payload.channelId);
    el('notif-panel').classList.add('hidden');
  });
  return div;
}

function updateNotifBadge(count) {
  const countEl = el('notif-count');
  countEl.textContent = String(count);
  countEl.classList.toggle('hidden', count === 0);
}

function handleIncomingNotification(n) {
  const current = parseInt(el('notif-count').textContent || '0', 10);
  updateNotifBadge(current + 1);
  el('notif-panel').prepend(renderNotifEl({ ...n, isRead: false }));
}

el('notif-btn').addEventListener('click', () => el('notif-panel').classList.toggle('hidden'));
el('logout-btn').addEventListener('click', logout);

// ---------- Boot ----------

initAuthView();
if (Auth.getAccessToken() && Auth.getUser()) {
  startApp(Auth.getUser());
}
