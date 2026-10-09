import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('店家頁的功能模組依分類分組，沒帶分類的歸入其他', () => {
  for (const title of ['共用功能', '臉部專屬', '身體專屬', '其他功能']) assert.ok(js.includes(title), title);
  assert.ok(js.includes("mod.scope === scope"));
});
