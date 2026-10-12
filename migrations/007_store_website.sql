-- 店家官網網址（選填）。和「網址」不同：「網址」是店家系統（後台／顧客頁）的位置，CRM 用它遠端同步；
-- 官網只用來從官網抓 Logo，不會拿來送任何金鑰。
ALTER TABLE stores ADD COLUMN IF NOT EXISTS website TEXT NOT NULL DEFAULT '';
