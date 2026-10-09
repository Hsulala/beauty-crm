import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('店家頁的功能模組依分類分組，沒帶分類的歸入其他', () => {
  for (const title of ['共用功能', '臉部專屬', '多位老師才需要', '包堂', '其他功能']) assert.ok(js.includes(title), title);
  assert.equal(js.includes('身體專屬'), false, '不再有身體專屬分類');
  assert.ok(js.includes('scopeOf(key, mod) === scope'));
});

test('舊版禾域系統回報的 body 分類會依模組代碼換成新分類', () => {
  const block = js.slice(js.indexOf('const LEGACY_BODY'), js.indexOf('const scopeOf'));
  const map = Function(`${block}; return LEGACY_BODY;`)();
  assert.deepEqual(map, { schedule: 'multi', commission: 'multi', packages: 'package', teacherNotify: 'common' });
});
