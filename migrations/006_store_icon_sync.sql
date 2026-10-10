-- 顧客頁 Logo 同步狀態。圖片仍存 store_icon；這張表只記錄是否已套用到店家系統。
CREATE TABLE IF NOT EXISTS store_icon_sync (
  store_id       INTEGER PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  state          TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'synced', 'error')),
  desired_hash   CHAR(64),
  remote_hash    CHAR(64),
  error          TEXT NOT NULL DEFAULT '',
  attempted_at   TIMESTAMPTZ,
  synced_at      TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
