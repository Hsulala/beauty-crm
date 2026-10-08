require('dotenv').config();
const { createApp } = require('./app');
const { pool } = require('./db');
const { runMigrations } = require('./migrate');
const scheduler = require('./scheduler');

async function main() {
  // 啟動時自動套用新的 migration（只會跑還沒跑過的編號檔），不需要再手動進 Railway shell。
  const ran = await runMigrations(pool);
  if (ran.length) console.log(`[server] 已套用 migration：${ran.join(', ')}`);

  const port = process.env.PORT || 3000;
  createApp().listen(port, () => {
    console.log(`[server] 妍序 Skin 預約系統啟動，port ${port}`);
    scheduler.start();
  });
}

main().catch((err) => {
  console.error('[server] 啟動失敗', err);
  process.exit(1);
});
