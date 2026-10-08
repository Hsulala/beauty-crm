# 店家總覽 CRM 交接說明

管理禾域 HEYU、妍序 Skin 等多家美業預約系統的總覽後台。只有 ULY 一人使用（私接案的維運），所以只有單一管理者帳號。

## 技術與部署
- Node.js（>=22）、Express 5、PostgreSQL（pg）。ES modules。
- 測試：`npm test`（node:test，PGlite 當測試資料庫，會啟動真的 server）。
- Railway：一個服務加一個 PostgreSQL。啟動時自動套用 migrations。環境變數見 README。
- 登入：密碼比對環境變數 `ADMIN_PASSWORD`，工作階段是簽章 Cookie（HttpOnly、SameSite=Lax、7 天）。連續輸錯 10 次封鎖 5 分鐘。

## 資料
- `stores`：店家主表。系統類型 `system_type` 在程式端驗證（heyu、skin、other），新增類型只要改 `src/validate.js` 與前端選單，不需要 migration。
- `audit_log`：異動紀錄。修改只記有變動的欄位；刪除會存整筆快照。
- 月費只計 `status = running` 的店家。合約到期天數以台北日期計算，30 日內算即將到期。
- migrations 只增不改：要加欄位就新增 `002_xxx.sql`。

## 合作慣例
- 一律繁體中文；畫面文字不用表情符號。
- 新功能先查現有程式再改；不可覆蓋已存的資料（修改只送有變動的欄位）。
- 交付：zip，先在乾淨 clone 驗證可套用、測試全過，檔名唯一。

## 規劃中（依序）
1. 每家店系統提供受保護的管理介面：唯讀 `stats`（本月預約數、進帳）與可寫 `config`（模組開關、店名、主題色、logo）。讀、寫用不同金鑰，每家店各一組。
2. CRM 加入跨店總覽（呼叫各店 `stats`）與遠端模組開關，改動要寫入異動紀錄。
3. 妍序整理：清掉根目錄舊檔、補測試、加店家設定表。
4. 資料層換 PostgreSQL、統一核心：等第三家店、單店成本吃掉月費或客人要跨店時再做。

## 已知限制
- 目前不連動各店系統，數字都是手動登錄。
- 沒有多人帳號與權限；若之後有人接手維運再加。
- 登入失敗計數存在記憶體，服務重啟會歸零。
