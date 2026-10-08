import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers/app.js';

const withApp = async (fn) => {
  const app = await startApp();
  try { await app.login(); await fn(app); } finally { await app.stop(); }
};

test('新增店家：只填店名也行，其餘用預設值', () => withApp(async (app) => {
  const result = await app.request('/api/stores', { method: 'POST', body: { name: '某某店' } });
  assert.equal(result.status, 201);
  assert.equal(result.json.name, '某某店');
  assert.equal(result.json.status, 'building');
  assert.equal(result.json.monthly_fee, 0);
  assert.equal(result.json.system_type, 'other');
  assert.equal(result.json.contract_end, null);
  assert.equal(result.json.contract.state, 'none');
}));

test('新增店家：完整資料原樣保存，日期不會因時區位移', () => withApp(async (app) => {
  const body = { name: '禾域 HEYU', system_type: 'heyu', url: 'https://heyu.example', status: 'running', monthly_fee: 1000, contract_start: '2026-01-01', contract_end: '2026-12-31', notes: '第一行\n第二行' };
  const created = await app.request('/api/stores', { method: 'POST', body });
  assert.equal(created.status, 201);
  const list = await app.request('/api/stores');
  const store = list.json.stores[0];
  for (const [key, value] of Object.entries(body)) assert.equal(store[key], value, key);
  assert.equal(list.json.today, '2026-10-08');
}));

test('新增店家：不合格的資料逐欄回報錯誤', () => withApp(async (app) => {
  const result = await app.request('/api/stores', { method: 'POST', body: { name: '', url: 'javascript:alert(1)', monthly_fee: -5, contract_start: '2026-02-30', status: 'bogus' } });
  assert.equal(result.status, 400);
  for (const key of ['name', 'url', 'monthly_fee', 'contract_start', 'status']) assert.ok(result.json.fields[key], key);
  assert.equal((await app.request('/api/stores')).json.stores.length, 0);
}));

test('新增店家：到期日早於起日被擋', () => withApp(async (app) => {
  const result = await app.request('/api/stores', { method: 'POST', body: { name: 'A', contract_start: '2026-05-01', contract_end: '2026-04-01' } });
  assert.equal(result.status, 400);
  assert.ok(result.json.fields.contract_end);
}));

test('新增店家：店名不分大小寫不可重複', () => withApp(async (app) => {
  assert.equal((await app.request('/api/stores', { method: 'POST', body: { name: 'Glow Spa' } })).status, 201);
  const dup = await app.request('/api/stores', { method: 'POST', body: { name: 'glow spa' } });
  assert.equal(dup.status, 409);
  assert.ok(dup.json.fields.name);
}));

test('請求內容不是合法 JSON 時回 400，不會當機', () => withApp(async (app) => {
  const response = await fetch(`${app.base}/api/stores`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: app.getCookie() }, body: '{壞掉' });
  assert.equal(response.status, 400);
  assert.equal((await app.request('/api/stores')).status, 200);
}));

test('修改店家：只改有帶的欄位，其他設定維持原樣', () => withApp(async (app) => {
  const created = (await app.request('/api/stores', { method: 'POST', body: { name: 'A 店', system_type: 'skin', url: 'https://a.example', status: 'running', monthly_fee: 1000, contract_start: '2026-01-01', contract_end: '2026-12-31', notes: '原本的備註' } })).json;
  const patched = await app.request(`/api/stores/${created.id}`, { method: 'PATCH', body: { monthly_fee: 1200 } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.monthly_fee, 1200);
  for (const key of ['name', 'system_type', 'url', 'status', 'contract_start', 'contract_end', 'notes']) assert.equal(patched.json[key], created[key], `不該被改動：${key}`);
}));

test('修改店家：可清空到期日與網址，改狀態與店名', () => withApp(async (app) => {
  const created = (await app.request('/api/stores', { method: 'POST', body: { name: 'B 店', url: 'https://b.example', contract_end: '2026-12-31' } })).json;
  const patched = await app.request(`/api/stores/${created.id}`, { method: 'PATCH', body: { contract_end: null, url: '', status: 'paused', name: 'B 店（新名）' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.contract_end, null);
  assert.equal(patched.json.url, '');
  assert.equal(patched.json.status, 'paused');
  assert.equal(patched.json.name, 'B 店（新名）');
}));

test('修改店家：與資料庫現有的起日衝突、店名撞名、欄位不合格都被擋，且原資料不變', () => withApp(async (app) => {
  const a = (await app.request('/api/stores', { method: 'POST', body: { name: 'A', contract_start: '2026-05-01', contract_end: '2026-09-01' } })).json;
  await app.request('/api/stores', { method: 'POST', body: { name: 'B' } });
  assert.equal((await app.request(`/api/stores/${a.id}`, { method: 'PATCH', body: { contract_end: '2026-04-01' } })).status, 400);
  assert.equal((await app.request(`/api/stores/${a.id}`, { method: 'PATCH', body: { name: 'b' } })).status, 409);
  assert.equal((await app.request(`/api/stores/${a.id}`, { method: 'PATCH', body: { monthly_fee: 'abc' } })).status, 400);
  const now = (await app.request('/api/stores')).json.stores.find((s) => s.id === a.id);
  assert.equal(now.name, 'A');
  assert.equal(now.contract_end, '2026-09-01');
}));

test('修改或刪除不存在的店家、非數字編號：404', () => withApp(async (app) => {
  assert.equal((await app.request('/api/stores/999', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  assert.equal((await app.request('/api/stores/999', { method: 'DELETE' })).status, 404);
  assert.equal((await app.request('/api/stores/abc', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  assert.equal((await app.request('/api/stores/1;drop', { method: 'DELETE' })).status, 404);
  assert.equal((await app.request('/api/nope')).status, 404);
}));

test('刪除店家後清單不再出現', () => withApp(async (app) => {
  const a = (await app.request('/api/stores', { method: 'POST', body: { name: 'A' } })).json;
  assert.equal((await app.request(`/api/stores/${a.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.request('/api/stores')).json.stores.length, 0);
}));

test('清單排序：運作中、建置中、暫停、已結束，同狀態依店名', () => withApp(async (app) => {
  for (const [name, status] of [['丙', 'ended'], ['乙', 'running'], ['甲', 'running'], ['丁', 'paused'], ['戊', 'building']]) {
    await app.request('/api/stores', { method: 'POST', body: { name, status } });
  }
  const names = (await app.request('/api/stores')).json.stores.map((s) => s.name);
  assert.equal(new Set(names).size, 5);
  assert.deepEqual(names.slice(2), ['戊', '丁', '丙']);
}));

test('備註含 HTML 字元時原樣保存（前端以文字顯示，不會執行）', () => withApp(async (app) => {
  const notes = '<img src=x onerror=alert(1)> & "引號"';
  const created = (await app.request('/api/stores', { method: 'POST', body: { name: 'X', notes } })).json;
  assert.equal(created.notes, notes);
}));
