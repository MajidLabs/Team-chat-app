let socket = null;
let reauthTimer = null;

// The backend disconnects a socket that doesn't re-authenticate before its
// access token's ~15-minute expiry (see ARCHITECTURE.md, "Socket auth
// lifecycle"). Refreshing every 10 minutes leaves a comfortable margin
// without needing to decode the JWT client-side just to find its exact exp.
const REAUTH_INTERVAL_MS = 10 * 60 * 1000;

function startReauthTimer() {
  stopReauthTimer();
  reauthTimer = setInterval(async () => {
    const refreshed = await tryRefresh();
    if (!refreshed || !socket) return;
    socket.emit('auth:refresh', { accessToken: Auth.getAccessToken() }, (res) => {
      if (!res?.ok) console.error('[socket] auth:refresh was rejected:', res?.error);
    });
  }, REAUTH_INTERVAL_MS);
}

function stopReauthTimer() {
  if (reauthTimer) clearInterval(reauthTimer);
  reauthTimer = null;
}

function connectSocket({
  onConnect,
  onMessageNew,
  onPresenceSnapshot,
  onPresenceUpdate,
  onTypingUpdate,
  onNotificationNew,
  onUserNew,
  onChannelAdded,
  onAuthExpired,
} = {}) {
  // connectSocket can be called again later (handleAuthExpired reconnects
  // after a silent token refresh). Tear down any previous socket first so
  // we don't leak listeners or leave a stale, disconnected instance around.
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  stopReauthTimer();

  socket = io(API_BASE, { auth: { token: Auth.getAccessToken() } });

  socket.on('connect', () => {
    startReauthTimer();
    onConnect?.();
  });
  socket.on('connect_error', (err) => console.error('[socket] connect_error:', err.message));
  socket.on('auth:expired', (data) => {
    stopReauthTimer();
    onAuthExpired?.(data);
  });
  socket.on('disconnect', () => stopReauthTimer());
  socket.on('message:new', (msg) => onMessageNew?.(msg));
  socket.on('presence:snapshot', (statuses) => onPresenceSnapshot?.(statuses));
  socket.on('presence:update', (data) => onPresenceUpdate?.(data));
  socket.on('typing:update', (data) => onTypingUpdate?.(data));
  socket.on('notification:new', (n) => onNotificationNew?.(n));
  socket.on('user:new', (u) => onUserNew?.(u));
  socket.on('channel:added', (c) => onChannelAdded?.(c));

  return socket;
}

function joinChannelRoom(channelId, cb) {
  socket.emit('channel:join', channelId, cb);
}

function setActiveChannel(channelId) {
  socket.emit('channel:active', channelId);
}

function sendMessage(channelId, content, attachment, cb) {
  socket.emit('message:send', { channelId, content, attachment }, cb);
}

function emitTyping(channelId, isTyping) {
  socket.emit(isTyping ? 'typing:start' : 'typing:stop', channelId);
}

function queryPresence(userIds, cb) {
  socket.emit('presence:query', userIds, cb);
}