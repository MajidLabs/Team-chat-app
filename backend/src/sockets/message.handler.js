const { v4: uuidv4 } = require('uuid');
const { RateLimiterRedis } = require('rate-limiter-flexible');
const pool = require('../config/db');
const { redis } = require('../config/redis');
const env = require('../config/env');
const notificationService = require('../services/notification.service');

const messageLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rl:socket:message',
  points: env.rateLimit.messagesPerMin,
  duration: 60,
});

async function isChannelMember(userId, channelId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );
  return rows.length > 0;
}

module.exports = function registerMessageHandlers(io, socket) {
  const { userId, username } = socket.data;

  socket.on('channel:join', async (channelId, callback) => {
    try {
      const member = await isChannelMember(userId, channelId);
      if (!member) return callback?.({ ok: false, error: 'Not a member of this channel' });
      socket.join(`channel:${channelId}`);
      callback?.({ ok: true });
    } catch (err) {
      callback?.({ ok: false, error: 'Failed to join channel' });
    }
  });

  socket.on('channel:active', async (channelId) => {
    if (!channelId) {
      socket.data.activeChannelId = null;
      return;
    }
    const member = await isChannelMember(userId, channelId).catch(() => false);
    socket.data.activeChannelId = member ? channelId : null;
  });

  socket.on('message:send', async (payload, callback) => {
    const { channelId, content, attachment } = payload || {};

    if (!channelId || (!content && !attachment)) {
      return callback?.({ ok: false, error: 'channelId and content or attachment are required' });
    }
    if (content && content.length > 10000) {
      return callback?.({ ok: false, error: 'Message content exceeds 10,000 characters' });
    }

    if (redis.status !== 'ready') {
      console.error('[socket] message rate limiter unavailable (redis not ready), failing open');
    } else {
      try {
        await messageLimiter.consume(userId);
      } catch (rejRes) {
        if (!(rejRes instanceof Error)) {
          return callback?.({ ok: false, error: 'Rate limit exceeded, slow down.' });
        }
        console.error('[socket] message rate limiter unavailable, failing open:', rejRes.message);
      }
    }

    try {
      const member = await isChannelMember(userId, channelId);
      if (!member) return callback?.({ ok: false, error: 'Not a member of this channel' });

      if (attachment && !attachment.id) {
        return callback?.({ ok: false, error: 'Invalid attachment' });
      }

      const messageId = uuidv4();
      const type = attachment ? 'file' : 'text';

      const client = await pool.connect();
      let createdAt;
      let attachmentRow = null;
      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `INSERT INTO messages (id, channel_id, sender_id, content, type)
           VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
          [messageId, channelId, userId, content || null, type]
        );
        createdAt = rows[0].created_at;

        if (attachment) {
          const { rows: claimRows } = await client.query(
            `UPDATE uploads SET message_id = $1
             WHERE id = $2 AND owner_id = $3 AND message_id IS NULL
             RETURNING file_name, file_url, mime_type, file_size`,
            [messageId, attachment.id, userId]
          );
          if (claimRows.length === 0) {
            await client.query('ROLLBACK');
            return callback?.({ ok: false, error: 'Invalid or already-used attachment' });
          }
          const claimed = claimRows[0];

          const attachmentId = uuidv4();
          await client.query(
            `INSERT INTO attachments (id, message_id, file_name, file_url, mime_type, file_size)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [attachmentId, messageId, claimed.file_name, claimed.file_url, claimed.mime_type, claimed.file_size]
          );
          attachmentRow = {
            id: attachmentId,
            fileName: claimed.file_name,
            fileUrl: claimed.file_url,
            mimeType: claimed.mime_type,
            fileSize: claimed.file_size,
          };
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const message = {
        id: messageId,
        channelId,
        senderId: userId,
        senderUsername: username,
        content: content || null,
        type,
        attachment: attachmentRow,
        createdAt,
      };

      io.to(`channel:${channelId}`).emit('message:new', message);
      callback?.({ ok: true, message });

      notificationService
        .notifyChannelMembers({ io, channelId, excludeUserId: userId, message })
        .catch((err) => console.error('[notifications] failed:', err));
    } catch (err) {
      console.error('[socket] message:send failed:', err);
      callback?.({ ok: false, error: 'Failed to send message' });
    }
  });

  socket.on('typing:start', (channelId) => {
    if (!channelId) return;
    socket.to(`channel:${channelId}`).emit('typing:update', { userId, username, channelId, isTyping: true });
  });

  socket.on('typing:stop', (channelId) => {
    if (!channelId) return;
    socket.to(`channel:${channelId}`).emit('typing:update', { userId, username, channelId, isTyping: false });
  });
};