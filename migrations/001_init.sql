-- 店家主表：一家店一筆。月費只計「運作中」的店家（開發期不收月費）。
CREATE TABLE IF NOT EXISTS stores (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  system_type    TEXT NOT NULL DEFAULT 'other',
  url            TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'building'
                   CHECK (status IN ('building', 'running', 'paused', 'ended')),
  monthly_fee    INTEGER NOT NULL DEFAULT 0 CHECK (monthly_fee BETWEEN 0 AND 1000000),
  contract_start DATE,
  contract_end   DATE,
  notes          TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (contract_end IS NULL OR contract_start IS NULL OR contract_end >= contract_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_store_name ON stores (lower(name));

-- 異動紀錄：新增、修改、刪除店家都會留一筆（修改只記有變動的欄位）。
-- store_name 另存一份，店家被刪除後紀錄仍看得懂。
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  action      TEXT NOT NULL,
  store_id    INTEGER,
  store_name  TEXT NOT NULL DEFAULT '',
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
