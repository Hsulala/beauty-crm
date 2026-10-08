-- 店家設定集中成一份：功能模組開關、店名、主題色都存在這裡（key / value）。
-- 沒有紀錄的設定一律使用程式內的預設值，所以既有店家升級後行為完全不變。
CREATE TABLE IF NOT EXISTS store_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 設定異動紀錄：誰、何時、改了什麼（只記有變動的項目）。
CREATE TABLE IF NOT EXISTS config_audit (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor   TEXT NOT NULL DEFAULT '',
  changes JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_audit_at ON config_audit (at DESC);
