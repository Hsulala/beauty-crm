import assert from 'node:assert/strict';
import test from 'node:test';
import { PASSWORD, startApp } from './helpers/app.js';

test('未登入不能讀寫任何 API，健康檢查與登入頁除外', async () => {
  const app = await startApp();
  try {
    for (const [method, path] of [['GET', '/api/stores'], ['GET', '/api/summary'], ['GET', '/api/audit'], ['GET', '/api/me'], ['POST', '/api/stores'], ['PATCH', '/api/stores/1'], ['DELETE', '/api/stores/1']]) {
      const result = await app.request(path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {}, auth: false });
      assert.equal(result.status, 401, `${method} ${path}`);
    }
    assert.equal((await app.request('/healthz', { auth: false })).status, 200);
    assert.equal((await app.request('/login.html', { auth: false })).status, 200);
    assert.equal((await app.request('/', { auth: false })).status, 200);
  } finally { await app.stop(); }
});

test('登入：密碼錯誤 401，正確則發出 HttpOnly Cookie', async () => {
  const app = await startApp();
  try {
    const wrong = await app.login('wrong-password-1');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const empty = await app.request('/api/login', { method: 'POST', body: {}, auth: false });
    assert.equal(empty.status, 401);

    const ok = await app.login(PASSWORD);
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal((await app.request('/api/me')).status, 200);
  } finally { await app.stop(); }
});

test('登出會清掉 Cookie；竄改或過期的 Cookie 都無效', async () => {
  const app = await startApp();
  try {
    await app.login();
    const real = app.getCookie();
    const logout = await app.request('/api/logout', { method: 'POST' });
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

    app.setCookie(`${real}x`);
    assert.equal((await app.request('/api/me')).status, 401);
    app.setCookie(real);
    assert.equal((await app.request('/api/me')).status, 200);
    app.clock.ms += 8 * 24 * 3600 * 1000;
    assert.equal((await app.request('/api/me')).status, 401);
  } finally { await app.stop(); }
});

test('連續輸錯 10 次會被暫時封鎖，之後即使密碼正確也要等', async () => {
  const app = await startApp();
  try {
    for (let i = 0; i < 10; i += 1) assert.equal((await app.login('wrong-password-1')).status, 401);
    assert.equal((await app.login(PASSWORD)).status, 429);
    app.clock.ms += 6 * 60_000;
    assert.equal((await app.login(PASSWORD)).status, 200);
  } finally { await app.stop(); }
});

test('跨站來源的寫入請求會被擋，同站來源可以', async () => {
  const app = await startApp();
  try {
    await app.login();
    const host = new URL(app.base).host;
    const foreign = await app.request('/api/stores', { method: 'POST', body: { name: '外來' }, headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
    const same = await app.request('/api/stores', { method: 'POST', body: { name: '同站' }, headers: { origin: `http://${host}` } });
    assert.equal(same.status, 201);
  } finally { await app.stop(); }
});

test('回應帶有安全標頭，API 不快取', async () => {
  const app = await startApp();
  try {
    await app.login();
    const api = await app.request('/api/stores');
    assert.equal(api.headers.get('cache-control'), 'no-store');
    assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
    assert.match(api.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(api.headers.get('x-powered-by'), null);
  } finally { await app.stop(); }
});
