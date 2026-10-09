// 測試用：模擬一家店的 /api/remote/*（驗證 Bearer 金鑰、記錄收到的請求）。
import { createServer } from 'node:http';

export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);

export async function startFakeStore({ system = 'heyu' } = {}) {
  const state = {
    modules: { schedule: { label: '老師排班', enabled: false }, stats: { label: '營收數據', enabled: true } },
    requests: [],
    mode: 'ok', // ok | down | redirect | hang
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://x');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    state.requests.push({ method: request.method, path: url.pathname + url.search, token, body });
    const send = (status, value, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(value)); };
    if (state.mode === 'redirect') return send(302, {}, { location: 'https://elsewhere.example/steal' });
    if (state.mode === 'down') return send(500, { error: '內部錯誤' });
    const role = token === WRITE_KEY ? 'write' : token === READ_KEY ? 'read' : null;
    if (!role) return send(401, { error: '金鑰不正確' });
    if (request.method === 'GET' && url.pathname === '/api/remote/stats') return send(200, { system, month: url.searchParams.get('month'), bookings: { total: 7, cancelled: 1 } });
    if (request.method === 'GET' && url.pathname === '/api/remote/config') return send(200, { system, modules: state.modules });
    if (request.method === 'PUT' && url.pathname === '/api/remote/config') {
      if (role !== 'write') return send(403, { error: '這把金鑰只能讀取，不能修改設定' });
      let changed = false;
      for (const [name, value] of Object.entries(body.modules ?? {})) {
        if (!state.modules[name]) return send(400, { error: `沒有這個模組：${name}` });
        if (state.modules[name].enabled !== value) { state.modules[name].enabled = value; changed = true; }
      }
      return send(200, { ok: true, changed, system, modules: state.modules });
    }
    return send(404, { error: '找不到這個功能' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, state, stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}
