import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers/app.js';

const withApp = async (fn) => {
  const app = await startApp();
  try { await app.login(); await fn(app); } finally { await app.stop(); }
};
const entries = async (app) => (await app.request('/api/audit')).json.entries;

test('異動紀錄：新增、修改、刪除各留一筆，最新的在前', () => withApp(async (app) => {
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'A 店', monthly_fee: 1000 } })).json;
  await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { monthly_fee: 1200 } });
  await app.request(`/api/stores/${store.id}`, { method: 'DELETE' });
  const log = await entries(app);
  assert.deepEqual(log.map((e) => e.action), ['store.delete', 'store.update', 'store.create']);
  assert.ok(log.every((e) => e.store_name === 'A 店'));
  assert.equal(log[1].detail.changes.monthly_fee.from, 1000);
  assert.equal(log[1].detail.changes.monthly_fee.to, 1200);
  assert.equal(log[0].detail.snapshot.name, 'A 店');
}));

test('異動紀錄：修改只記有變動的欄位；值沒變就不留紀錄也不更新時間', () => withApp(async (app) => {
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'A', status: 'running', monthly_fee: 1000, notes: 'x' } })).json;
  const same = await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { name: 'A', monthly_fee: 1000, notes: 'x' } });
  assert.equal(same.status, 200);
  assert.equal(same.json.updated_at, store.updated_at);
  assert.equal((await entries(app)).length, 1);

  await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { name: 'A', status: 'paused', monthly_fee: 1000 } });
  const [latest] = await entries(app);
  assert.deepEqual(Object.keys(latest.detail.changes), ['status']);
}));

test('異動紀錄：被擋下的請求不會留紀錄', () => withApp(async (app) => {
  await app.request('/api/stores', { method: 'POST', body: { name: '' } });
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'A' } })).json;
  await app.request(`/api/stores/${store.id}`, { method: 'PATCH', body: { monthly_fee: -1 } });
  assert.equal((await entries(app)).length, 1);
}));

test('異動紀錄：可限制筆數，上限 200', () => withApp(async (app) => {
  for (let i = 0; i < 5; i += 1) await app.request('/api/stores', { method: 'POST', body: { name: `店${i}` } });
  assert.equal((await app.request('/api/audit?limit=2')).json.entries.length, 2);
  assert.equal((await app.request('/api/audit?limit=abc')).json.entries.length, 5);
  assert.equal((await app.request('/api/audit?limit=99999')).json.entries.length, 5);
}));
