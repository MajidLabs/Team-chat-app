const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema applied successfully');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
