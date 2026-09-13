// End-to-end integration test against a *running* server and a real
// Postgres + Redis - no mocks. Two independent JWT-authenticated socket
// connections stand in for two real browser tabs.
//
// Usage:
//   1. Start Postgres, Redis, and the backend (`npm start`) as normal.
//   2. In another terminal: npm run test:integration
//
// Safe to re-run repeatedly - it registers fresh randomly-suffixed accounts
// each time rather than reusing fixed ones, so it never collides with
// itself. It does leave those accounts and their #general messages behind
// in the database, which is fine for a dev/test database but is one more
// reason not to point this at a database you care about.
//
// Assumes the default rate-limit thresholds from .env.example
// (30 messages/min, 10 login attempts/15min). If you've changed those in
// your own .env, the two rate-limit checks near the end may need their
// loop bounds adjusted to still land past your new limit.

const { io } = require('socket.io-client');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_access_secret';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:4000';

const results = [];
function check(name, cond, extra) {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`);
}

const rand = Math.random().toString(36).slice(2, 8);

async function registerUser(username, email) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, email, password: 'password123' }),
  });
  return { ok: res.ok, data: await res.json() };
}

async function apiGet(path, token) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, data: await res.json() };
}
async function apiPost(path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, data: await res.json() };
}

function waitForEvent(socket, event, timeoutMs = 4000, filter) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    const handler = (payload) => {
      if (filter && !filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function main() {
  console.log(`Testing against ${BASE}\n`);

  // ---------- register two users ----------
  const a = await registerUser(`alice_${rand}`, `alice_${rand}@test.com`);
  const b = await registerUser(`bob_${rand}`, `bob_${rand}@test.com`);
  check('register user A succeeds (201 + tokens)', a.ok && a.data.accessToken && a.data.user.id);
  check('register user B succeeds (201 + tokens)', b.ok && b.data.accessToken && b.data.user.id);

  const tokenA = a.data.accessToken;
  const tokenB = b.data.accessToken;
  const userA = a.data.user;
  const userB = b.data.user;

  const dupe = await registerUser(userA.username, `other_${rand}@test.com`);
  check('duplicate username is rejected (409)', dupe.ok === false);

  // ---------- auto-join to #general ----------
  const chansA = await apiGet('/api/channels', tokenA);
  const general = chansA.data.find((c) => c.name === 'general');
  check('user A is auto-joined to #general on register', !!general);

  const chansB = await apiGet('/api/channels', tokenB);
  const generalForB = chansB.data.find((c) => c.name === 'general');
  check('user B is auto-joined to #general on register', !!generalForB);
  check('both users share the same #general channel id', general && generalForB && general.id === generalForB.id);

  const usersForA = await apiGet('/api/users', tokenA);
  const bobInList = usersForA.data.find((u) => u.id === userB.id);
  check("user B appears in user A's directory with a live status field", bobInList && 'status' in bobInList);

  // ---------- connect two independent sockets with JWT ----------
  const socketA = io(BASE, { auth: { token: tokenA }, transports: ['websocket'], forceNew: true });
  const socketB = io(BASE, { auth: { token: tokenB }, transports: ['websocket'], forceNew: true });

  // Attached before 'connect' resolves - the server sends this once, right
  // after connecting, so a listener added later could miss it.
  const snapshotPromise = new Promise((resolve) => socketB.once('presence:snapshot', resolve));

  const connectedA = await new Promise((res) => {
    if (socketA.connected) return res(true);
    socketA.on('connect', () => res(true));
  });
  const connectedB = await new Promise((res) => {
    if (socketB.connected) return res(true);
    socketB.on('connect', () => res(true));
  });
  check('socket A connects with JWT handshake auth', connectedA);
  check('socket B connects with JWT handshake auth', connectedB);

  const badSocket = io(BASE, { auth: { token: 'garbage' }, transports: ['websocket'], forceNew: true });
  const badResult = await new Promise((res) => {
    badSocket.on('connect_error', (err) => res(err.message));
    badSocket.on('connect', () => res('CONNECTED (should not happen)'));
    setTimeout(() => res('TIMEOUT'), 3000);
  });
  check('socket with an invalid JWT is rejected', badResult && badResult.includes('Invalid'), badResult);
  badSocket.close();

  // ---------- presence snapshot ----------
  const snapshotB = await Promise.race([snapshotPromise, new Promise((r) => setTimeout(() => r(null), 3000))]);
  check('user B receives presence:snapshot on connect', snapshotB !== null);
  check('presence:snapshot shows user A as online', snapshotB && snapshotB[userA.id] === 'online', JSON.stringify(snapshotB));

  // ---------- live message delivery ----------
  socketA.emit('channel:active', general.id);
  socketB.emit('channel:active', general.id);
  await new Promise((r) => setTimeout(r, 200));

  const messageWaitB = waitForEvent(socketB, 'message:new', 4000, (m) => m.channelId === general.id);
  const sendAck = await new Promise((resolve) => {
    socketA.emit('message:send', { channelId: general.id, content: 'hello from A' }, resolve);
  });
  check('message:send is acknowledged with the persisted message', sendAck && sendAck.ok && sendAck.message.id);

  const receivedByB = await messageWaitB;
  check('user B receives message:new in realtime (no poll/refresh)', receivedByB && receivedByB.content === 'hello from A');
  check('delivered message has the correct senderUsername', receivedByB && receivedByB.senderUsername === userA.username);

  const historyB = await apiGet(`/api/messages/${general.id}`, tokenB);
  check('sent message is persisted and returned by the history endpoint', historyB.data.messages.some((m) => m.content === 'hello from A'));

  // ---------- typing indicator ----------
  const typingWaitB = waitForEvent(socketB, 'typing:update', 3000, (t) => t.channelId === general.id);
  socketA.emit('typing:start', general.id);
  const typingEvent = await typingWaitB;
  check(
    'typing:start from A reaches B as typing:update',
    typingEvent && typingEvent.isTyping === true && typingEvent.userId === userA.id
  );

  // ---------- notifications ----------
  const channelAddedWaitB = waitForEvent(socketB, 'channel:added', 4000);
  const dmRes = await apiPost('/api/channels/dm', tokenA, { userId: userB.id });
  check('DM channel is created via REST', dmRes.status === 201 && dmRes.data.id);
  const dmChannelId = dmRes.data.id;

  const channelAddedEvent = await channelAddedWaitB;
  check('user B is notified live of the new DM (channel:added)', channelAddedEvent && channelAddedEvent.id === dmChannelId);

  const notifWaitB = waitForEvent(socketB, 'notification:new', 4000);
  await new Promise((resolve) => socketA.emit('message:send', { channelId: dmChannelId, content: 'dm ping' }, resolve));
  const notifEvent = await notifWaitB;
  check(
    'user B gets a live notification for a message in a channel they are not actively viewing',
    notifEvent && notifEvent.payload.channelId === dmChannelId
  );

  const notifListB = await apiGet('/api/notifications', tokenB);
  check('notification is persisted and retrievable via REST', notifListB.data.some((n) => n.payload.channelId === dmChannelId));

  socketB.emit('channel:active', dmChannelId);
  await new Promise((r) => setTimeout(r, 200));
  let unexpectedNotif = false;
  const noNotifHandler = () => { unexpectedNotif = true; };
  socketB.on('notification:new', noNotifHandler);
  await new Promise((resolve) => socketA.emit('message:send', { channelId: dmChannelId, content: 'dm ping 2' }, resolve));
  await new Promise((r) => setTimeout(r, 1000));
  socketB.off('notification:new', noNotifHandler);
  check('no notification is created when the recipient is actively viewing the channel', unexpectedNotif === false);

  // ---------- file upload ----------
  const boundary = '----testboundary' + rand;
  const fileContent = 'hello this is a test file';
  const multipartBody =
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: text/plain\r\n\r\n${fileContent}\r\n--${boundary}--\r\n`;
  const uploadRes = await fetch(`${BASE}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody,
  });
  const uploadData = await uploadRes.json();
  check('file upload succeeds and returns a fileUrl', uploadRes.ok && !!uploadData.fileUrl);

  const fetchedFile = await fetch(`${BASE}${uploadData.fileUrl}`);
  const fetchedText = await fetchedFile.text();
  check('uploaded file is served back correctly via the static route', fetchedFile.ok && fetchedText === fileContent);

  const fileMsgWaitB = waitForEvent(socketB, 'message:new', 4000, (m) => m.type === 'file');
  await new Promise((resolve) => socketA.emit('message:send', { channelId: general.id, attachment: uploadData }, resolve));
  const fileMsg = await fileMsgWaitB;
  check('file message is delivered live with attachment metadata', fileMsg && fileMsg.attachment && fileMsg.attachment.fileName === 'test.txt');

  // ---------- authorization: cross-user / cross-channel negative tests ----------
  const c = await registerUser(`carol_${rand}`, `carol_${rand}@test.com`);
  check('register user C succeeds (201 + tokens)', c.ok && c.data.accessToken && c.data.user.id);
  const tokenC = c.data.accessToken;

  const membersAsC = await apiGet(`/api/channels/${dmChannelId}/members`, tokenC);
  check('non-member cannot list members of a channel they are not part of (403)', membersAsC.status === 403);

  const boundary2 = '----testboundary2' + rand;
  const fileContent2 = 'another test file';
  const multipartBody2 =
    `--${boundary2}\r\nContent-Disposition: form-data; name="file"; filename="crossuser.txt"\r\nContent-Type: text/plain\r\n\r\n${fileContent2}\r\n--${boundary2}--\r\n`;
  const uploadRes2 = await fetch(`${BASE}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': `multipart/form-data; boundary=${boundary2}` },
    body: multipartBody2,
  });
  const uploadData2 = await uploadRes2.json();
  check('upload for cross-user test succeeds and returns an id', uploadRes2.ok && !!uploadData2.id);

  const socketB2 = io(BASE, { auth: { token: tokenB }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => { if (socketB2.connected) return res(); socketB2.on('connect', res); });

  const crossUserAck = await new Promise((resolve) => {
    socketB2.emit('message:send', { channelId: general.id, attachment: { id: uploadData2.id } }, resolve);
  });
  check("sending another user's upload id as an attachment is rejected", crossUserAck && crossUserAck.ok === false);
  socketB2.close();

  const ownerAck = await new Promise((resolve) => {
    socketA.emit('message:send', { channelId: general.id, attachment: { id: uploadData2.id } }, resolve);
  });
  check('the actual owner can attach their own upload', ownerAck && ownerAck.ok === true);

  const reuseAck = await new Promise((resolve) => {
    socketA.emit('message:send', { channelId: general.id, attachment: { id: uploadData2.id } }, resolve);
  });
  check('the same upload id cannot be attached to a second message', reuseAck && reuseAck.ok === false);

  const fakeAck = await new Promise((resolve) => {
    socketA.emit(
      'message:send',
      { channelId: general.id, attachment: { id: '00000000-0000-0000-0000-000000000000' } },
      resolve
    );
  });
  check('a fabricated / nonexistent attachment id is rejected', fakeAck && fakeAck.ok === false);

  const boundary3 = '----testboundary3' + rand;
  const multipartBody3 =
    `--${boundary3}\r\nContent-Disposition: form-data; name="file"; filename="virus.exe"\r\nContent-Type: application/octet-stream\r\n\r\nfake-binary-content\r\n--${boundary3}--\r\n`;
  const uploadRes3 = await fetch(`${BASE}/api/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': `multipart/form-data; boundary=${boundary3}` },
    body: multipartBody3,
  });
  check('uploading a disallowed file extension (.exe) is rejected (400)', uploadRes3.status === 400);

  const [dmRace1, dmRace2] = await Promise.all([
    apiPost('/api/channels/dm', tokenA, { userId: c.data.user.id }),
    apiPost('/api/channels/dm', tokenC, { userId: userA.id }),
  ]);
  check(
    'two concurrent DM-creation requests between the same pair resolve to one channel, not two',
    dmRace1.data.id && dmRace1.data.id === dmRace2.data.id
  );

  // ---------- socket auth lifecycle: reauthentication ----------
  const socketReauth = io(BASE, { auth: { token: tokenA }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => { if (socketReauth.connected) return res(); socketReauth.on('connect', res); });

  const freshTokenRes = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: a.data.refreshToken }),
  });
  const freshTokenData = await freshTokenRes.json();
  const legitReauthAck = await new Promise((resolve) => {
    socketReauth.emit('auth:refresh', { accessToken: freshTokenData.accessToken }, resolve);
  });
  check('re-authenticating with a freshly-issued valid token succeeds', legitReauthAck && legitReauthAck.ok === true);

  const stillWorksAck = await new Promise((resolve) => {
    socketReauth.emit('message:send', { channelId: general.id, content: 'still alive after reauth' }, resolve);
  });
  check('socket still works normally right after a successful reauth', stillWorksAck && stillWorksAck.ok === true);

  const badReauthDisconnect = waitForEvent(socketReauth, 'disconnect', 3000);
  const badReauthAck = await Promise.race([
    new Promise((resolve) => socketReauth.emit('auth:refresh', { accessToken: 'not-a-real-token' }, resolve)),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000)),
  ]);
  check('re-authenticating with a garbage token is rejected', badReauthAck !== 'TIMEOUT' && badReauthAck?.ok === false);
  check('socket is disconnected after a failed reauth attempt', (await badReauthDisconnect) !== null);

  const socketReauth2 = io(BASE, { auth: { token: tokenB }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => { if (socketReauth2.connected) return res(); socketReauth2.on('connect', res); });
  const crossUserDisconnect = waitForEvent(socketReauth2, 'disconnect', 3000);
  const crossUserReauthAck = await Promise.race([
    // A perfectly valid token, just for the wrong user - shouldn't be able
    // to swap this socket's identity.
    new Promise((resolve) => socketReauth2.emit('auth:refresh', { accessToken: freshTokenData.accessToken }, resolve)),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000)),
  ]);
  check(
    "re-authenticating with another user's valid token is rejected",
    crossUserReauthAck !== 'TIMEOUT' && crossUserReauthAck?.ok === false
  );
  check('socket is disconnected after a cross-user reauth attempt', (await crossUserDisconnect) !== null);

  // A genuinely short-lived token, signed the same way the server signs
  // real ones, to prove the auto-disconnect timer is driven by the token's
  // actual exp - not mocked or skipped in test.
  const shortLivedToken = jwt.sign({ sub: userA.id, username: userA.username }, ACCESS_SECRET, { expiresIn: '2s' });
  const socketShortLived = io(BASE, { auth: { token: shortLivedToken }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => { if (socketShortLived.connected) return res(); socketShortLived.on('connect', res); });
  const autoExpireDisconnect = waitForEvent(socketShortLived, 'disconnect', 5000);
  const autoExpireEvent = waitForEvent(socketShortLived, 'auth:expired', 5000);
  const [autoDisc, autoEvt] = await Promise.all([autoExpireDisconnect, autoExpireEvent]);
  check('a socket is auto-disconnected once its real token expiry passes without reauth', autoDisc !== null && autoEvt !== null);

  socketReauth.close();
  socketReauth2.close();
  socketShortLived.close();

  // ---------- presence: disconnect -> offline broadcast ----------
  // Offline is now debounced (see presence.service.js) - genuinely arrives
  // ~5s after disconnect, not immediately, so the wait window needs margin
  // past that on top of normal network/scheduling jitter.
  const offlineWaitB = waitForEvent(socketB, 'presence:update', 9000, (p) => p.userId === userA.id && p.status === 'offline');
  socketA.close();
  const offlineEvent = await offlineWaitB;
  check('user B sees user A go offline in realtime after disconnect', offlineEvent !== null);

  // ---------- presence debounce: brief disconnect/reconnect must not flicker ----------
  const d = await registerUser(`dave_${rand}`, `dave_${rand}@test.com`);
  check('register user D succeeds (201 + tokens)', d.ok && d.data.accessToken && d.data.user.id);
  const tokenD = d.data.accessToken;

  const flickerEvents = [];
  const observerForD = (p) => { if (p.userId === d.data.user.id) flickerEvents.push(p); };
  socketB.on('presence:update', observerForD);

  let socketD = io(BASE, { auth: { token: tokenD }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => { if (socketD.connected) return res(); socketD.on('connect', res); });
  await new Promise((r) => setTimeout(r, 300));

  const disconnectedAt = Date.now();
  socketD.close();
  await new Promise((r) => setTimeout(r, 1000)); // reconnect well inside the 5s grace window
  socketD = io(BASE, { auth: { token: tokenD }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => { if (socketD.connected) return res(); socketD.on('connect', res); });

  // Wait past the *original* scheduled recheck time (disconnect + grace
  // period), not just past the reconnect - this proves the pending recheck
  // actually ran and correctly found a live socket, not merely that nothing
  // fired in the short window right after reconnecting.
  const remainingWait = 5000 - (Date.now() - disconnectedAt) + 1500;
  await new Promise((r) => setTimeout(r, Math.max(remainingWait, 0)));

  socketB.off('presence:update', observerForD);
  socketD.close();
  const sawOffline = flickerEvents.some((p) => p.status === 'offline');
  check('a disconnect/reconnect inside the grace period never publishes offline (no flicker)', !sawOffline);

  // ---------- rate limiting ----------
  const socketA2 = io(BASE, { auth: { token: tokenA }, transports: ['websocket'], forceNew: true });
  await new Promise((res) => {
    if (socketA2.connected) return res();
    socketA2.on('connect', res);
  });
  let rateLimitHit = false;
  for (let i = 0; i < 35; i++) {
    const ack = await Promise.race([
      new Promise((resolve) => socketA2.emit('message:send', { channelId: general.id, content: `spam ${i}` }, resolve)),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 3000)),
    ]);
    if (ack === 'TIMEOUT') break;
    if (ack && ack.ok === false && /rate limit/i.test(ack.error || '')) {
      rateLimitHit = true;
      break;
    }
  }
  check('rate limiter blocks a user sending >30 messages/min on the socket layer', rateLimitHit);
  socketA2.close();

  let loginRateLimitHit = false;
  for (let i = 0; i < 15; i++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@nowhere.com', password: 'wrongpassword' }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (res.status === 429) { loginRateLimitHit = true; break; }
    } catch (e) {
      clearTimeout(t);
      break;
    }
  }
  check('rate limiter blocks repeated login attempts (429)', loginRateLimitHit);

  // ---------- JWT refresh / logout ----------
  const refreshRes = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: b.data.refreshToken }),
  });
  const refreshData = await refreshRes.json();
  check('refresh token exchanges for a new access token', refreshRes.ok && !!refreshData.accessToken);

  const logoutRes = await fetch(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: b.data.refreshToken }),
  });
  check('logout succeeds', logoutRes.ok);

  const refreshAfterLogout = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: b.data.refreshToken }),
  });
  check('revoked refresh token is rejected after logout (401)', refreshAfterLogout.status === 401);

  socketB.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('FAILED:', failed.map((f) => f.name));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
