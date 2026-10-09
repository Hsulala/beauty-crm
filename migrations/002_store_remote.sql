-- 各店系統的遠端管理金鑰（加密存放，金鑰本身不會回傳到畫面）。
-- 讀取金鑰只能看數字與模組狀態；寫入金鑰才能改功能模組。兩把各店各自獨立。
CREATE TABLE IF NOT EXISTS store_remote (
  store_id      INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  read_key_enc  TEXT,
  write_key_enc TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
