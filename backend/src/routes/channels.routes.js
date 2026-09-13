const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate);

// Channels the current user already belongs to.
router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.type, c.created_at AS "createdAt",
            CASE WHEN c.type = 'dm' THEN (
              SELECT u.username FROM channel_members cm2
              JOIN users u ON u.id = cm2.user_id
              WHERE cm2.channel_id = c.id AND cm2.user_id != $1
              LIMIT 1
            ) END AS "otherUsername"
     FROM channels c
     JOIN channel_members cm ON cm.channel_id = c.id
     WHERE cm.user_id = $1
     ORDER BY c.created_at ASC`,
    [req.user.id]
  );
  res.json(rows);
}));

// Public channels the user hasn't joined yet.
router.get('/discover', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.type, c.created_at AS "createdAt"
     FROM channels c
     WHERE c.type = 'public' AND c.id NOT IN (
       SELECT channel_id FROM channel_members WHERE user_id = $1
     )`,
    [req.user.id]
  );
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const { name, type = 'public' } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!['public', 'private'].includes(type)) {
    return res.status(400).json({ error: "type must be 'public' or 'private'" });
  }

  const channelId = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO channels (id, name, type, created_by) VALUES ($1, $2, $3, $4)', [
      channelId, name, type, req.user.id,
    ]);
    await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [channelId, req.user.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ id: channelId, name, type });
}));

// Start (or reuse) a direct-message channel with another user.
router.post('/dm', asyncHandler(async (req, res) => {
  const { userId: otherUserId } = req.body;
  if (!otherUserId || otherUserId === req.user.id) {
    return res.status(400).json({ error: 'A valid other userId is required' });
  }

  const { rows: otherUserRows } = await pool.query('SELECT username FROM users WHERE id = $1', [otherUserId]);
  if (otherUserRows.length === 0) return res.status(404).json({ error: 'User not found' });

  // Sorted so the pair (A,B) and (B,A) always produce the same key - the
  // partial unique index on channels(dm_key) is what actually makes this
  // race-safe, not the application logic around it.
  const dmKey = [req.user.id, otherUserId].sort().join('_');
  const channelId = uuidv4();

  const client = await pool.connect();
  let created = false;
  let resolvedChannelId;
  try {
    await client.query('BEGIN');

    const { rows: inserted } = await client.query(
      `INSERT INTO channels (id, name, type, created_by, dm_key)
       VALUES ($1, 'Direct Message', 'dm', $2, $3)
       ON CONFLICT (dm_key) WHERE type = 'dm' DO NOTHING
       RETURNING id`,
      [channelId, req.user.id, dmKey]
    );

    if (inserted.length > 0) {
      created = true;
      resolvedChannelId = inserted[0].id;
      await client.query('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2), ($1, $3)', [
        resolvedChannelId, req.user.id, otherUserId,
      ]);
    } else {
      // Someone else (possibly a concurrent request from this same pair)
      // already won the race and created it - reuse that row.
      const { rows: existing } = await client.query('SELECT id FROM channels WHERE dm_key = $1', [dmKey]);
      resolvedChannelId = existing[0].id;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!created) return res.json({ id: resolvedChannelId });

  // Bring the other participant's live connection(s) into the room and tell
  // their client a new DM exists, so it appears without a refresh.
  const io = req.app.get('io');
  if (io) {
    io.in(`user:${otherUserId}`).socketsJoin(`channel:${resolvedChannelId}`);
    io.to(`user:${otherUserId}`).emit('channel:added', {
      id: resolvedChannelId,
      name: 'Direct Message',
      type: 'dm',
      otherUsername: req.user.username,
    });
  }

  res.status(201).json({ id: resolvedChannelId });
}));

router.post('/:id/join', asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT type FROM channels WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
  if (rows[0].type !== 'public') return res.status(403).json({ error: 'Cannot self-join a private or DM channel' });

  await pool.query(
    'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.params.id, req.user.id]
  );
  res.json({ ok: true });
}));

router.get('/:id/members', asyncHandler(async (req, res) => {
  const isMember = await pool.query(
    'SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (isMember.rows.length === 0) return res.status(403).json({ error: 'Not a member of this channel' });

  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.avatar_url AS "avatarUrl" FROM users u
     JOIN channel_members cm ON cm.user_id = u.id
     WHERE cm.channel_id = $1`,
    [req.params.id]
  );
  res.json(rows);
}));

module.exports = router;
