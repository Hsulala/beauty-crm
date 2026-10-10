import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers/app.js';
import { parseType } from '../src/validate.js';

const withApp = async (fn) => {
  const app = await startApp();
  try { await app.login(); await fn(app); } finally { await app.stop(); }
};

test('遷移後預設有預約型、訂購型、會員場館型、其他', () => withApp(async (app) => {
  const { json } = await app.request('/api/types');
  assert.deepEqual(json.types.map((type) => type.key), ['booking', 'order', 'membership', 'other']);
  const booking = json.types.find((type) => type.key === 'booking');
  assert.equal(booking.remote_supported, true);
  assert.equal(json.types.find((type) => type.key === 'membership').remote_supported, false);
}));

test('舊的以店名當類型（heyu、skin）的店家，遷移後併入預約型', async () => {
  const { createPgliteDb } = await import('../src/db.js');
  const { migrate } = await import('../src/migrate.js');
  const { MIGRATIONS } = await import('./helpers/app.js');
  const { mkdtempSync, copyFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  // 先只套用 003 之前的 migration，塞舊資料，再套用 003。
  const before = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const file of readdirSync(MIGRATIONS).filter((name) => name < '003')) copyFileSync(join(MIGRATIONS, file), join(before, file));
  const db = await createPgliteDb();
  try {
    await migrate(db, before);
    await db.query("INSERT INTO stores (name, system_type) VALUES ('禾域', 'heyu'), ('妍序', 'skin'), ('戀鳳爪', 'order'), ('雜項', 'other')");
    await migrate(db, MIGRATIONS);
    const { rows } = await db.query('SELECT name, system_type FROM stores ORDER BY name');
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.system_type]));
    assert.deepEqual(byName, { 禾域: 'booking', 妍序: 'booking', 戀鳳爪: 'order', 雜項: 'other' });
    await assert.rejects(db.query("INSERT INTO stores (name, system_type) VALUES ('壞資料', 'nope')"));
  } finally { await db.close(); }
});

test('驗證：代碼格式、名稱必填、修改時不可改代碼', () => {
  assert.ok(parseType({ key: 'Bad Key', label: 'x' }, { partial: false }).errors.key);
  assert.ok(parseType({ key: 'ok_key' }, { partial: false }).errors.label);
  assert.ok(parseType({ key: 'ok_key', label: 'x', remote_supported: 'yes' }, { partial: false }).errors.remote_supported);
  assert.ok(parseType({ key: 'ok_key', label: 'x', extra: 1 }, { partial: false }).errors.extra);
  assert.ok(parseType({ key: 'new_key' }, { partial: true }).errors.key);
  const ok = parseType({ key: 'ok_key', label: ' 新類型 ' }, { partial: false });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value, { key: 'ok_key', label: '新類型', description: '', repo: '', remote_supported: false, sort_order: 50 });
});

test('新增、修改、刪除類型，都會留下異動紀錄', () => withApp(async (app) => {
  const created = await app.request('/api/types', { method: 'POST', body: { key: 'retail', label: '零售型', description: '實體商品', remote_supported: false } });
  assert.equal(created.status, 201);
  assert.equal(created.json.store_count, 0);

  const patched = await app.request('/api/types/retail', { method: 'PATCH', body: { label: '零售電商型', remote_supported: true } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.label, '零售電商型');
  assert.equal(patched.json.remote_supported, true);
  assert.equal(patched.json.description, '實體商品', '沒帶的欄位維持原值');

  const noop = await app.request('/api/types/retail', { method: 'PATCH', body: { label: '零售電商型' } });
  assert.equal(noop.status, 200);

  assert.equal((await app.request('/api/types/retail', { method: 'DELETE' })).status, 200);
  const actions = (await app.request('/api/audit')).json.entries.map((entry) => entry.action);
  assert.deepEqual(actions.filter((action) => action.startsWith('type.')), ['type.delete', 'type.update', 'type.create']);
}));

test('類型：代碼或名稱重複被擋、代碼不能改、找不到回 404', () => withApp(async (app) => {
  assert.equal((await app.request('/api/types', { method: 'POST', body: { key: 'booking', label: '別的名字' } })).status, 409);
  assert.equal((await app.request('/api/types', { method: 'POST', body: { key: 'another', label: '預約型' } })).status, 409);
  assert.equal((await app.request('/api/types/booking', { method: 'PATCH', body: { key: 'renamed' } })).status, 400);
  assert.equal((await app.request('/api/types/booking', { method: 'PATCH', body: { label: '訂購型' } })).status, 409);
  assert.equal((await app.request('/api/types/nope', { method: 'PATCH', body: { label: 'x' } })).status, 404);
  assert.equal((await app.request('/api/types/nope', { method: 'DELETE' })).status, 404);
}));

test('刪除類型：「其他」不能刪、還有店家使用時不能刪，清空後才能刪', () => withApp(async (app) => {
  assert.equal((await app.request('/api/types/other', { method: 'DELETE' })).status, 409);
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: '戀鳳爪', system_type: 'order' } })).json;
  const blocked = await app.request('/api/types/order', { method: 'DELETE' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /1 家店/);
  await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { system_type: 'other' } });
  assert.equal((await app.request('/api/types/order', { method: 'DELETE' })).status, 200);
}));

test('列表：每個類型帶出使用它的店家', () => withApp(async (app) => {
  await app.request('/api/stores', { method: 'POST', body: { name: '禾域 HEYU', system_type: 'booking', status: 'running' } });
  await app.request('/api/stores', { method: 'POST', body: { name: '妍序 Skin', system_type: 'booking', status: 'running' } });
  await app.request('/api/stores', { method: 'POST', body: { name: '戀鳳爪', system_type: 'order' } });
  const { types } = (await app.request('/api/types')).json;
  const booking = types.find((type) => type.key === 'booking');
  assert.equal(booking.store_count, 2);
  assert.deepEqual(booking.stores.map((store) => store.name).sort(), ['妍序 Skin', '禾域 HEYU']);
  assert.equal(types.find((type) => type.key === 'order').store_count, 1);
  assert.equal(types.find((type) => type.key === 'membership').store_count, 0);
}));

test('店家：類型必須存在；新建的類型馬上能用，改類型留下紀錄', () => withApp(async (app) => {
  const bad = await app.request('/api/stores', { method: 'POST', body: { name: 'X', system_type: 'ghost' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.system_type);

  await app.request('/api/types', { method: 'POST', body: { key: 'retail', label: '零售型' } });
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'Y', system_type: 'retail' } })).json;
  assert.equal(store.system_type, 'retail');

  const badPatch = await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { system_type: 'ghost' } });
  assert.equal(badPatch.status, 400);

  await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { system_type: 'order' } });
  const entry = (await app.request('/api/audit')).json.entries.find((item) => item.action === 'store.update');
  assert.deepEqual(entry.detail.changes.system_type, { from: 'retail', to: 'order' });
}));

test('遠端管理是否可用，由類型的 remote_supported 決定', () => withApp(async (app) => {
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'Z', system_type: 'membership', url: 'https://z.example' } })).json;
  assert.equal((await app.request(`/api/stores/${store.id}/remote`)).json.supported, false);
  await app.request('/api/types/membership', { method: 'PATCH', body: { remote_supported: true } });
  assert.equal((await app.request(`/api/stores/${store.id}/remote`)).json.supported, true);
}));

test('畫面：有類型分頁與類型表單，店家表單的系統選單由資料帶入', () => withApp(async (app) => {
  const html = (await app.request('/')).text;
  for (const id of ['view-types', 'type-list', 'type-dialog', 'add-type-btn']) assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  for (const key of ['key', 'label', 'description', 'repo', 'remote_supported', 'sort_order']) assert.ok(html.includes(`name="${key}"`), `類型表單缺少欄位 ${key}`);
  assert.ok(!html.includes('value="heyu"'), '選單不該再寫死店名');
}));
