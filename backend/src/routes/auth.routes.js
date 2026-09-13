const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const pool = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const createRateLimiter = require('../middleware/rateLimiter');
const env = require('../config/env');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} = require('../services/token.service');

const router = express.Router();

const loginLimiter = createRateLimiter({
  keyPrefix: 'rl:login',
  points: env.rateLimit.loginPer15Min,
  duration: 15 * 60,
});

// Every fresh account is dropped into a shared "general" channel so any two
// newly registered users already have somewhere to talk without extra setup.
async function ensureGeneralChannel() {
  const { rows } = await pool.query("SELECT id FROM channels WHERE type = 'public' AND name = 'general' LIMIT 1");
  if (rows.length > 0) return rows[0].id;
  const id = uuidv4();
  await pool.query("INSERT INTO channels (id, name, type) VALUES ($1, 'general', 'public')", [id]);
  return id;
}

async function storeRefreshToken(userId, refreshToken) {
  const decoded = jwt.decode(refreshToken);
  const expiresAt = new Date(decoded.exp * 1000);
  await pool.query(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [uuidv4(), userId, hashToken(refreshToken), expiresAt]
  );
}

router.post('/register', asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await pool.query('SELECT 1 FROM users WHERE email = $1 OR username = $2', [email, username]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'Username or email already in use' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = uuidv4();
  const generalChannelId = await ensureGeneralChannel();

  const client = await pool.connect();
  let user;
  let accessToken;
  let refreshToken;
  try {
    await client.query('BEGIN');

    try {
      const { rows } = await client.query(
        `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, $4)
         RETURNING id, username, email, created_at AS "createdAt"`,
        [userId, username, email, passwordHash]
      );
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Username or email already in use' });
      }
      throw err;
    }

    await client.query(
      'INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [generalChannelId, user.id]
    );

    accessToken = signAccessToken(user);
    refreshToken = signRefreshToken(user);
    const decoded = jwt.decode(refreshToken);
    await client.query(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [uuidv4(), user.id, hashToken(refreshToken), new Date(decoded.exp * 1000)]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Let anyone already connected see the new teammate show up live.
  req.app.get('io')?.emit('user:new', { id: user.id, username: user.username });

  res.status(201).json({ user, accessToken, refreshToken });
}));

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await storeRefreshToken(user.id, refreshToken);

  res.json({
    user: { id: user.id, username: user.username, email: user.email },
    accessToken,
    refreshToken,
  });
}));

router.post('/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  const tokenHash = hashToken(refreshToken);
  const { rows } = await pool.query(
    'SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > now()',
    [payload.sub, tokenHash]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'Refresh token not recognized' });

  const { rows: userRows } = await pool.query('SELECT id, username, email FROM users WHERE id = $1', [payload.sub]);
  const user = userRows[0];
  if (!user) return res.status(401).json({ error: 'User no longer exists' });

  const accessToken = signAccessToken(user);
  res.json({ accessToken });
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)]);
  }
  res.json({ ok: true });
}));

module.exports = router;
