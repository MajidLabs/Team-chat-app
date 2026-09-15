let socket = null;
let reauthTimer = null;

// Fallback only, for a token we can't read an `exp` out of.
const REAUTH_FALLBACK_MS = 10 * 60 * 1000;

// Reads the `exp` claim without verifying the signature. That's fine here:
// this is only used to decide *when* to refresh. The server verifies the
// token for real on every handshake and on every auth:refresh, so a forged
// exp buys nothing but a badly-timed refresh in the attacker's own tab.
function readTokenExpMs(token) {
  try {
    const [, payload] = token.split('.');
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// The backend disconnects a socket that doesn't re-authenticate before its
// access token expires (see ARCHITECTURE.md, "Socket auth lifecycle"). The
// delay is derived from the token's actual expiry rather than hardcoded,
// because a hardcoded 10-minute interval silently assumed
// JWT_ACCESS_EXPIRES_IN=15m: with any shorter value the server's expiry
// timer fired long before the client's refresh timer did, and every socket
// got dropped and silently reconnected on a loop. Refreshing once 60% of
// the remaining lifetime has elapsed scales with whatever the token
// lifetime actually is - 9 minutes for a 15m token, 12 seconds for a 20s
// one - which is also what makes CHECKLIST.md's short-token test honest.
function nextReauthDelayMs() {
  const expMs = readTokenExpMs(Auth.getAccessToken() || '');
  if (!expMs) return REAUTH_FALLBACK_MS;
  const remaining = expMs - Date.now();
  return Math.max(remaining * 0.6, 2000);
}

function startReauthTimer() {
  stopReauthTimer();
  reauthTimer = setTimeout(async () => {
    const refreshed = await tryRefresh();
    if (!socket) return;
    if (!refreshed) {
      // Couldn't get a new access token. Don't reschedule against the old
      // one's exp - that would spin. The server will send auth:expired when
      // its own timer fires, and handleAuthExpired takes it from there.
      console.error('[socket] token refresh failed; waiting for auth:expired');
      return;
    }
    socket.emit('auth:refresh', { accessToken: Auth.getAccessToken() }, (res) => {
      if (!res?.ok) return console.error('[socket] auth:refresh was rejected:', res?.error);
      startReauthTimer(); // re-arm against the *new* token's expiry
    });
  }, nextReauthDelayMs());
}

function stopReauthTimer() {
  if (reauthTimer) clearTimeout(reauthTimer);
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

  // Without this the failure mode is a bare "io is not defined" in the
  // console and a UI that looks logged-in but never loads anything. Fail
  // loudly and say which script didn't load instead.
  if (typeof io === 'undefined') {
    console.error('[socket] Socket.IO client not loaded - is the backend reachable at ' + API_BASE + '?');
    alert(
      'Could not load the realtime client from ' + API_BASE + '.\n' +
      'The backend is probably not running. Start it and reload this page.'
    );
    return null;
  }

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

// connectSocket can return null (client script never loaded), and these are
// called from UI handlers that don't check. Guard once here rather than at
// every call site, and give anything with an ack callback an explicit
// failure instead of leaving it hanging forever.
function emit(event, ...args) {
  if (socket) return socket.emit(event, ...args);
  console.error(`[socket] dropped '${event}' - no connection`);
  const cb = args[args.length - 1];
  if (typeof cb === 'function') cb({ ok: false, error: 'Not connected' });
}

function joinChannelRoom(channelId, cb) {
  emit('channel:join', channelId, cb);
}

function setActiveChannel(channelId) {
  emit('channel:active', channelId);
}

function sendMessage(channelId, content, attachment, cb) {
  emit('message:send', { channelId, content, attachment }, cb);
}

function emitTyping(channelId, isTyping) {
  emit(isTyping ? 'typing:start' : 'typing:stop', channelId);
}

function queryPresence(userIds, cb) {
  emit('presence:query', userIds, cb);
}