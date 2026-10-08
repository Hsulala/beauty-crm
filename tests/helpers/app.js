// 測試用：以 PGlite（PostgreSQL WASM）起一個真的 app，並提供帶登入 Cookie 的請求小工具。
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { createPgliteDb } from '../../src/db.js';
import { migrate } from '../../src/migrate.js';

export const PASSWORD = 'correct-horse-battery';
export const SECRET = 'x'.repeat(40);
export const MIGRATIONS = join(import.meta.dirname, '..', '..', 'migrations');

// 固定「現在」為 2026-10-08 12:00（台北），讓合約到期天數可預測。
export const FIXED_NOW = Date.parse('2026-10-08T04:00:00Z');

export async function startApp(overrides = {}) {
  const db = await createPgliteDb();
  await migrate(db, MIGRATIONS);
  const clock = { ms: FIXED_NOW };
  const config = { adminPassword: PASSWORD, sessionSecret: SECRET, now: () => new Date(clock.ms), ...overrides };
  const app = createApp({ db, config });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  const request = async (path, { method = 'GET', body, headers = {}, auth = true } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(auth && cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON（例如靜態頁） */ }
    return { status: response.status, headers: response.headers, json, text };
  };
  const login = async (password = PASSWORD) => {
    const result = await request('/api/login', { method: 'POST', body: { password }, auth: false });
    const setCookie = result.headers.get('set-cookie');
    if (result.status === 200 && setCookie) cookie = setCookie.split(';')[0];
    return result;
  };
  const stop = async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); };
  return { base, db, clock, request, login, setCookie: (value) => { cookie = value; }, getCookie: () => cookie, stop };
}
