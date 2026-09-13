const express = require('express');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate);

async function assertMember(userId, channelId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [channelId, userId]
  );
  return rows.length > 0;
}

// Cursor-based pagination: ?before=<ISO timestamp>&limit=50
// Returns the most recent page when `before` is omitted.
router.get('/:channelId', asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const isMember = await assertMember(req.user.id, channelId);
  if (!isMember) return res.status(403).json({ error: 'Not a member of this channel' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  const before = req.query.before ? new Date(req.query.before) : new Date();

  const { rows } = await pool.query(
    `SELECT m.id, m.channel_id, m.sender_id, u.username AS sender_username,
            m.content, m.type, m.created_at, m.edited_at,
            a.id AS attachment_id, a.file_name, a.file_url, a.mime_type, a.file_size
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     LEFT JOIN attachments a ON a.message_id = m.id
     WHERE m.channel_id = $1 AND m.created_at < $2 AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC
     LIMIT $3`,
    [channelId, before, limit]
  );

  const messages = rows.reverse().map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    senderId: r.sender_id,
    senderUsername: r.sender_username,
    content: r.content,
    type: r.type,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    attachment: r.attachment_id
      ? { id: r.attachment_id, fileName: r.file_name, fileUrl: r.file_url, mimeType: r.mime_type, fileSize: r.file_size }
      : null,
  }));

  res.json({ messages, hasMore: rows.length === limit });
}));

router.post('/:channelId/read', asyncHandler(async (req, res) => {
  await pool.query(
    'UPDATE channel_members SET last_read_at = now() WHERE channel_id = $1 AND user_id = $2',
    [req.params.channelId, req.user.id]
  );
  res.json({ ok: true });
}));

module.exports = router;
