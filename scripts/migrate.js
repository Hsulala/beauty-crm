// 執行資料庫初始化：node scripts/migrate.js
// Railway 上第一次部署後，用 Railway 的 shell 或本機連正式資料庫執行一次即可。
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { hashPassword } = require('../src/authUtil');

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // 走 Railway 內部私有網路不需要 SSL（也不支援）；只有明確設定 PGSSL=require 才會啟用
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });

  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'schema.sql'), 'utf8');
  console.log('執行 migrations/schema.sql ...');
  await pool.query(sql);
  console.log('完成，資料表已建立／已是最新狀態。');

  // 第一次跑到「帳號＋密碼登入」這個版本時，admin_users 表會是空的，
  // 這裡自動用原本放在 ADMIN_PASSWORD 環境變數裡的密碼，建一組預設帳號讓老闆可以先登入，
  // 登入後請盡快到後台的「帳號設定」把帳號、密碼都改成自己的。
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admin_users');
  if (rows[0].count === 0) {
    const defaultUsername = process.env.ADMIN_DEFAULT_USERNAME || 'admin';
    const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
    await pool.query(
      'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
      [defaultUsername, hashPassword(defaultPassword)]
    );
    console.log(`已建立預設管理者帳號「${defaultUsername}」，密碼沿用原本的 ADMIN_PASSWORD，登入後請到後台盡快自行更改帳號密碼。`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration 失敗：', err);
  process.exit(1);
});
