-- 店家的 GitHub、Railway 網址（選填）。店家卡片上直接顯示「後台／GitHub／Railway」三個入口。
-- 後台＝既有的「網址」欄位；這裡不存任何帳號密碼。
ALTER TABLE stores ADD COLUMN IF NOT EXISTS github_url TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS railway_url TEXT NOT NULL DEFAULT '';
