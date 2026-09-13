const express = require('express');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const presenceService = require('../services/presence.service');

const router = express.Router();
router.use(authenticate);

router.get('/me', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, username, email, avatar_url AS "avatarUrl", created_at AS "createdAt"
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  res.json(rows[0]);
}));

router.get('/', asyncHandler(async (req, res) => {
  const search = req.query.q ? `%${req.query.q}%` : '%';
  const { rows } = await pool.query(
    'SELECT id, username, avatar_url AS "avatarUrl" FROM users WHERE username ILIKE $1 ORDER BY username LIMIT 50',
    [search]
  );
  const statuses = await presenceService.getStatuses(rows.map((u) => u.id));
  res.json(rows.map((u) => ({ ...u, status: statuses[u.id] || 'offline' })));
}));

module.exports = router;
