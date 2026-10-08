const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

test('冒煙：schema 與 migration 在 PGlite 上可以套用，登入可用', async () => {
  const app = await startApp();
  try {
    const tables = (await app.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
    for (const name of ['bookings', 'services', 'store_config', 'config_audit', 'schema_migrations']) assert.ok(tables.includes(name), name);
    const session = await app.owner('/api/admin/session');
    assert.equal(session.json.role, 'owner');
    assert.equal((await app.staff('/api/admin/session')).json.role, 'staff');
  } finally { await app.stop(); }
});
