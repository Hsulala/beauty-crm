import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createPgliteDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { SEED_STORES, seedStores } from '../src/seed.js';
import { MIGRATIONS, startApp } from './helpers/app.js';

test('migration：第二次執行不會重跑，資料表都建好了', async () => {
  const db = await createPgliteDb();
  try {
    assert.deepEqual(await migrate(db, MIGRATIONS), ['001_init.sql', '002_store_remote.sql', '003_store_icon.sql', '004_system_types.sql', '005_links.sql']);
    assert.deepEqual(await migrate(db, MIGRATIONS), []);
    const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name);
    for (const name of ['stores', 'audit_log', 'schema_migrations', 'store_remote', 'store_icon', 'system_types', 'links']) assert.ok(tables.includes(name), name);
  } finally { await db.close(); }
});

test('資料庫約束：狀態、月費、起訖日與店名唯一都由資料庫把關', async () => {
  const db = await createPgliteDb();
  try {
    await migrate(db, MIGRATIONS);
    const insert = (name, status = 'running', fee = 0, start = null, end = null) =>
      db.query('INSERT INTO stores (name, status, monthly_fee, contract_start, contract_end) VALUES ($1, $2, $3, $4, $5)', [name, status, fee, start, end]);
    await insert('A');
    await assert.rejects(() => insert('a'), (error) => error.code === '23505');
    await assert.rejects(() => insert('B', 'bogus'));
    await assert.rejects(() => insert('C', 'running', -1));
    await assert.rejects(() => insert('D', 'running', 0, '2026-05-01', '2026-04-01'));
    await assert.rejects(() => insert(''));
  } finally { await db.close(); }
});

test('seed：第一次新增兩家，第二次全部略過，且不覆蓋已改過的資料', async () => {
  const db = await createPgliteDb();
  try {
    await migrate(db, MIGRATIONS);
    const first = await seedStores(db);
    assert.equal(first.added.length, SEED_STORES.length);
    await db.query("UPDATE stores SET monthly_fee = 1200, notes = '我改過' WHERE name = $1", [SEED_STORES[0].name]);
    const second = await seedStores(db);
    assert.deepEqual(second.added, []);
    assert.equal(second.skipped.length, SEED_STORES.length);
    const row = (await db.query('SELECT monthly_fee, notes FROM stores WHERE name = $1', [SEED_STORES[0].name])).rows[0];
    assert.equal(row.monthly_fee, 1200);
    assert.equal(row.notes, '我改過');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM stores')).rows[0].n, SEED_STORES.length);
  } finally { await db.close(); }
});

test('健康檢查與靜態頁面', async () => {
  const app = await startApp();
  try {
    const health = await app.request('/healthz', { auth: false });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const home = await app.request('/', { auth: false });
    assert.match(home.text, /店家總覽/);
    const login = await app.request('/login', { auth: false });
    assert.equal(login.status, 200);
    assert.match(login.text, /密碼/);
  } finally { await app.stop(); }
});

test('頁面守門：沒有行內程式、沒有表情符號，且 HTML 用到的元素 id 都有對應', () => {
  const dir = join(import.meta.dirname, '..', 'public');
  const emoji = /\p{Extended_Pictographic}/u;
  // 只檢查文字檔（字型、圖片等二進位檔與子資料夾略過）
  for (const file of readdirSync(dir).filter((f) => /\.(html|js|css)$/.test(f))) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.equal(emoji.test(text), false, `${file} 不應含表情符號`);
    if (file.endsWith('.html')) {
      assert.equal(/<script(?![^>]*\bsrc=)/i.test(text), false, `${file} 不應有行內 script`);
      assert.equal(/\son[a-z]+\s*=/i.test(text), false, `${file} 不應有行內事件`);
      assert.equal(/\sstyle\s*=/i.test(text), false, `${file} 不應有行內 style`);
    }
  }
  const html = readFileSync(join(dir, 'index.html'), 'utf8'), js = readFileSync(join(dir, 'app.js'), 'utf8');
  for (const [, id] of js.matchAll(/\$\('#([\w-]+)'\)/g)) assert.ok(html.includes(`id="${id}"`), `app.js 用到 #${id}，HTML 找不到`);
  for (const key of ['name', 'system_type', 'url', 'status', 'monthly_fee', 'contract_start', 'contract_end', 'notes']) assert.ok(html.includes(`name="${key}"`), `表單缺少欄位 ${key}`);
});

test('專案檔案齊全：env 範例、部署設定、交接文件', () => {
  const root = join(import.meta.dirname, '..');
  for (const file of ['.env.example', '.gitignore', 'railway.toml', 'README.md', 'docs/HANDOFF.md', 'package-lock.json']) assert.ok(existsSync(join(root, file)), file);
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.env/);
  assert.equal(/ADMIN_PASSWORD=.+/.test(readFileSync(join(root, '.env.example'), 'utf8')), false, '.env.example 不可放真實密碼');
});
