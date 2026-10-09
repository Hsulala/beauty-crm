-- 店家小圖示（PNG，最大 200KB）。另開一張表，避免異動紀錄與店家列表帶著圖片資料。
CREATE TABLE IF NOT EXISTS store_icon (
  store_id   INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
