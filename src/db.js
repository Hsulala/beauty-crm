import pg from 'pg';

// 兩種實作共用同一組介面：query / exec / tx / close。
// 正式環境用 pg 連 PostgreSQL；測試與本機試用用 PGlite（PostgreSQL 的 WASM 版）。

export function createPgDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const wrap = (client) => ({
    async query(text, params = []) {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    async exec(sql) { await client.query(sql); },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* 連線已斷就算了 */ }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export async function createPgliteDb(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  await lite.waitReady;
  const wrap = (client) => ({
    async query(text, params = []) {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async exec(sql) { await client.exec(sql); },
  });
  return {
    ...wrap(lite),
    tx: (fn) => lite.transaction((tx) => fn(wrap(tx))),
    close: () => lite.close(),
  };
}
