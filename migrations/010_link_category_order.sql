-- 入口頁分類按鈕的順序（可拖曳調整）。只存名稱與位置；沒在這裡的分類排在後面。
CREATE TABLE IF NOT EXISTS link_category_order (
  name     TEXT PRIMARY KEY CHECK (char_length(name) BETWEEN 1 AND 30),
  position INTEGER NOT NULL CHECK (position >= 0)
);
