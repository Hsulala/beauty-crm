const express = require('express');
const path = require('path');
const cookieSession = require('cookie-session');

const webhookRoute = require('./routes/webhook');
const liffApiRoute = require('./routes/liffApi');
const adminApiRoute = require('./routes/adminApi');

// 組出 Express app（不開 port、不啟動排程），讓測試可以直接使用。
function createApp() {
  const app = express();

  // Railway 的邊緣代理會終止 TLS，把原始 protocol 放在 X-Forwarded-Proto header 裡轉給我們，
  // 沒有這行 req.protocol 在 Railway 上永遠只會看到 http，組出來的圖片網址就會是 http 開頭，
  // LINE 的伺服器不會去抓非 https 的圖片網址。
  app.set('trust proxy', true);

  // 重要：webhook 路由要放在 express.json() 之前註冊。
  // @line/bot-sdk 的 middleware 需要自己讀取原始 body 來驗證簽章，
  // 如果先被 express.json() 解析過一次，簽章驗證會失敗。
  app.use('/webhook', webhookRoute);

  app.use(express.json());
  app.use(
    cookieSession({
      name: 'yanxu_admin_session',
      secret: process.env.SESSION_SECRET || 'dev-secret',
      maxAge: 12 * 60 * 60 * 1000, // 12 小時
    })
  );

  app.use('/api', liffApiRoute);
  app.use('/api/admin', adminApiRoute);

  // LIFF 預約頁與管理後台的靜態前端
  app.use('/liff', express.static(path.join(__dirname, '..', 'public', 'liff')));
  app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
  // 療程前／後須知的圖片，給 LINE 推播訊息用的公開網址（LINE 伺服器要能連到這裡抓圖）
  app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));

  app.get('/', (req, res) => {
    res.send('妍序 Skin 預約系統運作中。客戶預約頁在 /liff，管理後台在 /admin。');
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  return app;
}

module.exports = { createApp };
