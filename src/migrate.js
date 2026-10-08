const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// 只套用「編號開頭」的 migration（001_xxx.sql、002_xxx.sql ...），每個檔案只會跑一次。
// migrations/schema.sql 是最早期的整包建表檔，內含種子資料，重跑可能產生重複資料，
// 所以不在這裡自動執行，維持原本「第一次部署手動跑 scripts/migrate.js」的用法。
async function runMigrations(pool, dir = MIGRATIONS_DIR) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const files = fs.readdirSync(dir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  const ran = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* 連線已斷就算了 */ }
      throw new Error(`migration ${file} 失敗：${error.message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

module.exports = { runMigrations, MIGRATIONS_DIR };
