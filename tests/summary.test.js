import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers/app.js';

const withApp = async (fn) => {
  const app = await startApp();
  try { await app.login(); await fn(app); } finally { await app.stop(); }
};
const add = (app, body) => app.request('/api/stores', { method: 'POST', body });

test('總覽：每月收入只計運作中，各狀態家數正確', () => withApp(async (app) => {
  await add(app, { name: 'A', status: 'running', monthly_fee: 1000 });
  await add(app, { name: 'B', status: 'running', monthly_fee: 1500 });
  await add(app, { name: 'C', status: 'building', monthly_fee: 1000 });
  await add(app, { name: 'D', status: 'paused', monthly_fee: 1000 });
  await add(app, { name: 'E', status: 'ended', monthly_fee: 1000 });
  const { json } = await app.request('/api/summary');
  assert.equal(json.mrr, 2500);
  assert.deepEqual(json.counts, { building: 1, running: 2, paused: 1, ended: 1, total: 5 });
  assert.equal(json.today, '2026-10-08');
}));

test('總覽：沒有店家時全為 0', () => withApp(async (app) => {
  const { json } = await app.request('/api/summary');
  assert.equal(json.mrr, 0);
  assert.equal(json.counts.total, 0);
  assert.equal(json.expiringSoon, 0);
  assert.deepEqual(json.attention, []);
}));

test('合約到期：以台北日期計算，30 天內算即將到期，已結束的店家不列入提醒', () => withApp(async (app) => {
  await add(app, { name: '過期', status: 'running', contract_end: '2026-10-07' });
  await add(app, { name: '今天', status: 'running', contract_end: '2026-10-08' });
  await add(app, { name: '三十天', status: 'running', contract_end: '2026-11-07' });
  await add(app, { name: '三十一天', status: 'running', contract_end: '2026-11-08' });
  await add(app, { name: '沒設定', status: 'running' });
  await add(app, { name: '已結束過期', status: 'ended', contract_end: '2026-01-01' });
  const { json } = await app.request('/api/summary');
  assert.equal(json.expired, 1);
  assert.equal(json.expiringSoon, 2);
  assert.deepEqual(json.attention.map((item) => item.name), ['過期', '今天', '三十天']);
  assert.deepEqual(json.attention.map((item) => item.daysLeft), [-1, 0, 30]);

  const stores = (await app.request('/api/stores')).json.stores;
  const state = (name) => stores.find((s) => s.name === name).contract.state;
  assert.equal(state('過期'), 'expired');
  assert.equal(state('三十一天'), 'ok');
  assert.equal(state('沒設定'), 'none');
  assert.equal(state('已結束過期'), 'ended');
}));

test('台北跨日：UTC 還是前一天，台北已是隔天，到期日「今天」應算 0 天', async () => {
  const app = await startApp();
  try {
    await app.login();
    app.clock.ms = Date.parse('2026-10-07T17:00:00Z');
    await add(app, { name: 'A', status: 'running', contract_end: '2026-10-08' });
    const store = (await app.request('/api/stores')).json.stores[0];
    assert.equal(store.contract.daysLeft, 0);
    assert.equal(store.contract.state, 'soon');
  } finally { await app.stop(); }
});
