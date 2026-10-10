import assert from 'node:assert/strict';
import test from 'node:test';
import { startApp } from './helpers/app.js';

const withApp = async (fn) => {
  const app = await startApp();
  try { await app.login(); await fn(app); } finally { await app.stop(); }
};

const backup = (overrides = {}) => ({
  version: 3,
  items: [
    { id: 'a', title: '妍序 Skin', category: 'clients', description: '皮膚管理預約', tags: ['Railway', 'Node.js'], status: 'live', pinned: true,
      links: [{ label: '後台', url: 'https://skin.example/admin/' }, { label: 'Railway', url: 'https://railway.example/p/1' }], username: 'boss', password: 'secret-pass', note: '已上線' },
    { id: 'b', title: '公司規章', category: 'my-custom', status: 'pending', links: [{ label: '', url: 'https://docs.example/rules' }] },
    { id: 'c', title: '壞掉的', category: 'docs', links: [{ label: 'x', url: 'javascript:alert(1)' }] },
    { id: 'd', title: '沒有連結', category: 'docs', links: [] },
  ],
  categories: [{ id: 'my-custom', label: '內部文件' }],
  ...overrides,
});

test('連結：未登入不能讀寫', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.request('/api/links', { auth: false })).status, 401);
    assert.equal((await app.request('/api/links', { method: 'POST', body: { title: 'A', url: 'https://a.example' }, auth: false })).status, 401);
    assert.equal((await app.request('/api/links/import', { method: 'POST', body: backup(), auth: false })).status, 401);
  } finally { await app.stop(); }
});

test('新增連結：只填名稱與網址，其餘用預設值', () => withApp(async (app) => {
  const result = await app.request('/api/links', { method: 'POST', body: { title: 'GSC', url: 'https://search.google.com/search-console' } });
  assert.equal(result.status, 201);
  assert.equal(result.json.status, 'active');
  assert.equal(result.json.pinned, false);
  assert.equal(result.json.store_id, null);
  assert.equal(result.json.category, '');
  const list = await app.request('/api/links');
  assert.equal(list.json.links.length, 1);
}));

test('新增連結：不合格的資料逐欄回報', () => withApp(async (app) => {
  const result = await app.request('/api/links', { method: 'POST', body: { title: '', url: 'javascript:alert(1)', status: 'bogus', pinned: 'yes', store_id: 0 } });
  assert.equal(result.status, 400);
  for (const key of ['title', 'url', 'status', 'pinned', 'store_id']) assert.ok(result.json.fields[key], key);
  const missing = await app.request('/api/links', { method: 'POST', body: {} });
  assert.equal(missing.status, 400);
  assert.ok(missing.json.fields.title && missing.json.fields.url);
  assert.equal((await app.request('/api/links')).json.links.length, 0);
}));

test('新增連結：店家不存在被擋，存在則掛在該店', () => withApp(async (app) => {
  const bad = await app.request('/api/links', { method: 'POST', body: { title: 'A', url: 'https://a.example', store_id: 999 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.store_id);
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'A 店' } })).json;
  const ok = await app.request('/api/links', { method: 'POST', body: { title: 'A 店後台', url: 'https://a.example/admin', store_id: store.id } });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.store_id, store.id);
}));

test('修改連結：只改有帶的欄位，其餘維持原樣', () => withApp(async (app) => {
  const created = (await app.request('/api/links', { method: 'POST', body: { title: 'A', label: '後台', url: 'https://a.example', category: '客戶', description: '說明', pinned: true } })).json;
  const patched = await app.request(`/api/links/${created.id}`, { method: 'PATCH', body: { description: '新說明' } });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.description, '新說明');
  for (const key of ['title', 'label', 'url', 'category', 'pinned']) assert.equal(patched.json[key], created[key], key);
  assert.equal((await app.request(`/api/links/${created.id}`, { method: 'PATCH', body: {} })).json.title, 'A');
  assert.equal((await app.request('/api/links/9999', { method: 'PATCH', body: { title: 'x' } })).status, 404);
  assert.equal((await app.request(`/api/links/${created.id}`, { method: 'PATCH', body: { url: 'ftp://x' } })).status, 400);
  const unpinned = await app.request(`/api/links/${created.id}`, { method: 'PATCH', body: { pinned: false, store_id: null } });
  assert.equal(unpinned.json.pinned, false);
}));

test('刪除連結；刪除店家時連結保留、改成未歸屬', () => withApp(async (app) => {
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: 'B 店' } })).json;
  const link = (await app.request('/api/links', { method: 'POST', body: { title: 'B', url: 'https://b.example', store_id: store.id } })).json;
  assert.equal((await app.request(`/api/stores/${store.id}`, { method: 'DELETE' })).status, 200);
  const left = (await app.request('/api/links')).json.links;
  assert.equal(left.length, 1);
  assert.equal(left[0].store_id, null);
  assert.equal((await app.request(`/api/links/${link.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.request(`/api/links/${link.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await app.request('/api/links')).json.links.length, 0);
}));

test('匯入 Linkbase 備份：轉分類、對應店家、略過壞資料、不帶帳號密碼', () => withApp(async (app) => {
  const store = (await app.request('/api/stores', { method: 'POST', body: { name: '妍序 Skin' } })).json;
  const result = await app.request('/api/links/import', { method: 'POST', body: backup() });
  assert.equal(result.status, 200);
  assert.equal(result.json.imported, 3);
  assert.equal(result.json.duplicates, 0);
  assert.equal(result.json.with_credentials, 1);
  assert.deepEqual(result.json.invalid.sort(), ['壞掉的（x）', '沒有連結'].sort());

  const links = (await app.request('/api/links')).json.links;
  const skin = links.filter((link) => link.title === '妍序 Skin');
  assert.equal(skin.length, 2);
  assert.ok(skin.every((link) => link.store_id === store.id && link.category === '客戶專案' && link.pinned && link.tags === 'Railway, Node.js'));
  assert.deepEqual(skin.map((link) => link.label).sort(), ['Railway', '後台']);
  const docs = links.find((link) => link.title === '公司規章');
  assert.equal(docs.category, '內部文件');
  assert.equal(docs.status, 'pending');
  assert.equal(docs.store_id, null);
  assert.ok(!JSON.stringify(links).includes('secret-pass'));
  assert.ok(!JSON.stringify(links).includes('boss'));

  const audit = (await app.request('/api/audit')).json.entries;
  assert.equal(audit[0].action, 'links.import');
}));

test('匯入：重複匯入同一份備份不會多出資料，也不覆蓋手動修改', () => withApp(async (app) => {
  await app.request('/api/links/import', { method: 'POST', body: backup() });
  const first = (await app.request('/api/links')).json.links.find((link) => link.url === 'https://docs.example/rules');
  await app.request(`/api/links/${first.id}`, { method: 'PATCH', body: { description: '我改過' } });
  const again = await app.request('/api/links/import', { method: 'POST', body: backup() });
  assert.equal(again.json.imported, 0);
  assert.equal(again.json.duplicates, 3);
  const links = (await app.request('/api/links')).json.links;
  assert.equal(links.length, 3);
  assert.equal(links.find((link) => link.id === first.id).description, '我改過');
}));

test('匯入：格式不對或太多項目都會被擋', () => withApp(async (app) => {
  assert.equal((await app.request('/api/links/import', { method: 'POST', body: { foo: 1 } })).status, 400);
  assert.equal((await app.request('/api/links/import', { method: 'POST', body: [] })).status, 400);
  const many = { items: Array.from({ length: 501 }, (_, index) => ({ title: `T${index}`, links: [{ url: `https://x.example/${index}` }] })) };
  assert.equal((await app.request('/api/links/import', { method: 'POST', body: many })).status, 400);
  assert.equal((await app.request('/api/links')).json.links.length, 0);
}));

test('匯入：超過 32KB 的備份檔也能收，但超過 1MB 會被擋', () => withApp(async (app) => {
  const items = Array.from({ length: 200 }, (_, index) => ({ title: `項目 ${index}`, description: '說'.repeat(150), links: [{ label: '開啟', url: `https://x.example/${index}` }] }));
  const result = await app.request('/api/links/import', { method: 'POST', body: { items } });
  assert.equal(result.status, 200);
  assert.equal(result.json.imported, 200);
  const huge = await fetch(`${app.base}/api/links/import`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: app.getCookie() }, body: JSON.stringify({ items: [], pad: 'x'.repeat(1_100_000) }) });
  assert.equal(huge.status, 413);
}));

test('匯入：同一批裡網址重複的只收一筆', () => withApp(async (app) => {
  const body = { items: [
    { title: 'A', links: [{ url: 'https://same.example' }] },
    { title: 'B', links: [{ url: 'https://same.example' }] },
  ] };
  const result = await app.request('/api/links/import', { method: 'POST', body });
  assert.equal(result.json.imported, 1);
  assert.equal(result.json.duplicates, 1);
}));
