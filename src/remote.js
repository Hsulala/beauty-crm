// 呼叫各店系統的遠端管理介面（/api/remote/*）。
// 只往店家網址的 origin 送；不跟隨轉址（避免金鑰被轉到別的網站）；正式環境只允許 https。
export class RemoteError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function remoteUrl(storeUrl, path) {
  let base;
  try { base = new URL(storeUrl); } catch { throw new RemoteError('這家店還沒填網址', 400); }
  const local = LOCAL_HOSTS.has(base.hostname);
  if (base.protocol !== 'https:' && !(local && base.protocol === 'http:')) throw new RemoteError('店家網址必須是 https 才能遠端管理', 400);
  return new URL(path, base.origin).toString();
}

export async function callStore({ url, key, path, method = 'GET', body, timeoutMs = 8000, fetchImpl = fetch }) {
  const target = remoteUrl(url, path);
  let response;
  try {
    response = await fetchImpl(target, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new RemoteError(error?.name === 'TimeoutError' ? '店家系統回應逾時，請稍後再試' : '連不上店家系統，請確認網址與服務是否運作中');
  }
  if (response.status >= 300 && response.status < 400) throw new RemoteError('店家系統回應轉址，已停止（請確認網址是最終網址）');
  const data = await response.json().catch(() => null);
  if (response.ok && data) return data;
  const detail = typeof data?.error === 'string' ? data.error : '';
  if (response.status === 401) throw new RemoteError('店家系統拒絕金鑰，請確認這裡存的金鑰與店家系統的環境變數一致');
  if (response.status === 403) throw new RemoteError(detail || '這把金鑰沒有這個操作的權限');
  if (response.status === 404) throw new RemoteError('店家系統沒有開啟遠端管理（尚未部署新版，或沒設定金鑰環境變數）');
  if (response.status === 429) throw new RemoteError(detail || '嘗試次數過多，請稍後再試');
  if (response.status === 400) throw new RemoteError(detail || '店家系統拒絕了這個設定', 400);
  throw new RemoteError(detail || `店家系統發生錯誤（${response.status}）`);
}
