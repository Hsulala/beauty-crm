import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { contractInfo, taipeiToday } from '../src/contract.js';
import { checkContractOrder, parseStore } from '../src/validate.js';
import { createLoginLimiter, issueSession, passwordMatches, readCookie, verifySession } from '../src/auth.js';

const GOOD_ENV = { ADMIN_PASSWORD: 'a-long-enough-password', SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://x' };

test('設定：密碼或簽章金鑰太短、缺資料庫都拒絕啟動', () => {
  assert.throws(() => loadConfig({ ...GOOD_ENV, ADMIN_PASSWORD: 'short' }), /ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ ...GOOD_ENV, SESSION_SECRET: 'short' }), /SESSION_SECRET/);
  assert.throws(() => loadConfig({ ...GOOD_ENV, DATABASE_URL: '' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({}), (error) => error.problems.length === 3);
  assert.equal(loadConfig({ ...GOOD_ENV, DATABASE_URL: '', USE_PGLITE: '1' }).usePglite, true);
  assert.equal(loadConfig({ ...GOOD_ENV, PORT: '8080' }).port, 8080);
});

test('台北日期：UTC 傍晚已經是台北隔天', () => {
  assert.equal(taipeiToday(new Date('2026-10-07T15:59:00Z')), '2026-10-07');
  assert.equal(taipeiToday(new Date('2026-10-07T16:00:00Z')), '2026-10-08');
});

test('合約狀態：已過期、30 日內、正常、未設定、已結束', () => {
  const today = '2026-10-08';
  const info = (end, status = 'running', start = null) => contractInfo({ contract_start: start, contract_end: end, status }, today);
  assert.deepEqual(info(null), { state: 'none', daysLeft: null, progress: null });
  assert.equal(info('2026-10-07').state, 'expired');
  assert.equal(info('2026-10-07').daysLeft, -1);
  assert.equal(info('2026-10-08').state, 'soon');
  assert.equal(info('2026-10-08').daysLeft, 0);
  assert.equal(info('2026-11-07').state, 'soon');
  assert.equal(info('2026-11-07').daysLeft, 30);
  assert.equal(info('2026-11-08').state, 'ok');
  assert.equal(info('2026-10-07', 'ended').state, 'ended');
  assert.equal(info('2027-10-08', 'running', '2026-10-08').progress, 0);
  assert.equal(info('2027-10-08', 'running', '2025-10-08').progress, 0.5);
  assert.equal(info('2026-01-01', 'running', '2025-01-01').progress, 1);
});

test('驗證：新增補預設值，缺店名會被擋', () => {
  const ok = parseStore({ name: '  某某店  ' }, { partial: false });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.value, { name: '某某店', system_type: 'other', url: '', status: 'building', monthly_fee: 0, contract_start: null, contract_end: null, notes: '' });
  assert.ok(parseStore({}, { partial: false }).errors.name);
  assert.ok(parseStore('x', { partial: false }).errors._);
  assert.ok(parseStore([], { partial: false }).errors._);
});

test('驗證：修改只處理有帶的欄位', () => {
  const result = parseStore({ monthly_fee: '1200' }, { partial: true });
  assert.deepEqual(result.value, { monthly_fee: 1200 });
  assert.deepEqual(result.errors, {});
});

test('驗證：網址、月費、日期、狀態的錯誤', () => {
  const bad = parseStore({ name: 'a', url: 'javascript:alert(1)', monthly_fee: 1.5, contract_start: '2026-02-30', contract_end: '2026/03/01', status: 'x', system_type: 'y', notes: 5 }, { partial: false });
  for (const key of ['url', 'monthly_fee', 'contract_start', 'contract_end', 'status', 'system_type', 'notes']) assert.ok(bad.errors[key], `應擋下：${key}`);
  assert.ok(parseStore({ url: 'not a url' }, { partial: true }).errors.url);
  assert.ok(parseStore({ monthly_fee: -1 }, { partial: true }).errors.monthly_fee);
  assert.ok(parseStore({ monthly_fee: 1_000_001 }, { partial: true }).errors.monthly_fee);
  assert.ok(parseStore({ name: 'x'.repeat(61) }, { partial: true }).errors.name);
  assert.deepEqual(parseStore({ url: 'https://a.example/x' }, { partial: true }).errors, {});
  assert.deepEqual(parseStore({ contract_end: '' }, { partial: true }).value, { contract_end: null });
});

test('驗證：合約到期日不能早於起日', () => {
  assert.ok(checkContractOrder({ contract_start: '2026-05-01', contract_end: '2026-04-30' }));
  assert.equal(checkContractOrder({ contract_start: '2026-05-01', contract_end: '2026-05-01' }), null);
  assert.equal(checkContractOrder({ contract_start: null, contract_end: '2020-01-01' }), null);
});

test('登入工作階段：簽章、竄改、過期與 Cookie 解析', () => {
  const secret = 'k'.repeat(40);
  const token = issueSession(secret, 1000);
  assert.equal(verifySession(secret, token, 2000), true);
  assert.equal(verifySession('other'.repeat(10), token, 2000), false);
  assert.equal(verifySession(secret, `${token}x`, 2000), false);
  assert.equal(verifySession(secret, 'abc', 2000), false);
  assert.equal(verifySession(secret, undefined, 2000), false);
  assert.equal(verifySession(secret, token, 1000 + 8 * 24 * 3600 * 1000), false);
  assert.equal(readCookie('a=1; crm_session=abc.def; b=2', 'crm_session'), 'abc.def');
  assert.equal(readCookie('', 'crm_session'), '');
  assert.equal(passwordMatches('abc', 'abc'), true);
  assert.equal(passwordMatches('abc', 'abcd'), false);
});

test('登入限制：失敗次數到上限就封鎖，成功後歸零，過了時間解除', () => {
  let time = 0;
  const limiter = createLoginLimiter({ maxFailures: 3, blockMs: 1000, windowMs: 10_000, now: () => time });
  limiter.fail('ip'); limiter.fail('ip');
  assert.equal(limiter.blocked('ip'), false);
  limiter.fail('ip');
  assert.equal(limiter.blocked('ip'), true);
  time = 1001;
  assert.equal(limiter.blocked('ip'), false);
  limiter.fail('b'); limiter.reset('b');
  limiter.fail('b'); limiter.fail('b');
  assert.equal(limiter.blocked('b'), false);
});
