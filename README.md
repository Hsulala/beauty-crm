# 妍序 Skin｜LINE 預約系統（基礎版）

LINE 官方帳號自動化預約系統：客戶用 LINE 選療程、選時段、系統自動避免時段衝突、自動同步 Google 日曆、到店前一天自動提醒。老闆用網頁管理後台看整週預約狀況。

## 目錄結構

```
src/
  server.js          啟動點，掛載所有路由
  db.js              PostgreSQL 連線
  line.js            LINE Messaging API 封裝
  googleCalendar.js  Google Calendar 同步
  scheduler.js        每日到店前提醒排程
  services/bookingService.js   核心邏輯：查詢時段、建立/取消預約
  routes/webhook.js   LINE webhook（客戶在 LINE 對話框互動）
  routes/liffApi.js   LIFF 頁面用的 API（查詢時段、送出預約）
  routes/adminApi.js  管理後台用的 API（登入、週總覽、取消預約）
public/
  liff/    客戶預約頁面（開在 LINE 內建瀏覽器）
  admin/   老闆管理後台（一般瀏覽器打開即可）
migrations/schema.sql  資料庫結構
scripts/migrate.js     執行資料庫初始化
```

## 上線前要準備的四樣東西

### 1. LINE 官方帳號 + Messaging API

1. 到 [LINE Developers Console](https://developers.line.biz/console/) 建立 Provider 與 Channel（Messaging API 類型）。
2. 「Messaging API」分頁取得 `Channel access token`（長期）與 `Channel secret`，填入環境變數 `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET`。
3. Webhook URL 設定為 `https://你的網域/webhook`，並開啟「Use webhook」。
4. 關閉「自動回應訊息」「加入好友的歡迎訊息」這類 LINE 官方內建的自動回覆，避免跟我們自己的機器人邏輯打架。

### 2. LIFF App

1. 在同一個 Channel 底下建立 LIFF App，Endpoint URL 填 `https://你的網域/liff/`，Size 選 `Full`。
2. 取得 LIFF ID，填入環境變數 `LIFF_ID`。

### 3. Google Calendar（Service Account）

1. 到 [Google Cloud Console](https://console.cloud.google.com/) 建立專案，啟用「Google Calendar API」。
2. 建立一組 Service Account，下載 JSON 金鑰。
3. 把 JSON 裡的 `client_email` 填入 `GOOGLE_SERVICE_ACCOUNT_EMAIL`；`private_key` 填入 `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`（貼上時保留 `\n`，不要手動換行）。
4. 老闆用自己的 Google 帳號打開 Google Calendar 設定，把這個 Service Account 的 email「新增為日曆的共用對象」，權限選「進行變更」，這樣程式才有權限寫入老闆的日曆。
5. `GOOGLE_CALENDAR_ID` 一般填 `primary` 即可（代表老闆的主要日曆）。

### 4. Railway 部署

1. 建立新 Railway 專案，新增一個 PostgreSQL 資料庫（Railway 會自動給 `DATABASE_URL`）。
2. 新增一個從這個程式碼倉庫部署的服務，把 `.env.example` 裡列的環境變數（除了 `DATABASE_URL`，那個 Railway 自動給）都設定好。
3. 部署完成後，打開 Railway 提供的 Shell（或本機把 `DATABASE_URL` 指向正式資料庫），執行一次：
   ```
   node scripts/migrate.js
   ```
   這會建立所有資料表，並塞入預設的療程與開放時段（可以之後在資料庫或未來版本的後台介面調整）。
4. `PUBLIC_BASE_URL` 填 Railway 給的網域，回頭去 LINE Developers Console 把 Webhook URL 跟 LIFF Endpoint URL 設定好。

## 老闆怎麼用

- **管理後台**：打開 `https://你的網域/admin`，輸入 `ADMIN_PASSWORD` 設定的密碼登入，就能看到本週時段總覽，點已預約的格子可以看詳情或取消。
- **調整開放時段**：目前版本開放時段存在 `availability_rules`（星期幾固定開放）與 `slot_overrides`（單日手動開關）兩張表，基礎版還沒有做視覺化的調整介面，需要調整時可以直接在資料庫執行 SQL，或請開發者協助——這塊如果之後常常需要老闆自己調，建議列入下一階段的加購項目。

## 客戶怎麼用

1. 加 LINE 官方帳號好友。
2. 在對話框輸入「我要預約」，機器人會列出療程選單。
3. 點選療程後，機器人回傳預約頁面連結，開啟後選日期、選時段、填姓名電話送出。
4. 預約成立後立刻收到 LINE 通知，系統同步寫入老闆的 Google 日曆，到店前一天自動收到提醒。

## 本機開發

```bash
npm install
cp .env.example .env   # 填入測試用的環境變數
node scripts/migrate.js
npm run dev
```

## 關於「一個時段只能一位客人」是怎麼保證的

不是只靠程式判斷「這個時段有沒有人訂」，而是在資料庫的 `bookings` 表上，對「同一天同一時段、狀態為已確認」建立了唯一索引（partial unique index）。就算兩個客人在同一瞬間送出同一個時段的預約請求，資料庫本身會擋下其中一筆、回傳錯誤，程式再把這個錯誤轉成「這個時段剛被別人訂走了，請重新選擇」的訊息。這比單純在程式碼裡「先查詢、確認沒人訂、再寫入」的做法更保險，因為後者在高併發下還是有機會兩邊都以為自己搶到了。

## 這個版本還沒做的事（未來可加購，見提案書第五節）

- 客戶免加 LINE 好友的電話號碼自助註冊（簡訊驗證碼）
- 會員等級／點數制度
- 管理後台裡可視覺化調整開放時段（目前要改資料庫）

## 功能模組與店家設定

店家設定（功能模組開關、店名、主題色）集中存在資料庫的 `store_config` 表，後台「功能模組」視窗（只有管理者看得到）可以調整。

- 目前的模組：`revenue`（營收數據）、`skinRecord`（皮膚紀錄）。預設都是開，升級後行為不變。
- 關閉的模組：側邊欄淡灰標示「未開通」，相關 API 回 403，資料保留，重新開啟即恢復。
- 主題色不設定時，維持妍序原本的粉色。
- 每次設定異動都會記在 `config_audit`（誰、何時、改了什麼）。
- API：`GET /api/admin/config`（登入即可讀）、`PUT /api/admin/config`（管理者，只改有帶的欄位）、`GET /api/admin/config/audit`（管理者）。

新增模組：在 `src/storeConfig.js` 的 `MODULES` 加一項、在需要守門的路由加 `requireModule('名稱')`、在側邊欄項目加 `data-module="名稱"`。

## 資料庫 migration

- `migrations/schema.sql` 是最早期的整包建表檔，含種子資料，只在第一次部署時手動執行（`node scripts/migrate.js`），不要重跑。
- 之後的結構變更放在 `migrations/002_xxx.sql`、`003_xxx.sql`…（三位數編號開頭），服務啟動時自動套用、每個檔案只跑一次（記在 `schema_migrations`），不需要再進 Railway shell。
- 已套用的 migration 檔不要再改；要調整就新增下一個編號。

## 開發與測試

```bash
npm install
npm test
```

測試使用 PGlite（PostgreSQL 的 WASM 版），不需要安裝資料庫：會先套用 `schema.sql` 與編號 migration，再啟動真的 app 打 API，涵蓋登入與權限、設定與模組、營收與皮膚紀錄的開關、同時搶同一時段只成功一筆、側邊欄結構。

本機想看畫面，可以用 `USE_PGLITE=1` 啟動（資料只在記憶體，不會保留），但需要自己先建 schema，最簡單的做法是直接看測試。

目錄新增：

```
src/app.js         組出 Express app（不開 port），測試與 server.js 共用
src/storeConfig.js 店家設定與功能模組
src/migrate.js     啟動時自動套用編號 migration
tests/             自動測試
docs/HANDOFF.md    交接說明
```
