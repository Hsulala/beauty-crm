import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 依檔名順序執行 migrations/*.sql，已執行過的會記在 schema_migrations，不會重跑。
export async function migrate(db, dir) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  const ran = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    });
    ran.push(file);
  }
  return ran;
}
