// 密碼雜湊小工具：用 Node 內建的 crypto.scrypt，不用額外裝 bcrypt（bcrypt 要編譯原生模組，
// 在 Railway 這種容器化部署環境比較容易出狀況，內建的 scrypt 已經夠安全又不用額外依賴）。

const crypto = require('crypto');

const KEY_LENGTH = 64;

/** 產生「salt:hash」格式的字串存進資料庫，salt 每次都隨機產生，同一組密碼每次雜湊出來的值都不一樣 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

/** 驗證輸入的密碼是否跟資料庫存的雜湊值相符 */
function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  const hashBuffer = Buffer.from(hashHex, 'hex');
  const candidate = crypto.scryptSync(password, salt, KEY_LENGTH);
  // 長度不一致代表資料異常，先擋掉再比對，避免 timingSafeEqual 因長度不同直接丟例外
  if (candidate.length !== hashBuffer.length) return false;
  return crypto.timingSafeEqual(candidate, hashBuffer);
}

module.exports = { hashPassword, verifyPassword };
