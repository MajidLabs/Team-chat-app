const pool = require('../config/db');
const { redis, presenceSubClient } = require('../config/redis');
const env = require('../config/env');
const presenceService = require('../services/presence.service');
const socketAuth = require('./auth');
const registerMessageHandlers = require('./message.handler');
const registerPresenceHandlers = require('./presence.handler');
const registerReauthHandlers = require('./reauth.handler');

async function getUserChannelIds(userId) {
  const { rows } = await pool.query('SELECT channel_id FROM channel_members WHERE user_id = $1', [userId]);
  return rows.map((r) => r.channel_id);
}

// "Related" = shares at least one channel. Presence is only broadcast to
// people who could plausibly care, not to every connected client.
async function getRelatedUserIds(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT cm2.user_id
     FROM channel_members cm1
     JOIN channel_members cm2 ON cm1.channel_id = cm2.channel_id
     WHERE cm1.user_id = $1 AND cm2.user_id != $1`,
    [userId]
  );
  return rows.map((r) => r.user_id);
}

function initSockets(io) {
  io.use(socketAuth);

  // One subscriber per process fans presence changes out to whichever
  // sockets happen to be connected locally. This is the *only* place
  // presence broadcasts happen - addSocket/removeSocket only publish, they
  // never emit directly - so behaviour is identical whether there's one
  // server instance or several behind a load balancer.
  presenceSubClient.subscribe(presenceService.PRESENCE_CHANNEL).catch((err) => {
    // Without this .catch, a Redis outage that outlasts ioredis's retry
    // budget rejects this promise with nothing to receive it - an
    // unhandled rejection that crashes the whole process on Node 15+.
    // Presence just won't fan out locally until the client reconnects
    // (ioredis retries in the background on its own).
    console.error('[sockets] failed to subscribe to presence channel:', err.message);
  });
  presenceSubClient.on('message', async (channel, raw) => {
    if (channel !== presenceService.PRESENCE_CHANNEL) return;
    try {
      const { userId, status, lastSeen } = JSON.parse(raw);
      const relatedUserIds = await getRelatedUserIds(userId);
      relatedUserIds.forEach((uid) => {
        io.to(`user:${uid}`).emit('presence:update', { userId, status, lastSeen });
      });
    } catch (err) {
      console.error('[sockets] failed to process presence event:', err);
    }
  });

  // Presence SETs in Redis can drift from what's actually connected if a
  // call to addSocket/removeSocket throws partway through a Redis outage
  // (see presence.service.js, "reconcile"). Three triggers cover this:
  // once right now (catches anything already stale from before this boot),
  // every time the main client reports 'ready' (fires on every reconnect,
  // so it catches recovering from a live outage - not just the first
  // connect), and on a fixed interval as a catch-all in case a recovery is
  // somehow missed by both of the above. reconcile() already guards against
  // overlapping runs and swallows its own errors, so firing it from three
  // places is safe, not wasteful.
  presenceService.reconcile(io).catch((err) => console.error('[sockets] initial reconcile failed:', err));
  redis.on('ready', () => {
    presenceService.reconcile(io).catch((err) => console.error('[sockets] reconcile-on-ready failed:', err));
  });
  setInterval(() => {
    presenceService.reconcile(io).catch((err) => console.error('[sockets] periodic reconcile failed:', err));
  }, env.presenceReconcileIntervalMs);

  io.on('connection', async (socket) => {
    const { userId, username } = socket.data;

    // Attached synchronously, before any `await` below. The client's
    // 'connect' event fires as soon as the transport handshake completes,
    // not once the server has finished this async setup - a message sent
    // in that window would otherwise arrive with no 'message:send' listener
    // registered yet and be silently dropped (no error, ack never fires).
    // socket.data is already populated here because io.use(socketAuth)
    // is guaranteed to finish before 'connection' is emitted.
    registerPresenceHandlers(io, socket);
    registerMessageHandlers(io, socket);
    registerReauthHandlers(io, socket);

    try {
      socket.join(`user:${userId}`);

      const channelIds = await getUserChannelIds(userId);
      channelIds.forEach((id) => socket.join(`channel:${id}`));

      console.log(`[socket] ${username} connected (${socket.id})`);
    } catch (err) {
      // Postgres-backed - a failure here means the socket didn't get its
      // channel rooms, so messaging genuinely won't work either. Not
      // something a Redis outage on its own can cause.
      console.error('[sockets] connection setup failed:', err);
    }

    // Presence is best-effort, ephemeral state (see ARCHITECTURE.md,
    // "Redis outage behaviour") - kept in its own try/catch so a Redis
    // outage degrades presence only and never affects the channel joins
    // above, which are what actually let messaging work. The client still
    // gets exactly one presence:snapshot either way: an empty one during
    // an outage is an honest "status unknown", instead of leaving the
    // frontend waiting on an event that would otherwise never arrive.
    try {
      await presenceService.addSocket(userId, socket.id);
      const relatedUserIds = await getRelatedUserIds(userId);
      const statuses = await presenceService.getStatuses(relatedUserIds);
      socket.emit('presence:snapshot', statuses);
    } catch (err) {
      console.error('[sockets] presence setup failed, sending empty snapshot:', err.message);
      socket.emit('presence:snapshot', {});
    }

    socket.on('disconnect', async () => {
      try {
        await presenceService.removeSocket(userId, socket.id);
        console.log(`[socket] ${username} disconnected (${socket.id})`);
      } catch (err) {
        console.error('[sockets] disconnect handling failed:', err);
      }
    });
  });
}

module.exports = initSockets;
