import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'crm_session';
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

export function issueSession(secret, nowMs = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: nowMs + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string') return false;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return false;
  const given = Buffer.from(signature), expected = Buffer.from(sign(secret, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > nowMs; } catch { return false; }
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return '';
}

// 先雜湊再比對，長度不同也不會提早回傳。
export function passwordMatches(input, expected) {
  const digest = (text) => createHash('sha256').update(String(text)).digest();
  return timingSafeEqual(digest(input), digest(expected));
}

// 登入失敗限制：同一來源 15 分鐘內失敗 10 次，封鎖 5 分鐘。
export function createLoginLimiter({ maxFailures = 10, blockMs = 5 * 60_000, windowMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    blocked(key) { const entry = entries.get(key); return Boolean(entry) && entry.blockedUntil > now(); },
    fail(key) {
      const time = now();
      if (entries.size > 1000) entries.clear();
      let entry = entries.get(key);
      if (!entry || time - entry.first > windowMs) entry = { count: 0, first: time, blockedUntil: 0 };
      entry.count += 1;
      if (entry.count >= maxFailures) entry.blockedUntil = time + blockMs;
      entries.set(key, entry);
    },
    reset(key) { entries.delete(key); },
  };
}
