const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');

// Writes a notification row per recipient and pushes it live to anyone
// currently connected. Members who already have this exact channel open
// (tracked via socket.data.activeChannelId) are skipped - they just saw the
// message arrive live and don't need a duplicate notification for it.
async function notifyChannelMembers({ io, channelId, excludeUserId, message }) {
  const { rows: members } = await pool.query(
    'SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id != $2',
    [channelId, excludeUserId]
  );
  if (members.length === 0) return;

  const viewers = await io.in(`channel:${channelId}`).fetchSockets();
  const activelyViewing = new Set(
    viewers.filter((s) => s.data.activeChannelId === channelId).map((s) => s.data.userId)
  );

  for (const { user_id: userId } of members) {
    if (activelyViewing.has(userId)) continue;

    const payload = {
      channelId,
      messageId: message.id,
      senderId: message.senderId,
      senderUsername: message.senderUsername,
      preview: (message.content || 'File attachment').slice(0, 140),
    };

    const notificationId = uuidv4();
    const { rows } = await pool.query(
      `INSERT INTO notifications (id, user_id, type, payload)
       VALUES ($1, $2, 'new_message', $3) RETURNING created_at`,
      [notificationId, userId, JSON.stringify(payload)]
    );

    io.to(`user:${userId}`).emit('notification:new', {
      id: notificationId,
      type: 'new_message',
      payload,
      isRead: false,
      createdAt: rows[0].created_at,
    });
  }
}

module.exports = { notifyChannelMembers };
