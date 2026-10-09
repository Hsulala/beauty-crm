import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// 金鑰加密存放：AES-256-GCM，加密金鑰由環境變數 REMOTE_KEY_SECRET 衍生。
// 格式：v1.<iv>.<tag>.<密文>（皆為 base64url）。竄改或換了 secret 都會解不開。
const derive = (secret) => createHash('sha256').update(`crm-remote-key:${secret}`).digest();

export function seal(plain, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed, secret) {
  const [version, iv, tag, body, extra] = String(sealed ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !body || extra !== undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derive(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch { return null; }
}
