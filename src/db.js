const { Pool } = require('pg');

// 測試與本機試用：USE_PGLITE=1 時改用 PGlite（PostgreSQL 的 WASM 版），不需要安裝資料庫。
// PGlite 只有單一連線，所以這裡用一把鎖把「交易」與一般查詢排隊，行為上等同序列化的連線池。
// 正式環境（Railway）完全不會走到這一段。
function createPglitePool() {
  let ready = null;
  const getLite = () => {
    if (!ready) {
      ready = (async () => {
        const { PGlite } = await import('@electric-sql/pglite');
        const lite = new PGlite(process.env.PGLITE_DIR || undefined);
        await lite.waitReady;
        return lite;
      })();
    }
    return ready;
  };

  let inTransaction = false;
  let tail = Promise.resolve();
  const lock = () => {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const turn = tail.then(() => release);
    tail = tail.then(() => next);
    return turn;
  };

  const run = async (text, params) => {
    const lite = await getLite();
    // 沒有參數時走簡單協定（和 pg 一樣可以一次執行多個語句，migration 需要）。
    if (params === undefined) {
      const results = await lite.exec(text);
      const last = results[results.length - 1] ?? { rows: [] };
      return { rows: last.rows ?? [], rowCount: last.affectedRows ?? (last.rows ?? []).length };
    }
    const result = await lite.query(text, params);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  return {
    async query(text, params) {
      // 交易進行中時，程式裡的 pool.query（例如 createBooking 內部查設定）直接併入同一條連線，
      // 否則會卡在自己持有的鎖上。正式環境的 pg 連線池有多條連線，沒有這個問題。
      if (inTransaction) return run(text, params);
      const release = await lock();
      try { return await run(text, params); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      inTransaction = true;
      let released = false;
      return {
        query: (text, params) => run(text, params),
        release() { if (!released) { released = true; inTransaction = false; release(); } },
      };
    },
    async exec(sql) {
      const release = await lock();
      try { const lite = await getLite(); await lite.exec(sql); } finally { release(); }
    },
    on() {},
    async end() { if (ready) { const lite = await ready; await lite.close(); } },
  };
}

function createPgPool() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // 走 Railway 內部私有網路不需要 SSL（也不支援）；只有明確設定 PGSSL=require 才會啟用
    // （例如未來改成連到外部/需要 SSL 的 Postgres 時）
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => {
    console.error('[db] 未預期的連線錯誤', err);
  });
  return pool;
}

const pool = process.env.USE_PGLITE === '1' ? createPglitePool() : createPgPool();

module.exports = { pool };
