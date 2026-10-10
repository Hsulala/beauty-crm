-- 連結：把原本散在各處的後台、部署、文件入口集中到總覽。
-- 一筆一個連結；同一個項目有多個連結時，用同樣的 title、不同的 label 分開存。
-- store_id 有值就代表屬於某家店（顯示在店家卡片上）；店家被刪除時連結保留，改成未歸屬。
-- 刻意不存帳號密碼：密碼請放密碼管理器。
CREATE TABLE IF NOT EXISTS links (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  label       TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL CHECK (char_length(url) BETWEEN 1 AND 500),
  category    TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'hidden')),
  pinned      BOOLEAN NOT NULL DEFAULT false,
  store_id    INTEGER REFERENCES stores(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_links_store ON links (store_id);
