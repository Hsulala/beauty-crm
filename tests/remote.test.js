import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers/app.js';
import { READ_KEY, WRITE_KEY, startFakeStore } from './helpers/fake-store.js';
import { RemoteError, callStore, remoteUrl } from '../src/remote.js';
import { open, seal } from '../src/secretbox.js';

const SECRET = 'k'.repeat(40);

async function withRemote(fn, { overrides = { remoteKeySecret: SECRET }, system = 'heyu' } = {}) {
  const app = await startApp(overrides);
  const fake = await startFakeStore({ system });
  try {
    await app.login();
    const store = (await app.request('/api/stores', { method: 'POST', body: { name: '測試店', system_type: ['heyu', 'skin'].includes(system) ? 'booking' : system, url: fake.url } })).json;
    await fn({ app, fake, store, remote: (path, options) => app.request(`/api/stores/${store.id}/remote${path}`, options) });
  } finally { await fake.stop(); await app.stop(); }
}

test('金鑰加密：加解密來回一致，換密鑰或被竄改就解不開', () => {
  const sealed = seal(WRITE_KEY, SECRET);
  assert.ok(!sealed.includes(WRITE_KEY));
  assert.equal(open(sealed, SECRET), WRITE_KEY);
  assert.equal(open(sealed, 'j'.repeat(40)), null);
  assert.equal(open(`${sealed.slice(0, -2)}xx`, SECRET), null);
  assert.equal(open('garbage', SECRET), null);
  assert.notEqual(seal(WRITE_KEY, SECRET), seal(WRITE_KEY, SECRET));
});

test('呼叫店家：只往網址的 origin 送，正式環境必須 https，本機可 http', () => {
  assert.equal(remoteUrl('https://heyu.example/some/path?x=1', '/api/remote/stats'), 'https://heyu.example/api/remote/stats');
  assert.equal(remoteUrl('http://127.0.0.1:3000', '/api/remote/config'), 'http://127.0.0.1:3000/api/remote/config');
  assert.throws(() => remoteUrl('http://heyu.example', '/x'), RemoteError);
  assert.throws(() => remoteUrl('', '/x'), RemoteError);
});

test('呼叫店家：轉址不跟隨，逾時與連不上都轉成好懂的訊息，不含金鑰', async () => {
  const fake = await startFakeStore();
  try {
    fake.state.mode = 'redirect';
    await assert.rejects(callStore({ url: fake.url, key: READ_KEY, path: '/api/remote/config' }), /轉址/);
    fake.state.mode = 'down';
    await assert.rejects(callStore({ url: fake.url, key: READ_KEY, path: '/api/remote/config' }), /內部錯誤/);
  } finally { await fake.stop(); }
  await assert.rejects(callStore({ url: 'http://127.0.0.1:1', key: READ_KEY, path: '/x', timeoutMs: 500 }), (error) => error instanceof RemoteError && !error.message.includes(READ_KEY));
});

test('金鑰管理：存了之後不會回傳；資料庫裡是密文；異動紀錄不含金鑰', () => withRemote(async ({ app, remote, store }) => {
  assert.deepEqual((await remote('')).json, { available: true, supported: true, has_read_key: false, has_write_key: false });
  const saved = await remote('', { method: 'PUT', body: { read_key: READ_KEY, write_key: WRITE_KEY } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json, { has_read_key: true, has_write_key: true });
  assert.equal(saved.text.includes(READ_KEY) || saved.text.includes(WRITE_KEY), false);
  assert.equal((await remote('')).text.includes(WRITE_KEY), false);

  const raw = (await app.db.query('SELECT read_key_enc, write_key_enc FROM store_remote WHERE store_id = $1', [store.id])).rows[0];
  assert.ok(!raw.read_key_enc.includes(READ_KEY) && !raw.write_key_enc.includes(WRITE_KEY));
  assert.equal(open(raw.write_key_enc, SECRET), WRITE_KEY);

  const audit = (await app.request('/api/audit')).json;
  assert.equal(audit.entries[0].action, 'store.remote_keys');
  assert.deepEqual(audit.entries[0].detail, { read: 'set', write: 'set' });
  assert.equal(JSON.stringify(audit).includes(READ_KEY), false);
  assert.equal(JSON.stringify(audit).includes(WRITE_KEY), false);
}));

test('金鑰管理：只更新有帶的那把，null 清除，不合格被擋', () => withRemote(async ({ remote }) => {
  await remote('', { method: 'PUT', body: { read_key: READ_KEY, write_key: WRITE_KEY } });
  const cleared = await remote('', { method: 'PUT', body: { write_key: null } });
  assert.deepEqual(cleared.json, { has_read_key: true, has_write_key: false });
  for (const body of [{ read_key: 'short' }, { read_key: `${'a'.repeat(20)} ${'b'.repeat(20)}` }, { write_key: 123 }, { surprise: 1 }, {}, []]) {
    assert.equal((await remote('', { method: 'PUT', body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await remote('', { method: 'PUT', body: { write_key: READ_KEY } })).status, 400, '讀取與寫入金鑰不可相同');
  assert.equal((await remote('')).json.has_read_key, true);
}));

test('店家頁資料：用讀取金鑰取得本月預約數與模組狀態', () => withRemote(async ({ fake, remote }) => {
  await remote('', { method: 'PUT', body: { read_key: READ_KEY, write_key: WRITE_KEY } });
  const result = await remote('/overview?month=2026-10');
  assert.equal(result.status, 200);
  assert.equal(result.json.month, '2026-10');
  assert.equal(result.json.can_edit, true);
  assert.deepEqual(result.json.stats.data.bookings, { total: 7, cancelled: 1 });
  assert.equal(result.json.config.data.modules.schedule.enabled, false);
  assert.ok(fake.state.requests.every((entry) => entry.token === READ_KEY), '讀取只該用讀取金鑰');
  assert.equal((await remote('/overview')).json.month, '2026-10');
  assert.equal((await remote('/overview?month=2026-13')).status, 400);
}));

test('店家頁資料：只有寫入金鑰時也能讀；完全沒金鑰回 409', () => withRemote(async ({ remote }) => {
  assert.equal((await remote('/overview')).status, 409);
  await remote('', { method: 'PUT', body: { write_key: WRITE_KEY } });
  assert.equal((await remote('/overview')).status, 200);
}));

test('店家頁資料：店家系統連不上時，該段回錯誤訊息，不影響頁面', () => withRemote(async ({ fake, remote }) => {
  await remote('', { method: 'PUT', body: { read_key: READ_KEY } });
  fake.state.mode = 'down';
  const result = await remote('/overview');
  assert.equal(result.status, 200);
  assert.equal(result.json.stats.ok, false);
  assert.equal(result.json.config.ok, false);
  assert.equal(result.json.can_edit, false);
  assert.equal(result.text.includes(READ_KEY), false);
}));

test('店家頁資料：金鑰與店家不一致時顯示好懂的原因', () => withRemote(async ({ remote }) => {
  await remote('', { method: 'PUT', body: { read_key: 'x'.repeat(40) } });
  const result = await remote('/overview');
  assert.match(result.json.stats.error, /拒絕金鑰/);
}));

test('開關模組：用寫入金鑰、只送有帶的模組、有變動才留紀錄', () => withRemote(async ({ app, fake, remote }) => {
  await remote('', { method: 'PUT', body: { read_key: READ_KEY, write_key: WRITE_KEY } });
  const on = await remote('/modules', { method: 'PUT', body: { modules: { schedule: true } } });
  assert.equal(on.status, 200);
  assert.equal(on.json.changed, true);
  assert.equal(on.json.modules.schedule.enabled, true);
  assert.equal(on.json.modules.stats.enabled, true);
  const put = fake.state.requests.find((entry) => entry.method === 'PUT');
  assert.equal(put.token, WRITE_KEY);
  assert.deepEqual(put.body, { modules: { schedule: true } });

  const entry = (await app.request('/api/audit')).json.entries[0];
  assert.equal(entry.action, 'store.modules');
  assert.deepEqual(entry.detail.changes, { schedule: { label: '老師排班', from: false, to: true } });

  const same = await remote('/modules', { method: 'PUT', body: { modules: { schedule: true } } });
  assert.equal(same.json.changed, false);
  assert.equal((await app.request('/api/audit')).json.entries.filter((e) => e.action === 'store.modules').length, 1);
}));

test('開關模組：沒有寫入金鑰、格式錯誤、店家拒絕都不會留紀錄', () => withRemote(async ({ app, remote }) => {
  await remote('', { method: 'PUT', body: { read_key: READ_KEY } });
  assert.equal((await remote('/modules', { method: 'PUT', body: { modules: { schedule: true } } })).status, 409);
  await remote('', { method: 'PUT', body: { write_key: WRITE_KEY } });
  for (const body of [{}, { modules: [] }, { modules: {} }, { modules: { schedule: 'yes' } }]) {
    assert.equal((await remote('/modules', { method: 'PUT', body })).status, 400, JSON.stringify(body));
  }
  const unknown = await remote('/modules', { method: 'PUT', body: { modules: { nope: true } } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /沒有這個模組/);
  assert.equal((await app.request('/api/audit')).json.entries.filter((e) => e.action === 'store.modules').length, 0);
}));

test('未登入不能用任何遠端管理功能', () => withRemote(async ({ app, store }) => {
  for (const [method, path] of [['GET', ''], ['PUT', ''], ['GET', '/overview'], ['PUT', '/modules']]) {
    const result = await app.request(`/api/stores/${store.id}/remote${path}`, { method, body: method === 'PUT' ? {} : undefined, auth: false });
    assert.equal(result.status, 401, `${method} ${path}`);
  }
}));

test('不支援的系統類型與沒設加密密鑰：回清楚的錯誤', async () => {
  await withRemote(async ({ remote }) => {
    await remote('', { method: 'PUT', body: { read_key: READ_KEY } });
    assert.equal((await remote('/overview')).status, 400);
  }, { system: 'other' });
  await withRemote(async ({ remote }) => {
    assert.equal((await remote('')).json.available, false);
    assert.equal((await remote('', { method: 'PUT', body: { read_key: READ_KEY } })).status, 409);
    assert.equal((await remote('/overview')).status, 409);
  }, { overrides: {} });
});

test('刪除店家時金鑰一併刪除', () => withRemote(async ({ app, remote, store }) => {
  await remote('', { method: 'PUT', body: { read_key: READ_KEY } });
  await app.request(`/api/stores/${store.id}`, { method: 'DELETE' });
  assert.equal((await app.db.query('SELECT count(*)::int AS n FROM store_remote')).rows[0].n, 0);
}));
