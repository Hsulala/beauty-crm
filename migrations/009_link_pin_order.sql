-- 側邊欄「常用入口」的順序：沿用釘選的連結，數字小的在前；同數字再依名稱排。
ALTER TABLE links ADD COLUMN IF NOT EXISTS pin_order INTEGER NOT NULL DEFAULT 0;
