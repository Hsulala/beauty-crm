# 店家總覽 CRM

統一登錄與管理多家美業預約系統（禾域 HEYU、妍序 Skin 與日後新增的店家）的總覽後台。
目前是 v0.1：登錄店家、看數字、管理合約，不連動各店系統，也不合併程式。

## 功能

- 單一管理者登入（密碼放環境變數）。
- 店家清單：店名、系統類型、網址、運作狀態、月費、合約起訖、備註；可依狀態篩選。
- 總覽數字：運作中家數、每月經常性收入、30 日內到期、已過期。
- 月費只計「運作中」的店家（開發期不收月費，上線後才計入）。
- 合約到期提醒：以台北日期計算，30 日內標為即將到期。
- 異動紀錄：新增、修改（只記有變動的欄位）、刪除都會留紀錄。

## 部署到 Railway

1. 建立 GitHub 私有 repo（建議 `Hsulala/beauty-crm`），把這個資料夾的內容推上去。
2. Railway 新增專案，加入一個 PostgreSQL，再從這個 repo 新增服務。
3. 在服務的 Variables 設定：

   | 變數 | 說明 |
   | --- | --- |
   | `DATABASE_URL` | 從 PostgreSQL 服務引用（Railway 的 Variable Reference），不要手打 |
   | `ADMIN_PASSWORD` | 登入密碼，至少 12 個字元 |
   | `SESSION_SECRET` | 簽署登入工作階段，至少 32 個字元，可用 `openssl rand -hex 32` 產生 |

4. 部署完成後，資料表會在啟動時自動建立（migration 自動套用，不用手動執行）。
5. 第一次使用可帶入既有兩家店：在 Railway 服務的 Shell 執行 `npm run seed`。
   只會新增不存在的店名，已存在的不會被覆蓋。也可以跳過，直接在畫面上按「新增店家」。

健康檢查路徑是 `/healthz`。更換 `ADMIN_PASSWORD` 或 `SESSION_SECRET` 後，既有登入會全部失效。

## 本機開發

```bash
npm install
npm test
```

不想裝 PostgreSQL 時，可用內建的 PGlite 試用（資料存在 `.pglite/`，只限本機）：

```bash
USE_PGLITE=1 ADMIN_PASSWORD=至少十二個字元的密碼 SESSION_SECRET=$(openssl rand -hex 32) npm run dev
```

接著開啟 `http://localhost:3000`。要連真正的 PostgreSQL 時，改設 `DATABASE_URL`（範例見 `.env.example`）。

## 目錄

```
src/app.js        路由與安全標頭（登入、店家、總覽、異動紀錄）
src/server.js     啟動點：讀設定、套用 migration、開始服務
src/db.js         資料庫介面（pg 與 PGlite 共用同一組方法）
src/migrate.js    依序套用 migrations/*.sql
src/contract.js   合約到期判斷（台北日期）
src/validate.js   欄位驗證
src/auth.js       登入工作階段、登入失敗限制
src/seed.js       預先登錄既有店家（不覆蓋）
migrations/       資料庫結構，新增欄位請加新檔，不要改舊檔
public/           前端頁面（登入頁、總覽頁）
tests/            自動測試（npm test）
docs/HANDOFF.md   交接說明
```

## 驗證

```bash
npm test
```

測試用 PGlite 實際建表並啟動真的 server，涵蓋登入、驗證、合約到期、總覽數字與異動紀錄。
