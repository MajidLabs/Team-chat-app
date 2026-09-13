const { redis, presencePubClient } = require('../config/redis');
const env = require('../config/env');

const PRESENCE_CHANNEL = 'presence:events';

// A user can have several sockets open at once (multiple tabs/devices), so
// presence is tracked as a Redis SET of socket ids per user rather than a
// single flag. The user is "online" while the set is non-empty. Each script
// reports the set's size *before* the mutation so the caller can tell,
// atomically, whether this was the transition that changed online status -
// two sockets connecting back to back must not both fire an "online" event.
const ADD_SCRIPT = `
local before = redis.call('SCARD', KEYS[1])
redis.call('SADD', KEYS[1], ARGV[1])
return before
`;

const REMOVE_SCRIPT = `
redis.call('SREM', KEYS[1], ARGV[1])
return redis.call('SCARD', KEYS[1])
`;

async function addSocket(userId, socketId) {
  const key = `presence:sockets:${userId}`;
  const before = await redis.eval(ADD_SCRIPT, 1, key, socketId);
  const wentOnline = Number(before) === 0;
  if (wentOnline) {
    await redis.del(`presence:lastseen:${userId}`);
    await presencePubClient.publish(PRESENCE_CHANNEL, JSON.stringify({ userId, status: 'online' }));
  }
  return wentOnline;
}

async function removeSocket(userId, socketId) {
  const key = `presence:sockets:${userId}`;
  const remaining = await redis.eval(REMOVE_SCRIPT, 1, key, socketId);
  const wentToZero = Number(remaining) === 0;
  if (wentToZero) {
    const lastSeen = new Date().toISOString();
    await redis.set(`presence:lastseen:${userId}`, lastSeen);

    setTimeout(async () => {
      try {
        // Re-check against the live set, not a flag set back when this
        // timer was scheduled - if any socket (including a reconnect that
        // landed on a different server instance) is present now, this was
        // a blip, not a real transition, and nothing should be published.
        const stillZero = (await redis.scard(key)) === 0;
        if (stillZero) {
          await presencePubClient.publish(PRESENCE_CHANNEL, JSON.stringify({ userId, status: 'offline', lastSeen }));
        }
      } catch (err) {
        console.error('[presence] offline grace-period recheck failed:', err);
      }
    }, env.presenceOfflineGraceMs);
  }
  return wentToZero;
}

async function isOnline(userId) {
  const count = await redis.scard(`presence:sockets:${userId}`);
  return count > 0;
}

async function getStatuses(userIds) {
  if (!userIds || userIds.length === 0) return {};
  const pipeline = redis.pipeline();
  userIds.forEach((id) => pipeline.scard(`presence:sockets:${id}`));
  const results = await pipeline.exec();
  const statuses = {};
  userIds.forEach((id, idx) => {
    statuses[id] = results[idx][1] > 0 ? 'online' : 'offline';
  });
  return statuses;
}

async function getLastSeen(userId) {
  return redis.get(`presence:lastseen:${userId}`);
}

let reconciling = false;

// addSocket/removeSocket can each throw partway through if Redis drops
// mid-call (see ARCHITECTURE.md, "Redis outage behaviour"), leaving a
// presence:sockets:* SET out of sync with who's actually connected - in
// the worst case, a user who disconnected stays "online" forever, since
// nothing else ever revisits that key. This treats Socket.IO's own socket
// list as ground truth (the Redis adapter already keeps it consistent
// across every server instance) and makes Redis match it. Meant to run on
// a timer and again whenever Redis reports 'ready' after being down - if
// Redis is still unreachable when it runs, it just logs and waits for the
// next tick rather than making anything worse.
async function reconcile(io) {
  if (reconciling) return; // a previous run is still in flight; skip this tick
  reconciling = true;
  try {
    const sockets = await io.fetchSockets();
    const connectedByUser = new Map(); // userId -> Set<socketId>, per Socket.IO
    for (const s of sockets) {
      for (const room of s.rooms) {
        if (!room.startsWith('user:')) continue;
        const uid = room.slice('user:'.length);
        if (!connectedByUser.has(uid)) connectedByUser.set(uid, new Set());
        connectedByUser.get(uid).add(s.id);
      }
    }

    const redisOnlineUserIds = new Set();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'presence:sockets:*', 'COUNT', 100);
      cursor = next;
      keys.forEach((k) => redisOnlineUserIds.add(k.slice('presence:sockets:'.length)));
    } while (cursor !== '0');

    // Case 1: Redis says online, nobody's actually connected anywhere.
    for (const userId of redisOnlineUserIds) {
      if (connectedByUser.has(userId)) continue;
      const lastSeen = new Date().toISOString();
      await redis.del(`presence:sockets:${userId}`);
      await redis.set(`presence:lastseen:${userId}`, lastSeen);
      await presencePubClient.publish(PRESENCE_CHANNEL, JSON.stringify({ userId, status: 'offline', lastSeen }));
      console.warn(`[presence] reconcile: corrected stale-online for user ${userId}`);
    }

    // Case 2: actually connected, but Redis never heard about it.
    for (const [userId, socketIds] of connectedByUser) {
      if (redisOnlineUserIds.has(userId)) continue;
      await redis.sadd(`presence:sockets:${userId}`, ...socketIds);
      await redis.del(`presence:lastseen:${userId}`);
      await presencePubClient.publish(PRESENCE_CHANNEL, JSON.stringify({ userId, status: 'online' }));
      console.warn(`[presence] reconcile: corrected stale-offline for user ${userId}`);
    }
  } catch (err) {
    console.error('[presence] reconcile failed, will retry next tick:', err.message);
  } finally {
    reconciling = false;
  }
}

module.exports = { addSocket, removeSocket, isOnline, getStatuses, getLastSeen, reconcile, PRESENCE_CHANNEL };
