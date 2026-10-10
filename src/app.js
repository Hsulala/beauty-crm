import express from 'express';
import { join } from 'node:path';
import { COOKIE_NAME, SESSION_MS, createLoginLimiter, issueSession, passwordMatches, readCookie, verifySession } from './auth.js';
import { contractInfo, taipeiToday } from './contract.js';
import { FIELD_NAMES, TYPE_FIELD_NAMES, checkContractOrder, parseStore, parseType } from './validate.js';
import { LINK_FIELD_NAMES, normalizeImport, parseLink } from './links.js';
import { RemoteError, callStore, remoteUrl } from './remote.js';
import { open, seal } from './secretbox.js';

const STORE_COLUMNS = `id, name, system_type, url, status, monthly_fee,
  to_char(contract_start, 'YYYY-MM-DD') AS contract_start,
  to_char(contract_end, 'YYYY-MM-DD') AS contract_end,
  notes, created_at, updated_at`;

const STATUS_ORDER = `CASE status WHEN 'running' THEN 0 WHEN 'building' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END`;

export function createApp({ db, config }) {
  const now = config.now ?? (() => new Date());
  const publicDir = config.publicDir ?? join(import.meta.dirname, '..', 'public');
  const limiter = createLoginLimiter({ now: () => now().getTime() });
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((request, response, next) => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 會改動資料的請求：若帶了 Origin，必須與本站相同（擋跨站偽造請求）。
  app.use('/api', (request, response, next) => {
    if (request.method !== 'GET' && request.headers.origin) {
      let same = false;
      try { same = new URL(request.headers.origin).host === request.headers.host; } catch { same = false; }
      if (!same) return response.status(403).json({ error: '來源不被允許' });
    }
    next();
  });
  // 一般請求上限 32KB；匯入 Linkbase 備份檔的路徑另用 1MB，且在確認已登入之後才讀內容（見下方連結區塊）。
  const smallJson = express.json({ limit: '32kb' });
  app.use('/api', (request, response, next) => (request.method === 'POST' && request.path === '/links/import' ? next() : smallJson(request, response, next)));

  const fail = (response, status, error, fields) => response.status(status).json(fields ? { error, fields } : { error });

  app.get('/healthz', async (request, response) => {
    try { await db.query('SELECT 1'); response.json({ ok: true }); }
    catch { response.status(503).json({ ok: false }); }
  });

  // ---- 登入 ----
  app.post('/api/login', (request, response) => {
    const key = request.ip;
    if (limiter.blocked(key)) return fail(response, 429, '嘗試次數過多，請 5 分鐘後再試');
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!passwordMatches(password, config.adminPassword)) {
      limiter.fail(key);
      return fail(response, 401, '密碼不正確');
    }
    limiter.reset(key);
    const secure = request.secure ? '; Secure' : '';
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=${issueSession(config.sessionSecret, now().getTime())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    response.json({ ok: true });
  });

  app.post('/api/logout', (request, response) => {
    response.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    response.json({ ok: true });
  });

  const requireLogin = (request, response, next) => {
    if (verifySession(config.sessionSecret, readCookie(request.headers.cookie, COOKIE_NAME), now().getTime())) return next();
    return fail(response, 401, '請先登入');
  };
  app.use('/api', requireLogin);

  app.get('/api/me', (request, response) => response.json({ ok: true }));

  // ---- 店家 ----
  const present = (row, today) => ({ ...row, contract: contractInfo(row, today) });
  const parseId = (text) => (/^\d{1,9}$/.test(text) ? Number(text) : null);
  const typeExists = async (key) => (await db.query('SELECT 1 FROM system_types WHERE key = $1', [key])).rows.length > 0;
  const NO_TYPE = '沒有這個系統類型';

  app.get('/api/stores', async (request, response) => {
    const { rows } = await db.query(`SELECT ${STORE_COLUMNS},
      (SELECT (extract(epoch FROM i.updated_at) * 1000)::bigint FROM store_icon i WHERE i.store_id = stores.id) AS icon_v
      FROM stores ORDER BY ${STATUS_ORDER}, lower(name)`);
    const today = taipeiToday(now());
    response.json({ today, stores: rows.map(({ icon_v: iconV, ...row }) => ({ ...present(row, today), icon_v: iconV == null ? null : String(iconV) })) });
  });

  app.post('/api/stores', async (request, response) => {
    const { value, errors } = parseStore(request.body, { partial: false });
    const order = checkContractOrder(value);
    if (order) Object.assign(errors, order);
    if (!errors.system_type && !(await typeExists(value.system_type))) errors.system_type = NO_TYPE;
    if (Object.keys(errors).length) return fail(response, 400, '資料有誤', errors);
    try {
      const store = await db.tx(async (tx) => {
        const dup = await tx.query('SELECT 1 FROM stores WHERE lower(name) = lower($1)', [value.name]);
        if (dup.rows.length) return null;
        const { rows } = await tx.query(
          `INSERT INTO stores (name, system_type, url, status, monthly_fee, contract_start, contract_end, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${STORE_COLUMNS}`,
          [value.name, value.system_type, value.url, value.status, value.monthly_fee, value.contract_start, value.contract_end, value.notes],
        );
        await tx.query(
          'INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
          ['store.create', rows[0].id, rows[0].name, JSON.stringify({ fields: value })],
        );
        return rows[0];
      });
      if (!store) return fail(response, 409, '已有同名店家', { name: '已有同名店家' });
      response.status(201).json(present(store, taipeiToday(now())));
    } catch (error) {
      if (error?.code === '23505') return fail(response, 409, '已有同名店家', { name: '已有同名店家' });
      if (error?.code === '23503') return fail(response, 400, '資料有誤', { system_type: NO_TYPE });
      throw error;
    }
  });

  app.patch('/api/stores/:id', async (request, response) => {
    const id = parseId(request.params.id);
    if (id === null) return fail(response, 404, '找不到這家店');
    const { value, errors } = parseStore(request.body, { partial: true });
    if (value.system_type !== undefined && !(await typeExists(value.system_type))) errors.system_type = NO_TYPE;
    if (Object.keys(errors).length) return fail(response, 400, '資料有誤', errors);
    try {
      const result = await db.tx(async (tx) => {
        const current = (await tx.query(`SELECT ${STORE_COLUMNS} FROM stores WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!current) return { status: 404 };
        // 只動有變的欄位；其餘（包含這次沒帶的欄位）維持原值。
        const changes = {};
        for (const key of FIELD_NAMES) if (Object.hasOwn(value, key) && value[key] !== current[key]) changes[key] = { from: current[key], to: value[key] };
        const order = checkContractOrder({ ...current, ...value });
        if (order) return { status: 400, fields: order };
        if (!Object.keys(changes).length) return { status: 200, store: current };
        if (changes.name) {
          const dup = await tx.query('SELECT 1 FROM stores WHERE lower(name) = lower($1) AND id <> $2', [value.name, id]);
          if (dup.rows.length) return { status: 409, fields: { name: '已有同名店家' } };
        }
        const keys = Object.keys(changes);
        const assignments = keys.map((key, index) => `${key} = $${index + 2}`).join(', ');
        const { rows } = await tx.query(
          `UPDATE stores SET ${assignments}, updated_at = now() WHERE id = $1 RETURNING ${STORE_COLUMNS}`,
          [id, ...keys.map((key) => changes[key].to)],
        );
        await tx.query(
          'INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
          ['store.update', id, rows[0].name, JSON.stringify({ changes })],
        );
        return { status: 200, store: rows[0] };
      });
      if (result.status === 404) return fail(response, 404, '找不到這家店');
      if (result.status !== 200) return fail(response, result.status, result.status === 409 ? '已有同名店家' : '資料有誤', result.fields);
      response.json(present(result.store, taipeiToday(now())));
    } catch (error) {
      if (error?.code === '23505') return fail(response, 409, '已有同名店家', { name: '已有同名店家' });
      if (error?.code === '23503') return fail(response, 400, '資料有誤', { system_type: NO_TYPE });
      throw error;
    }
  });

  app.delete('/api/stores/:id', async (request, response) => {
    const id = parseId(request.params.id);
    if (id === null) return fail(response, 404, '找不到這家店');
    const removed = await db.tx(async (tx) => {
      const { rows } = await tx.query(`DELETE FROM stores WHERE id = $1 RETURNING ${STORE_COLUMNS}`, [id]);
      if (!rows.length) return null;
      await tx.query(
        'INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
        ['store.delete', id, rows[0].name, JSON.stringify({ snapshot: rows[0] })],
      );
      return rows[0];
    });
    if (!removed) return fail(response, 404, '找不到這家店');
    response.json({ ok: true });
  });

  // ---- 連結（原 Linkbase：後台、部署、文件入口）----
  // 刻意不存帳號密碼；匯入備份檔時帳號密碼會被丟掉，只回報有幾筆帶了帳密，提醒改放密碼管理器。
  const LINK_COLUMNS = 'id, title, label, url, category, description, tags, note, status, pinned, store_id, created_at, updated_at';
  const NO_STORE = '沒有這家店';
  const storeExists = async (id) => (await db.query('SELECT 1 FROM stores WHERE id = $1', [id])).rows.length > 0;

  app.get('/api/links', async (request, response) => {
    const { rows } = await db.query(`SELECT ${LINK_COLUMNS} FROM links ORDER BY pinned DESC, lower(category), lower(title), lower(label), id`);
    response.json({ links: rows });
  });

  app.post('/api/links', async (request, response) => {
    const { value, errors } = parseLink(request.body, { partial: false });
    if (value.store_id != null && !errors.store_id && !(await storeExists(value.store_id))) errors.store_id = NO_STORE;
    if (Object.keys(errors).length) return fail(response, 400, '資料有誤', errors);
    try {
      const { rows } = await db.query(
        `INSERT INTO links (title, label, url, category, description, tags, note, status, pinned, store_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${LINK_COLUMNS}`,
        [value.title, value.label, value.url, value.category, value.description, value.tags, value.note, value.status, value.pinned, value.store_id],
      );
      response.status(201).json(rows[0]);
    } catch (error) {
      if (error?.code === '23503') return fail(response, 400, '資料有誤', { store_id: NO_STORE });
      throw error;
    }
  });

  app.patch('/api/links/:id', async (request, response) => {
    const id = parseId(request.params.id);
    if (id === null) return fail(response, 404, '找不到這個連結');
    const { value, errors } = parseLink(request.body, { partial: true });
    if (value.store_id != null && !errors.store_id && !(await storeExists(value.store_id))) errors.store_id = NO_STORE;
    if (Object.keys(errors).length) return fail(response, 400, '資料有誤', errors);
    try {
      const result = await db.tx(async (tx) => {
        const current = (await tx.query(`SELECT ${LINK_COLUMNS} FROM links WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!current) return null;
        // 只動有變的欄位；其餘（包含這次沒帶的欄位）維持原值。
        const names = LINK_FIELD_NAMES.filter((name) => Object.hasOwn(value, name) && value[name] !== current[name]);
        if (!names.length) return current;
        const { rows } = await tx.query(
          `UPDATE links SET ${names.map((name, index) => `${name} = $${index + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${LINK_COLUMNS}`,
          [id, ...names.map((name) => value[name])],
        );
        return rows[0];
      });
      if (!result) return fail(response, 404, '找不到這個連結');
      response.json(result);
    } catch (error) {
      if (error?.code === '23503') return fail(response, 400, '資料有誤', { store_id: NO_STORE });
      throw error;
    }
  });

  app.delete('/api/links/:id', async (request, response) => {
    const id = parseId(request.params.id);
    const { rowCount } = id === null ? { rowCount: 0 } : await db.query('DELETE FROM links WHERE id = $1', [id]);
    if (!rowCount) return fail(response, 404, '找不到這個連結');
    response.json({ ok: true });
  });

  // 匯入 Linkbase 備份檔：以網址去重（資料庫已有的、同一批裡重複的都略過），不覆蓋手動修改過的資料。
  app.post('/api/links/import', express.json({ limit: '1mb' }), async (request, response) => {
    const stores = (await db.query('SELECT id, name FROM stores')).rows;
    const parsed = normalizeImport(request.body, stores);
    if (parsed.error) return fail(response, 400, parsed.error);
    const { rows, invalid, withCredentials } = parsed;
    const outcome = await db.tx(async (tx) => {
      const seen = new Set((await tx.query('SELECT url FROM links')).rows.map((row) => row.url));
      let imported = 0, duplicates = 0;
      for (const row of rows) {
        if (seen.has(row.url)) { duplicates += 1; continue; }
        seen.add(row.url);
        await tx.query(
          `INSERT INTO links (title, label, url, category, description, tags, note, status, pinned, store_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [row.title, row.label, row.url, row.category, row.description, row.tags, row.note, row.status, row.pinned, row.store_id],
        );
        imported += 1;
      }
      await tx.query(
        'INSERT INTO audit_log (action, store_name, detail) VALUES ($1, $2, $3::jsonb)',
        ['links.import', '', JSON.stringify({ imported, duplicates, invalid: invalid.length, with_credentials: withCredentials })],
      );
      return { imported, duplicates };
    });
    response.json({ ...outcome, invalid, with_credentials: withCredentials });
  });

  // ---- 系統類型（可重複使用的範本；店家掛在類型底下）----
  const TYPE_COLUMNS = 'key, label, description, repo, remote_supported, sort_order';
  const PROTECTED_TYPE = 'other';

  app.get('/api/types', async (request, response) => {
    const [types, stores] = await Promise.all([
      db.query(`SELECT ${TYPE_COLUMNS} FROM system_types ORDER BY sort_order, key`),
      db.query(`SELECT id, name, status, system_type FROM stores ORDER BY ${STATUS_ORDER}, lower(name)`),
    ]);
    response.json({
      types: types.rows.map((type) => {
        const members = stores.rows.filter((store) => store.system_type === type.key).map(({ id, name, status }) => ({ id, name, status }));
        return { ...type, store_count: members.length, stores: members };
      }),
    });
  });

  app.post('/api/types', async (request, response) => {
    const { value, errors } = parseType(request.body, { partial: false });
    if (Object.keys(errors).length) return fail(response, 400, '資料有誤', errors);
    const created = await db.tx(async (tx) => {
      const dup = await tx.query('SELECT 1 FROM system_types WHERE key = $1 OR lower(label) = lower($2)', [value.key, value.label]);
      if (dup.rows.length) return null;
      const { rows } = await tx.query(
        `INSERT INTO system_types (key, label, description, repo, remote_supported, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${TYPE_COLUMNS}`,
        [value.key, value.label, value.description, value.repo, value.remote_supported, value.sort_order],
      );
      await tx.query(
        'INSERT INTO audit_log (action, store_name, detail) VALUES ($1, $2, $3::jsonb)',
        ['type.create', rows[0].label, JSON.stringify({ key: rows[0].key, fields: value })],
      );
      return rows[0];
    });
    if (!created) return fail(response, 409, '已有相同代碼或名稱的系統類型', { key: '代碼或名稱已被使用' });
    response.status(201).json({ ...created, store_count: 0, stores: [] });
  });

  app.patch('/api/types/:key', async (request, response) => {
    const { value, errors } = parseType(request.body, { partial: true });
    if (Object.keys(errors).length) return fail(response, 400, '資料有誤', errors);
    const result = await db.tx(async (tx) => {
      const current = (await tx.query(`SELECT ${TYPE_COLUMNS} FROM system_types WHERE key = $1 FOR UPDATE`, [request.params.key])).rows[0];
      if (!current) return { status: 404 };
      const changes = {};
      for (const name of TYPE_FIELD_NAMES) if (Object.hasOwn(value, name) && value[name] !== current[name]) changes[name] = { from: current[name], to: value[name] };
      if (!Object.keys(changes).length) return { status: 200, type: current };
      if (changes.label) {
        const dup = await tx.query('SELECT 1 FROM system_types WHERE lower(label) = lower($1) AND key <> $2', [value.label, current.key]);
        if (dup.rows.length) return { status: 409, fields: { label: '已有同名的系統類型' } };
      }
      const names = Object.keys(changes);
      const { rows } = await tx.query(
        `UPDATE system_types SET ${names.map((name, index) => `${name} = $${index + 2}`).join(', ')}, updated_at = now() WHERE key = $1 RETURNING ${TYPE_COLUMNS}`,
        [current.key, ...names.map((name) => changes[name].to)],
      );
      await tx.query(
        'INSERT INTO audit_log (action, store_name, detail) VALUES ($1, $2, $3::jsonb)',
        ['type.update', rows[0].label, JSON.stringify({ key: current.key, changes })],
      );
      return { status: 200, type: rows[0] };
    });
    if (result.status === 404) return fail(response, 404, '找不到這個系統類型');
    if (result.status !== 200) return fail(response, result.status, '已有同名的系統類型', result.fields);
    response.json(result.type);
  });

  app.delete('/api/types/:key', async (request, response) => {
    if (request.params.key === PROTECTED_TYPE) return fail(response, 409, '「其他」是預設類型，不能刪除');
    try {
      const result = await db.tx(async (tx) => {
        const current = (await tx.query(`SELECT ${TYPE_COLUMNS} FROM system_types WHERE key = $1 FOR UPDATE`, [request.params.key])).rows[0];
        if (!current) return { status: 404 };
        const used = (await tx.query('SELECT count(*)::int AS n FROM stores WHERE system_type = $1', [current.key])).rows[0].n;
        if (used) return { status: 409, used };
        await tx.query('DELETE FROM system_types WHERE key = $1', [current.key]);
        await tx.query(
          'INSERT INTO audit_log (action, store_name, detail) VALUES ($1, $2, $3::jsonb)',
          ['type.delete', current.label, JSON.stringify({ snapshot: current })],
        );
        return { status: 200 };
      });
      if (result.status === 404) return fail(response, 404, '找不到這個系統類型');
      if (result.status === 409) return fail(response, 409, `還有 ${result.used} 家店使用這個類型，請先把它們改到其他類型再刪除`);
      response.json({ ok: true });
    } catch (error) {
      if (error?.code === '23503') return fail(response, 409, '還有店家使用這個類型，請先改到其他類型再刪除');
      throw error;
    }
  });

  // ---- 遠端管理（呼叫各店系統的 /api/remote/*）----
  // 各店有兩把金鑰：讀取金鑰看數字與模組狀態、寫入金鑰才能改模組。金鑰加密存放，不會回傳到畫面。
  // 功能模組只能在這裡改，店家自己的後台改不了。
  const remoteSupported = async (typeKey) => Boolean((await db.query('SELECT remote_supported FROM system_types WHERE key = $1', [typeKey])).rows[0]?.remote_supported);
  const validKey = (value) => typeof value === 'string' && value.length >= 32 && value.length <= 200 && !/\s/.test(value);
  const secret = config.remoteKeySecret ?? '';

  async function remoteContext(request, response) {
    const id = parseId(request.params.id);
    const store = id === null ? null : (await db.query(`SELECT ${STORE_COLUMNS} FROM stores WHERE id = $1`, [id])).rows[0];
    if (!store) { fail(response, 404, '找不到這家店'); return null; }
    const row = (await db.query('SELECT read_key_enc, write_key_enc FROM store_remote WHERE store_id = $1', [id])).rows[0] ?? {};
    const keys = secret
      ? { read: row.read_key_enc ? open(row.read_key_enc, secret) : null, write: row.write_key_enc ? open(row.write_key_enc, secret) : null }
      : { read: null, write: null };
    return { store, row, keys, supported: await remoteSupported(store.system_type) };
  }

  function requireRemote(response, { supported }) {
    if (!secret) { fail(response, 409, '尚未設定 REMOTE_KEY_SECRET，無法使用遠端管理（請在 Railway 設定這個變數）'); return false; }
    if (!supported) { fail(response, 400, '這個系統類型不支援遠端管理'); return false; }
    return true;
  }

  const settle = (result) => (result.status === 'fulfilled'
    ? { ok: true, data: result.value }
    : { ok: false, error: result.reason instanceof RemoteError ? result.reason.message : '讀取失敗' });

  app.get('/api/stores/:id/remote', async (request, response) => {
    const ctx = await remoteContext(request, response);
    if (!ctx) return;
    response.json({
      available: Boolean(secret),
      supported: ctx.supported,
      has_read_key: Boolean(ctx.row.read_key_enc),
      has_write_key: Boolean(ctx.row.write_key_enc),
    });
  });

  // 設定或清除金鑰：只處理有帶的那把；帶 null 代表清除。金鑰本身不會寫進異動紀錄。
  app.put('/api/stores/:id/remote', async (request, response) => {
    const ctx = await remoteContext(request, response);
    if (!ctx) return;
    if (!secret) return fail(response, 409, '尚未設定 REMOTE_KEY_SECRET，無法儲存金鑰（請在 Railway 設定這個變數）');
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(response, 400, '資料格式不正確');
    const fields = {};
    const wanted = { read_key: 'read_key_enc', write_key: 'write_key_enc' };
    for (const key of Object.keys(body)) if (!wanted[key]) fields[key] = '沒有這個欄位';
    for (const key of Object.keys(wanted)) {
      if (!Object.hasOwn(body, key)) continue;
      if (body[key] !== null && !validKey(body[key])) fields[key] = '金鑰需為 32 到 200 個字元，且不含空白';
    }
    if (!Object.hasOwn(body, 'read_key') && !Object.hasOwn(body, 'write_key') && !Object.keys(fields).length) return fail(response, 400, '沒有要儲存的金鑰');
    const nextRead = Object.hasOwn(body, 'read_key') ? body.read_key : ctx.keys.read;
    const nextWrite = Object.hasOwn(body, 'write_key') ? body.write_key : ctx.keys.write;
    if (!Object.keys(fields).length && nextRead && nextWrite && nextRead === nextWrite) fields.write_key = '讀取與寫入金鑰必須不同';
    if (Object.keys(fields).length) return fail(response, 400, '金鑰有誤', fields);

    const result = await db.tx(async (tx) => {
      const current = (await tx.query('SELECT read_key_enc, write_key_enc FROM store_remote WHERE store_id = $1 FOR UPDATE', [ctx.store.id])).rows[0] ?? {};
      const next = { read_key_enc: current.read_key_enc ?? null, write_key_enc: current.write_key_enc ?? null };
      const detail = {};
      for (const [key, column] of Object.entries(wanted)) {
        if (!Object.hasOwn(body, key)) continue;
        next[column] = body[key] === null ? null : seal(body[key], secret);
        detail[key === 'read_key' ? 'read' : 'write'] = body[key] === null ? 'cleared' : 'set';
      }
      await tx.query(
        `INSERT INTO store_remote (store_id, read_key_enc, write_key_enc) VALUES ($1, $2, $3)
         ON CONFLICT (store_id) DO UPDATE SET read_key_enc = EXCLUDED.read_key_enc, write_key_enc = EXCLUDED.write_key_enc, updated_at = now()`,
        [ctx.store.id, next.read_key_enc, next.write_key_enc],
      );
      await tx.query(
        'INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
        ['store.remote_keys', ctx.store.id, ctx.store.name, JSON.stringify(detail)],
      );
      return { has_read_key: Boolean(next.read_key_enc), has_write_key: Boolean(next.write_key_enc) };
    });
    response.json(result);
  });

  // 店家頁資料：本月預約數＋功能模組狀態。兩段各自成功或失敗，一段連不上不影響另一段。
  app.get('/api/stores/:id/remote/overview', async (request, response) => {
    const ctx = await remoteContext(request, response);
    if (!ctx || !requireRemote(response, ctx)) return;
    const key = ctx.keys.read ?? ctx.keys.write;
    if (!key) return fail(response, 409, '還沒設定連線金鑰，請先在下方儲存這家店的金鑰');
    const month = request.query.month === undefined ? taipeiToday(now()).slice(0, 7) : String(request.query.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(response, 400, '月份格式不正確');
    const [stats, remoteConfig] = await Promise.allSettled([
      callStore({ url: ctx.store.url, key, path: `/api/remote/stats?month=${month}` }),
      callStore({ url: ctx.store.url, key, path: '/api/remote/config' }),
    ]);
    response.json({ month, can_edit: Boolean(ctx.keys.write), stats: settle(stats), config: settle(remoteConfig) });
  });

  // 開關功能模組：需要寫入金鑰。只送有變動的模組；實際有變動才留異動紀錄。
  app.put('/api/stores/:id/remote/modules', async (request, response) => {
    const ctx = await remoteContext(request, response);
    if (!ctx || !requireRemote(response, ctx)) return;
    if (!ctx.keys.write) return fail(response, 409, '還沒設定寫入金鑰，無法修改功能模組');
    const modules = request.body?.modules;
    if (!modules || typeof modules !== 'object' || Array.isArray(modules)) return fail(response, 400, '模組設定格式不正確');
    const entries = Object.entries(modules);
    if (!entries.length || entries.length > 50 || entries.some(([, value]) => typeof value !== 'boolean')) return fail(response, 400, '模組設定格式不正確');
    const before = await callStore({ url: ctx.store.url, key: ctx.keys.write, path: '/api/remote/config' });
    const after = await callStore({ url: ctx.store.url, key: ctx.keys.write, path: '/api/remote/config', method: 'PUT', body: { modules } });
    const changes = {};
    for (const [name, state] of Object.entries(after.modules ?? {})) {
      const was = before.modules?.[name]?.enabled;
      if (was !== undefined && was !== state.enabled) changes[name] = { label: state.label, from: was, to: state.enabled };
    }
    if (Object.keys(changes).length) {
      await db.query(
        'INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
        ['store.modules', ctx.store.id, ctx.store.name, JSON.stringify({ changes })],
      );
    }
    response.json({ ok: true, changed: Object.keys(changes).length > 0, modules: after.modules });
  });

  // ---- 店家小圖示（PNG，存在 store_icon；圖片不進異動紀錄，只記動作）----
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ICON_MAX = 200 * 1024;
  const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.length <= ICON_MAX && buf.subarray(0, 8).equals(PNG_MAGIC);
  async function iconStore(request, response) {
    const id = parseId(request.params.id);
    const store = id === null ? null : (await db.query('SELECT id, name, url FROM stores WHERE id = $1', [id])).rows[0];
    if (!store) fail(response, 404, '找不到這家店');
    return store;
  }
  async function saveIcon(store, data, how) {
    await db.tx(async (tx) => {
      await tx.query(
        `INSERT INTO store_icon (store_id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (store_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [store.id, data]);
      await tx.query('INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
        ['store.icon', store.id, store.name, JSON.stringify({ how, bytes: data.length })]);
    });
  }

  app.get('/api/stores/:id/icon', async (request, response) => {
    const id = parseId(request.params.id);
    const row = id === null ? null : (await db.query('SELECT data FROM store_icon WHERE store_id = $1', [id])).rows[0];
    if (!row) return fail(response, 404, '這家店沒有小圖示');
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // 網址帶 ?v= 版本，換圖就換網址
    response.send(Buffer.from(row.data));
  });

  // 上傳：前端先縮成 128×128 PNG，再以 image/png 原始資料送出
  app.put('/api/stores/:id/icon', express.raw({ type: 'image/png', limit: ICON_MAX }), async (request, response) => {
    const store = await iconStore(request, response); if (!store) return;
    if (!isPng(request.body)) return fail(response, 400, '請上傳 PNG 圖片（200KB 以內）');
    await saveIcon(store, request.body, 'upload');
    response.json({ ok: true });
  });

  // 從店家網站抓 /apple-touch-icon.png（只抓 PNG，不跟隨轉址，https 限定）
  app.post('/api/stores/:id/icon/fetch', async (request, response) => {
    const store = await iconStore(request, response); if (!store) return;
    let target;
    try { target = remoteUrl(store.url, '/apple-touch-icon.png'); } catch (error) { return fail(response, 400, error.message === '這家店還沒填網址' ? error.message : '店家網址必須是 https 才能抓取圖示'); }
    let buf;
    try {
      const res = await (config.fetchImpl ?? fetch)(target, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (!res.ok) return fail(response, 404, '店家網站沒有提供小圖示，請改用上傳');
      buf = Buffer.from(await res.arrayBuffer());
    } catch { return fail(response, 502, '連不上店家網站，請確認網址或改用上傳'); }
    if (!isPng(buf)) return fail(response, 400, '店家網站的圖示不是 PNG 或太大，請改用上傳');
    await saveIcon(store, buf, 'fetch');
    response.json({ ok: true });
  });

  app.delete('/api/stores/:id/icon', async (request, response) => {
    const store = await iconStore(request, response); if (!store) return;
    const removed = await db.tx(async (tx) => {
      const { rows } = await tx.query('DELETE FROM store_icon WHERE store_id = $1 RETURNING store_id', [store.id]);
      if (rows.length) await tx.query('INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
        ['store.icon', store.id, store.name, JSON.stringify({ how: 'remove' })]);
      return rows.length > 0;
    });
    response.json({ ok: true, removed });
  });

  // ---- 總覽數字 ----
  app.get('/api/summary', async (request, response) => {
    const { rows } = await db.query(`SELECT ${STORE_COLUMNS} FROM stores`);
    const today = taipeiToday(now());
    const counts = { building: 0, running: 0, paused: 0, ended: 0, total: rows.length };
    let mrr = 0;
    const attention = [];
    for (const row of rows) {
      counts[row.status] += 1;
      if (row.status === 'running') mrr += row.monthly_fee;
      const contract = contractInfo(row, today);
      if (contract.state === 'soon' || contract.state === 'expired') attention.push({ id: row.id, name: row.name, state: contract.state, daysLeft: contract.daysLeft });
    }
    attention.sort((a, b) => a.daysLeft - b.daysLeft);
    response.json({
      today,
      counts,
      mrr,
      expiringSoon: attention.filter((item) => item.state === 'soon').length,
      expired: attention.filter((item) => item.state === 'expired').length,
      attention,
    });
  });

  // ---- 異動紀錄 ----
  app.get('/api/audit', async (request, response) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(request.query.limit, 10) || 50));
    const { rows } = await db.query('SELECT id, at, action, store_id, store_name, detail FROM audit_log ORDER BY id DESC LIMIT $1', [limit]);
    response.json({ entries: rows });
  });

  app.use('/api', (request, response) => fail(response, 404, '找不到這個功能'));

  app.use(express.static(publicDir, { extensions: ['html'] }));

  app.use((error, request, response, next) => {
    if (error?.type === 'entity.parse.failed') return fail(response, 400, 'JSON 格式不正確');
    if (error?.type === 'entity.too.large') return fail(response, 413, '資料太大');
    if (error instanceof RemoteError) return fail(response, error.status, error.message);
    console.error(error);
    return fail(response, 500, '伺服器發生錯誤');
  });

  return app;
}
