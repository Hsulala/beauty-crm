// 測試用：以 PGlite 起一個完整的妍序 app（真的 schema、真的 migration、真的路由）。
process.env.USE_PGLITE = '1';
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
process.env.LINE_CHANNEL_SECRET = 'test-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-line-token';
delete process.env.DATABASE_URL;
delete process.env.PGLITE_DIR;

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

function freshModules() {
  // 每個測試檔各自一份全新的資料庫與 app：清掉 require 快取再載入。
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(root, 'src'))) delete require.cache[key];
  }
  return {
    db: require(path.join(root, 'src', 'db')),
    migrate: require(path.join(root, 'src', 'migrate')),
    auth: require(path.join(root, 'src', 'authUtil')),
    appModule: require(path.join(root, 'src', 'app')),
  };
}

async function startApp() {
  const { db, migrate, auth, appModule } = freshModules();
  const { pool } = db;
  // 與正式環境相同的順序：先有最早期的整包 schema，再套用編號 migration。
  await pool.exec(fs.readFileSync(path.join(root, 'migrations', 'schema.sql'), 'utf8'));
  await migrate.runMigrations(pool);

  const password = 'test-password-123';
  for (const [username, role] of [['boss', 'owner'], ['helper', 'staff']]) {
    await pool.query(
      `INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash`,
      [username, auth.hashPassword(password), role],
    );
  }

  const server = await new Promise((resolve) => { const s = appModule.createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = (cookie = '') => {
    const state = { cookie };
    const request = async (url, { method = 'GET', body } = {}) => {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(state.cookie ? { cookie: state.cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookies = response.headers.getSetCookie?.() ?? [];
      if (setCookies.length) state.cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
      return { status: response.status, json, text };
    };
    return { request, login: (username) => request('/api/admin/login', { method: 'POST', body: { username, password } }) };
  };

  const owner = client(); await owner.login('boss');
  const staff = client(); await staff.login('helper');
  const stop = async () => { await new Promise((resolve) => server.close(resolve)); await pool.end(); };
  return { pool, base, client, owner: owner.request, staff: staff.request, anon: client().request, stop, services: { booking: require(path.join(root, 'src', 'services', 'bookingService')) } };
}

module.exports = { startApp };
