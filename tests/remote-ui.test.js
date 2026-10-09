import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (file) => readFileSync(join(import.meta.dirname, '..', 'public', file), 'utf8');

test('店家頁：前端用到的元素 id 都存在於 HTML', () => {
  const html = read('index.html'), js = read('app.js');
  const missing = new Set();
  for (const [, id] of js.matchAll(/\$\('#([\w-]+)'\)/g)) if (!html.includes(`id="${id}"`)) missing.add(id);
  for (const kind of ['read', 'write']) for (const id of [`remote-${kind}-state`, `remote-clear-${kind}`, `remote-${kind}-key`]) if (!html.includes(`id="${id}"`)) missing.add(id);
  assert.deepEqual([...missing], []);
});

test('店家頁：新增的畫面與程式不含表情符號', () => {
  const html = read('index.html'), js = read('app.js');
  const added = html.slice(html.indexOf('id="remote-dialog"')) + js.slice(js.indexOf('店家頁：本月預約數'));
  assert.equal(/\p{Extended_Pictographic}/u.test(added), false);
});

test('店家頁：金鑰輸入框是密碼欄位、不自動填入', () => {
  const html = read('index.html');
  for (const id of ['remote-read-key', 'remote-write-key']) assert.match(html, new RegExp(`id="${id}" type="password" autocomplete="off"`));
});
