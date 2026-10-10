import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { startApp } from './helpers/app.js';

// 1×1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const put = (app, id, body, type = 'image/png') => fetch(`${app.base}/api/stores/${id}/icon`, { method: 'PUT', headers: { 'content-type': type, cookie: app.getCookie() }, body });

test('店家小圖示：上傳、列表帶版本、讀取、移除，且留異動紀錄（不含圖片）', async () => {
  const app = await startApp();
  try {
    await app.login();
    const store = (await app.request('/api/stores', { method: 'POST', body: { name: '圖示店' } })).json;
    assert.equal((await app.request('/api/stores')).json.stores[0].icon_v, null);
    assert.equal((await put(app, store.id, Buffer.from('not a png'))).status, 400);
    assert.equal((await put(app, store.id, PNG)).status, 200);
    const listed = (await app.request('/api/stores')).json.stores[0];
    assert.ok(listed.icon_v);
    const img = await fetch(`${app.base}/api/stores/${store.id}/icon?v=${listed.icon_v}`, { headers: { cookie: app.getCookie() } });
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
    // 未登入看不到
    assert.equal((await fetch(`${app.base}/api/stores/${store.id}/icon`)).status, 401);
    assert.equal((await app.request(`/api/stores/${store.id}/icon`, { method: 'DELETE' })).json.removed, true);
    assert.equal((await app.request('/api/stores')).json.stores[0].icon_v, null);
    const log = (await app.request('/api/audit')).json.entries.filter((e) => e.action === 'store.icon');
    assert.deepEqual(log.map((e) => e.detail.how), ['remove', 'upload']);
    assert.ok(!JSON.stringify(log).includes('iVBOR'));
  } finally { await app.stop(); }
});

test('店家小圖示：從店家網站抓 /apple-touch-icon.png，只收 PNG、不跟隨轉址', async () => {
  let mode = 'png';
  const site = createServer((req, res) => {
    if (req.url !== '/apple-touch-icon.png') { res.writeHead(404); return res.end(); }
    if (mode === 'redirect') { res.writeHead(302, { location: 'https://evil.example/x.png' }); return res.end(); }
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html></html>'); }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const app = await startApp();
  try {
    await app.login();
    const noUrl = (await app.request('/api/stores', { method: 'POST', body: { name: '沒網址' } })).json;
    assert.equal((await app.request(`/api/stores/${noUrl.id}/icon/fetch`, { method: 'POST' })).status, 400);
    const store = (await app.request('/api/stores', { method: 'POST', body: { name: '有網址', url: `http://127.0.0.1:${site.address().port}` } })).json;
    assert.equal((await app.request(`/api/stores/${store.id}/icon/fetch`, { method: 'POST' })).status, 200);
    mode = 'html';
    assert.equal((await app.request(`/api/stores/${store.id}/icon/fetch`, { method: 'POST' })).status, 400);
    mode = 'redirect';
    assert.notEqual((await app.request(`/api/stores/${store.id}/icon/fetch`, { method: 'POST' })).status, 200);
  } finally { await app.stop(); site.close(); }
});
