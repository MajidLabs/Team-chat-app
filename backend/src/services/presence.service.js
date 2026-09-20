const { redis, presencePubClient } = require('../config/redis');
const env = require('../config/env');

const PRESENCE_CHANNEL = 'presence:events';

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

  // Redis unreachable: return everyone as offline instead of letting the
  // pipeline throw and taking the whole caller (socket presence:snapshot,
  // or the REST /api/users list) down with it.
  if (redis.status !== 'ready') {
    const statuses = {};
    userIds.forEach((id) => { statuses[id] = 'offline'; });
    return statuses;
  }

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

async function reconcile(io) {
  if (reconciling) return;
  reconciling = true;
  try {
    const sockets = await io.fetchSockets();
    const connectedByUser = new Map();
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

    for (const userId of redisOnlineUserIds) {
      if (connectedByUser.has(userId)) continue;
      const lastSeen = new Date().toISOString();
      await redis.del(`presence:sockets:${userId}`);
      await redis.set(`presence:lastseen:${userId}`, lastSeen);
      await presencePubClient.publish(PRESENCE_CHANNEL, JSON.stringify({ userId, status: 'offline', lastSeen }));
      console.warn(`[presence] reconcile: corrected stale-online for user ${userId}`);
    }

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