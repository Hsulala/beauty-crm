# 店家總覽 CRM 交接說明

管理禾域 HEYU、妍序 Skin 等多家美業預約系統的總覽後台。只有 ULY 一人使用（私接案的維運），所以只有單一管理者帳號。

## 技術與部署
- Node.js（>=22）、Express 5、PostgreSQL（pg）。ES modules。
- 測試：`npm test`（node:test，PGlite 當測試資料庫，會啟動真的 server）。
- Railway：一個服務加一個 PostgreSQL。啟動時自動套用 migrations。環境變數見 README。
- 登入：密碼比對環境變數 `ADMIN_PASSWORD`，工作階段是簽章 Cookie（HttpOnly、SameSite=Lax、7 天）。連續輸錯 10 次封鎖 5 分鐘。

## 資料
- `system_types`：系統類型（可重複使用的範本），在後台「系統類型」分頁新增、修改、刪除，不用改程式。欄位：key（建立後不可改）、名稱、說明、程式 repo、是否已提供遠端管理介面（`remote_supported`）、排序。預設有 booking（預約型）、order（訂購型）、membership（會員場館型）、other（其他，不可刪）。
- `stores`：店家主表。`system_type` 外鍵指向 `system_types.key`，類型是「範本」、店家是「實際上線的一套部署」；一個類型底下可以有多家店。舊資料的 heyu、skin 在 migration 003 併入 booking；禾域、妍序的差異（臉部或身體、功能模組）由各店回報的模組決定，不靠類型區分。
- 店家頁（遠端管理）能不能用，看該店類型的 `remote_supported`，不再寫死在程式裡。
- `links`（migration 004）：原 Linkbase 的連結。一筆一個連結，同一項目有多個連結時用同樣的 `title`、不同的 `label`；`store_id` 有值就顯示在該店卡片上，店家被刪除時連結保留、改成未歸屬。刻意不存帳號密碼。API：`/api/links`（GET、POST）、`/api/links/:id`（PATCH、DELETE）、`/api/links/import`（匯入 Linkbase 備份檔）。匯入以網址去重（資料庫已有的、同一批重複的都略過，不覆蓋手動修改），備份檔裡的帳號密碼會被丟掉，只回報有幾個項目帶了帳密；匯入路徑的請求上限是 1MB，其他 API 是 32KB，且匯入要先登入才會讀內容。
- `audit_log`：異動紀錄。修改只記有變動的欄位；刪除會存整筆快照。連結匯入記一筆 `links.import`（筆數，不含內容）。
- 月費只計 `status = running` 的店家。合約到期天數以台北日期計算，30 日內算即將到期。
- migrations 只增不改：要加欄位就新增下一個編號的 `.sql` 檔。

## 合作慣例
- 一律繁體中文；畫面文字不用表情符號。
- 新功能先查現有程式再改；不可覆蓋已存的資料（修改只送有變動的欄位）。
- 交付：zip，先在乾淨 clone 驗證可套用、測試全過，檔名唯一。

## 規劃中（依序）
1. （已完成）每家店系統提供 `/api/remote/stats`（本月預約數）、`/api/remote/config`（讀）與 `PUT /api/remote/config`（改功能模組）。讀、寫用不同金鑰（`REMOTE_READ_KEY`、`REMOTE_WRITE_KEY`），每家店各一組；店家自己的後台改不了模組。尚未做：進帳數字、店名／主題色／logo 的遠端設定。
2. （部分完成）CRM「店家頁」可看單店本月預約數、遠端開關模組，改動寫入異動紀錄。尚未做：跨店總覽（一次呼叫所有店的 stats）。
3. 妍序整理：清掉根目錄舊檔、補測試、加店家設定表。
4. 資料層換 PostgreSQL、統一核心：等第三家店、單店成本吃掉月費或客人要跨店時再做。

## 遠端管理
- 店家端（禾域 `lib/remote-access.mjs`＋`server.mjs`、妍序 `src/remoteApi.js`）：Bearer 金鑰驗證，timing-safe 比對，連續失敗封鎖；金鑰未設定或少於 32 字元時整組介面回 404。
- CRM：`store_remote` 表以 AES-256-GCM 加密存金鑰（密鑰 `REMOTE_KEY_SECRET`，不可更換）；`src/remote.js` 只往店家網址的 origin 送、不跟隨轉址、https 限定（本機測試除外）。
- 兩家店回應格式一致：`stats` 為 `{ system, month, bookings: { total, cancelled } }`；`config` 為 `{ system, modules: { key: { label, enabled } } }`。新增模組只要店家端加定義，CRM 自動顯示。
- 預約數定義：total 為未取消（禾域含待確認、爽約；妍序含已確認、已完成），cancelled 為已取消（禾域含已婉拒）。

## 已知限制
- 目前不連動各店系統，數字都是手動登錄。
- 沒有多人帳號與權限；若之後有人接手維運再加。
- 登入失敗計數存在記憶體，服務重啟會歸零。
