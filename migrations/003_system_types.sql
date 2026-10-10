-- 系統類型：可重複使用的「範本」（預約型、訂購型…）。店家掛在某個類型底下。
-- 類型可在後台新增、修改；key 建立後不可改（店家以 key 關聯）。
CREATE TABLE IF NOT EXISTS system_types (
  key              TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,29}$'),
  label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 30),
  description      TEXT NOT NULL DEFAULT '',
  repo             TEXT NOT NULL DEFAULT '',
  remote_supported BOOLEAN NOT NULL DEFAULT false,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO system_types (key, label, description, repo, remote_supported, sort_order) VALUES
  ('booking',    '預約型',     '客人在 LINE 上預約時段的店（按摩、皮膚管理等）。', 'Hsulala/heyu-booking、Hsulala/skin-crm', true,  10),
  ('order',      '訂購型',     '賣商品、接 B2B／B2C 訂單的店（戀鳳爪、麻辣醬等）。', 'Hsulala/lianfengzhua-line-bot',         true,  20),
  ('membership', '會員場館型', '會員制場館：會員卡、教練排班、場地租借（Ultra Fitness 等）。', 'Hsulala/ultra-crm',                 false, 30),
  ('other',      '其他',       '還沒歸類的系統。',                               '',                                     false, 90)
ON CONFLICT (key) DO NOTHING;

-- 舊資料：原本以店名當類型的 heyu、skin 併入預約型。
UPDATE stores SET system_type = 'booking' WHERE system_type IN ('heyu', 'skin');

ALTER TABLE stores
  ADD CONSTRAINT stores_system_type_fk FOREIGN KEY (system_type) REFERENCES system_types (key);
