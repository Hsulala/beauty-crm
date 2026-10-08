const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

const withApp = (fn) => async () => { const app = await startApp(); try { await fn(app); } finally { await app.stop(); } };
const put = (app, body, who = 'owner') => app[who]('/api/admin/config', { method: 'PUT', body });

test('預設：兩個既有模組都開、店名與色調維持妍序原樣', withApp(async (app) => {
  const { status, json } = await app.owner('/api/admin/config');
  assert.equal(status, 200);
  assert.equal(json.modules.revenue.enabled, true);
  assert.equal(json.modules.skinRecord.enabled, true);
  assert.equal(json.brand.name, '妍序 Skin');
  assert.equal(json.brand.themeColor, null);
  assert.equal(json.canEdit, true);
}));

test('權限：未登入 401；操作人員可讀不可寫；只有管理者能改', withApp(async (app) => {
  assert.equal((await app.anon('/api/admin/config')).status, 401);
  const read = await app.staff('/api/admin/config');
  assert.equal(read.status, 200);
  assert.equal(read.json.canEdit, false);
  assert.equal((await put(app, { modules: { revenue: false } }, 'staff')).status, 403);
  assert.ok([401, 403].includes((await put(app, { modules: { revenue: false } }, 'anon')).status));
  assert.equal((await app.staff('/api/admin/config/audit')).status, 403);
  assert.equal((await app.owner('/api/admin/config')).json.modules.revenue.enabled, true);
}));

test('只改有帶的欄位：關營收不影響皮膚紀錄與品牌，改店名不影響主題色與模組', withApp(async (app) => {
  await put(app, { brand: { name: '某某店', themeColor: '#336699' } });
  const off = await put(app, { modules: { revenue: false } });
  assert.equal(off.status, 200);
  assert.equal(off.json.modules.revenue, false);
  assert.equal(off.json.modules.skinRecord, true);
  assert.equal(off.json.brand.name, '某某店');
  assert.equal(off.json.brand.themeColor, '#336699');

  const renamed = await put(app, { brand: { name: '新店名' } });
  assert.equal(renamed.json.brand.themeColor, '#336699');
  assert.equal(renamed.json.modules.revenue, false);
}));

test('不覆蓋：資料庫裡其他 key 與未知的模組欄位更新後仍在', withApp(async (app) => {
  await app.pool.query(`INSERT INTO store_config (key, value) VALUES ('custom', '{"keep":1}'::jsonb)`);
  await app.pool.query(`INSERT INTO store_config (key, value) VALUES ('modules', '{"futureModule":true,"revenue":true}'::jsonb)`);
  await put(app, { modules: { skinRecord: false } });
  const rows = Object.fromEntries((await app.pool.query('SELECT key, value FROM store_config')).rows.map((r) => [r.key, r.value]));
  assert.deepEqual(rows.custom, { keep: 1 });
  assert.equal(rows.modules.futureModule, true);
  assert.equal(rows.modules.revenue, true);
  assert.equal(rows.modules.skinRecord, false);
}));

test('不合格的設定整筆被擋，原設定不變，也不留紀錄', withApp(async (app) => {
  const cases = [
    { modules: { nope: true } },
    { modules: { revenue: 'yes' } },
    { modules: [] },
    { brand: { name: '' } },
    { brand: { name: 'x'.repeat(31) } },
    { brand: { themeColor: 'red' } },
    { brand: { logo: 'x' } },
    { surprise: 1 },
  ];
  for (const body of cases) {
    const result = await put(app, body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.ok(result.json.fields);
  }
  // 一個合法、一個不合法：整筆不寫入
  assert.equal((await put(app, { modules: { revenue: false }, brand: { themeColor: 'bad' } })).status, 400);
  assert.equal((await app.owner('/api/admin/config')).json.modules.revenue.enabled, true);
  assert.equal((await app.pool.query('SELECT count(*)::int AS n FROM config_audit')).rows[0].n, 0);
}));

test('主題色可清除回預設；大小寫統一為小寫', withApp(async (app) => {
  assert.equal((await put(app, { brand: { themeColor: '#AABBCC' } })).json.brand.themeColor, '#aabbcc');
  assert.equal((await put(app, { brand: { themeColor: null } })).json.brand.themeColor, null);
}));

test('異動紀錄：只記有變動的項目、記操作者；值沒變就不留紀錄', withApp(async (app) => {
  await put(app, { modules: { revenue: false, skinRecord: true } });
  const same = await put(app, { modules: { revenue: false } });
  assert.equal(same.json.changed, false);
  const { json } = await app.owner('/api/admin/config/audit');
  assert.equal(json.entries.length, 1);
  assert.equal(json.entries[0].actor, 'boss');
  assert.deepEqual(Object.keys(json.entries[0].changes), ['modules.revenue']);
  assert.deepEqual(json.entries[0].changes['modules.revenue'], { from: true, to: false });
}));

test('migration：重複執行不會重跑，也不會動到已存的設定', withApp(async (app) => {
  await put(app, { modules: { revenue: false } });
  const { runMigrations } = require('../src/migrate');
  assert.deepEqual(await runMigrations(app.pool), []);
  assert.equal((await app.owner('/api/admin/config')).json.modules.revenue.enabled, false);
}));
