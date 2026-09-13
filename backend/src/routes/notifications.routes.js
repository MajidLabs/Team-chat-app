const express = require('express');
const pool = require('../config/db');
const authenticate = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, type, payload, is_read AS "isRead", created_at AS "createdAt"
     FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
}));

router.post('/:id/read', asyncHandler(async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false', [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
