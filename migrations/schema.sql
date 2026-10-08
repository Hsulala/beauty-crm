-- 妍序 Skin｜客製化皮膚管理 — 預約系統資料庫結構（基礎版）
-- 設計重點：
--   1) bookings 用「slot_date + start_time」的部分唯一索引，在資料庫層級保證
--      同一個時段只會有一筆「有效」預約，就算兩個客人同時搶同一時段，
--      資料庫也會擋掉第二筆，不會只靠程式邏輯判斷（避免競速狀況）。
--   2) customers 用 phone 當作跨管道（LINE／未來電話註冊）辨識同一人的欄位，
--      line_user_id 允許為空，方便日後加購電話註冊時沿用同一張表。

CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  line_user_id  TEXT UNIQUE,
  name          TEXT NOT NULL,
  phone         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true
);

-- 老闆開放的時段模板：哪幾天、幾點到幾點開放預約
-- weekday: 0=週日 ... 6=週六
CREATE TABLE IF NOT EXISTS availability_rules (
  id          SERIAL PRIMARY KEY,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true
);

-- 手動關閉某一天某個時段（例如老闆臨時請假），優先權高於 availability_rules
CREATE TABLE IF NOT EXISTS slot_overrides (
  id          SERIAL PRIMARY KEY,
  slot_date   DATE NOT NULL,
  start_time  TIME NOT NULL,
  is_open     BOOLEAN NOT NULL,
  UNIQUE (slot_date, start_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id                SERIAL PRIMARY KEY,
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  service_id        INTEGER NOT NULL REFERENCES services(id),
  slot_date         DATE NOT NULL,
  start_time        TIME NOT NULL,
  status            TEXT NOT NULL DEFAULT 'confirmed'
                       CHECK (status IN ('confirmed', 'cancelled')),
  google_event_id   TEXT,
  reminder_sent_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at      TIMESTAMPTZ
);

-- 關鍵防呆：同一天同一時段，最多只能有一筆「confirmed」的預約
CREATE UNIQUE INDEX IF NOT EXISTS uniq_confirmed_slot
  ON bookings (slot_date, start_time)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings (slot_date);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings (customer_id);

-- 預設療程（老闆可之後在管理後台調整，這裡先放心智圖/Demo 裡用過的品項）
INSERT INTO services (name, duration_minutes, sort_order) VALUES
  ('韓式小氣泡深層清潔', 60, 1),
  ('杏仁酸溫和煥膚', 60, 2),
  ('玻尿酸精華導入', 60, 3),
  ('黑頭粉刺護理', 60, 4)
ON CONFLICT DO NOTHING;

-- 客戶療程項目擴充：補上分類／價格／備註欄位，讓預約頁可以照類別分頁顯示
ALTER TABLE services ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS price INTEGER;
ALTER TABLE services ADD COLUMN IF NOT EXISTS note TEXT;

-- 在補唯一限制之前，先把過去因為沒有唯一限制、重複執行舊版 migration 產生的同名重複列合併掉，
-- 不然加限制那一步會失敗（保留 id 最小的那一筆，把其他重複列的預約紀錄轉過去再刪除）
DO $$
DECLARE
  dup RECORD;
BEGIN
  FOR dup IN
    SELECT name, MIN(id) AS keep_id
    FROM services
    GROUP BY name
    HAVING COUNT(*) > 1
  LOOP
    UPDATE bookings SET service_id = dup.keep_id
    WHERE service_id IN (SELECT id FROM services WHERE name = dup.name AND id <> dup.keep_id);
    DELETE FROM services WHERE name = dup.name AND id <> dup.keep_id;
  END LOOP;
END $$;

-- 原本 name 沒有唯一限制，補上才能用 ON CONFLICT (name) 做安全的重複執行／更新
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'services_name_key'
  ) THEN
    ALTER TABLE services ADD CONSTRAINT services_name_key UNIQUE (name);
  END IF;
END $$;

-- 舊的 4 個示範療程已被客戶提供的完整菜單取代，停用但保留（避免舊預約紀錄的關聯壞掉）
-- 只在它們仍是「沒設過價格的原始示範資料」時才停用。
-- 加上這個條件是為了避免每次部署都強制覆蓋：
-- 萬一老闆之後自己想重新啟用其中一項並設好價格，就不該再被 migration 關掉。
UPDATE services SET is_active = false
WHERE name IN ('韓式小氣泡深層清潔', '杏仁酸溫和煥膚', '玻尿酸精華導入', '黑頭粉刺護理')
  AND COALESCE(price, 0) = 0
  AND is_active = true;

-- 客戶完整菜單（2026/09 更新）：基礎管理／一般管理／高端管理／特殊管理
-- 【重要】這裡用 DO NOTHING 而不是 DO UPDATE：這組只是「第一次建置時的預設菜單」。
-- 一旦上線，價格／分類／時長就以老闆在後台「品項管理」改的為準，
-- 每次部署都不會再去覆蓋它。若之後真要整批改價，請直接在後台改，不要改這裡。
INSERT INTO services (name, duration_minutes, sort_order, category, price, note) VALUES
  ('水飛梭深層清潔', 60, 10, '基礎管理', 1080, NULL),
  ('皮膚管理入門',   90, 20, '一般管理', 1580, NULL),
  ('客製化精華導入', 90, 30, '高端管理', 1880, NULL),
  ('葉綠素換膚',     60, 40, '特殊管理', 1880, NULL),
  ('女神水光肌',     60, 41, '特殊管理', 1980, NULL),
  ('碳酸啵啵',       60, 42, '特殊管理', 1980, NULL),
  ('女神啵啵',       90, 43, '特殊管理', 2680, NULL),
  ('深海膠原',       60, 44, '特殊管理', 2280, NULL),
  ('冰雪星辰',       60, 45, '特殊管理', 2280, NULL),
  ('液態皮秒',       60, 46, '特殊管理', 2380, NULL),
  ('藻針換膚',       90, 47, '特殊管理', 2580, '有修復期7-10天不等')
ON CONFLICT (name) DO NOTHING;

-- 加價購項目：跟一般療程共用 services 表，用 is_addon 標記「不能單獨預約、
-- 只能加選在某個主療程上」，不會出現在 Step 1 的療程分類清單裡。
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_addon BOOLEAN NOT NULL DEFAULT false;

INSERT INTO services (name, duration_minutes, sort_order, category, price, is_addon) VALUES
  ('臉部按摩', 15, 90, '加價購', 299, true),
  ('頭部撥筋', 15, 91, '加價購', 499, true)
ON CONFLICT (name) DO NOTHING;

-- 客人在「預約摘要確認頁」可以留言給店家（例如：第一次來、想加強某個部位等等）
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS note TEXT;

-- 一筆預約可以加選多個加價購項目，記錄當時加選的項目與價格
-- （價格獨立存一份是為了避免日後老闆調整 services.price 時，改到舊預約的歷史金額）
CREATE TABLE IF NOT EXISTS booking_addons (
  id          SERIAL PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id  INTEGER NOT NULL REFERENCES services(id),
  name        TEXT NOT NULL,
  price       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_booking_addons_booking ON booking_addons (booking_id);

-- 管理後台帳號：原本只有一組寫在環境變數裡的共用密碼，改成帳號＋密碼登入，
-- 讓老闆自己在後台就能改帳號密碼，不用再找工程師去 Railway 改環境變數。
-- password_hash 存的是 scrypt 雜湊（格式 "salt:hash"），不是明碼，詳見 src/authUtil.js。
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 帳號權限分級：owner（主控管理者）品項價格、時段範本、帳號管理都能改；
-- staff（操作人員）只處理日常預約——月曆、時段開關、公休，不能碰價格或新增帳號，
-- 這樣老闆開一組帳號給店員，也不用擔心被改到價格或多開一組管理者帳號。
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_role_check'
  ) THEN
    ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN ('owner', 'staff'));
  END IF;
END $$;

-- 固定公休日：整個星期幾都不開放（例如「每週日公休」），跟 availability_rules 分開存一張表，
-- 這樣管理後台只要開關「星期幾」就好，不用把那天所有時段規則都刪掉再救回來。
CREATE TABLE IF NOT EXISTS weekly_holidays (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6)
);

-- 臨時公休／臨時加開：針對「單一日期」整天覆蓋開放狀態，優先權高於 weekly_holidays。
--   is_closed = true  → 這天公休（就算原本不是固定公休日，也整天不開放）
--   is_closed = false → 這天臨時開放（就算原本是固定公休日，或當天完全沒設星期規則，也整天開放）
-- 沒有這張表對應的日期，就照 weekly_holidays／availability_rules 的預設規則走。
CREATE TABLE IF NOT EXISTS date_closures (
  slot_date  DATE PRIMARY KEY,
  is_closed  BOOLEAN NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 預設開放時段（週一到週六，11:00~18:00 每小時一個時段，週日不開放）
-- 【重要】這組只在「資料表完全是空的」時才會寫入，也就是只有第一次建置才套用。
-- 早期版本這裡是無條件 INSERT + ON CONFLICT DO NOTHING，但這張表當時沒有唯一限制，
-- ON CONFLICT 等於沒作用，導致每次部署都把這組預設時段塞回去，
-- 把老闆在後台設好的時段範本（例如每 2.5 小時）洗成每小時都開放。
-- 補上唯一限制 ＋ 改成只在空表時寫入，才能真正避免覆蓋老闆的設定。
DO $$
BEGIN
  -- 補唯一限制前先清掉可能已經累積的重複列（保留 id 最小的那筆）
  DELETE FROM availability_rules a
  USING availability_rules b
  WHERE a.weekday = b.weekday AND a.start_time = b.start_time AND a.id > b.id;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'availability_rules_weekday_time_key'
  ) THEN
    ALTER TABLE availability_rules
      ADD CONSTRAINT availability_rules_weekday_time_key UNIQUE (weekday, start_time);
  END IF;
END $$;

INSERT INTO availability_rules (weekday, start_time)
SELECT weekday, start_time::time
FROM generate_series(1, 6) AS weekday,
     unnest(ARRAY['11:00','13:00','14:00','15:00','16:00','17:00']) AS start_time
WHERE NOT EXISTS (SELECT 1 FROM availability_rules)
ON CONFLICT (weekday, start_time) DO NOTHING;

-- ============================================================
-- 基本狀態諮詢（客人預約時填寫）＋ 皮膚狀態紀錄（老闆看診後填寫）
-- 兩者的「題目／代碼」本身都可以在後台編輯（新增/停用），
-- 客人／老闆實際填寫的答案另外存，就算之後題目被改掉，舊紀錄的文字內容也不會不見。
-- ============================================================

-- 客人預約時要填寫的問卷題目（例如「肌膚類型」「有無肌膚過敏史」）
CREATE TABLE IF NOT EXISTS intake_questions (
  id           SERIAL PRIMARY KEY,
  label        TEXT NOT NULL UNIQUE,
  input_type   TEXT NOT NULL DEFAULT 'multi' CHECK (input_type IN ('single', 'multi')),
  allow_other  BOOLEAN NOT NULL DEFAULT true,   -- 是否顯示一個補充說明的文字欄位
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT true
);

-- 每個題目底下的勾選選項
CREATE TABLE IF NOT EXISTS intake_question_options (
  id           SERIAL PRIMARY KEY,
  question_id  INTEGER NOT NULL REFERENCES intake_questions(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

-- 客人實際填寫的答案，存文字（selected_labels）而不是只存 option id，
-- 這樣之後後台改了選項內容，舊的預約紀錄還是看得懂當時勾了什麼。
CREATE TABLE IF NOT EXISTS booking_intake_answers (
  id             SERIAL PRIMARY KEY,
  booking_id     INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES intake_questions(id),
  question_label TEXT NOT NULL,
  selected_labels TEXT[] NOT NULL DEFAULT '{}',
  other_text     TEXT,
  UNIQUE (booking_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_intake_answers_booking ON booking_intake_answers (booking_id);

-- 老闆／店員看診後填寫的「皮膚狀態紀錄」代碼清單（例如 A正常、B油性…），代碼本身可在後台編輯
CREATE TABLE IF NOT EXISTS skin_note_codes (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (code)
);

-- 每筆預約，老闆填的詳細皮膚狀態紀錄（每個代碼可以填一段簡短備註）＋ 三個建議欄位
CREATE TABLE IF NOT EXISTS booking_skin_notes (
  booking_id            INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  code_values           JSONB NOT NULL DEFAULT '{}',
  treatment_suggestion  TEXT,
  care_procedure        TEXT,
  product_suggestion    TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 預設題目與選項：依照客戶提供的紙本「基本狀態諮詢」表單建立
INSERT INTO intake_questions (label, input_type, allow_other, sort_order) VALUES
  ('肌膚類型', 'multi', true, 10),
  ('有無肌膚過敏史', 'single', true, 20),
  ('有無做過美容護理', 'single', false, 30),
  ('近期手術／雷射／醫美／藻針／果酸換膚等相關療程', 'single', true, 40),
  ('使用保養品／化妝品習慣', 'single', true, 50),
  ('身體健康狀況', 'multi', true, 60),
  ('飲食生活習慣', 'multi', false, 70)
ON CONFLICT DO NOTHING;

INSERT INTO intake_question_options (question_id, label, sort_order)
SELECT q.id, opt.label, opt.sort_order
FROM intake_questions q
JOIN (VALUES
  ('肌膚類型', '油性', 1), ('肌膚類型', '乾性', 2), ('肌膚類型', '中性', 3), ('肌膚類型', '混合性', 4),
  ('肌膚類型', '敏感性', 5), ('肌膚類型', '表皮層厚', 6), ('肌膚類型', '表皮層薄', 7), ('肌膚類型', '表皮層適中', 8),
  ('肌膚類型', '白皙', 9), ('肌膚類型', '蠟黃', 10), ('肌膚類型', '暗沉', 11), ('肌膚類型', '潮紅', 12),
  ('有無肌膚過敏史', '無', 1), ('有無肌膚過敏史', '有', 2),
  ('有無做過美容護理', '經常', 1), ('有無做過美容護理', '偶爾', 2), ('有無做過美容護理', '從來沒有', 3),
  ('近期手術／雷射／醫美／藻針／果酸換膚等相關療程', '無', 1), ('近期手術／雷射／醫美／藻針／果酸換膚等相關療程', '有', 2),
  ('使用保養品／化妝品習慣', '無', 1), ('使用保養品／化妝品習慣', '有', 2),
  ('身體健康狀況', '孕婦／哺乳期', 1), ('身體健康狀況', '睡眠品質不佳', 2), ('身體健康狀況', '長期疲勞', 3),
  ('身體健康狀況', '肩頸僵硬', 4), ('身體健康狀況', '更年期障礙', 5), ('身體健康狀況', '肝臟機能不佳', 6),
  ('身體健康狀況', '腸胃機能不佳', 7),
  ('飲食生活習慣', '咖啡、茶', 1), ('飲食生活習慣', '吸菸', 2), ('飲食生活習慣', '酒', 3),
  ('飲食生活習慣', '甜食', 4), ('飲食生活習慣', '辛辣', 5), ('飲食生活習慣', '油炸', 6)
) AS opt(question_label, label, sort_order) ON opt.question_label = q.label
WHERE NOT EXISTS (SELECT 1 FROM intake_question_options);

-- 預設代碼：依照客戶提供的紙本「皮膚狀態紀錄」表單建立
INSERT INTO skin_note_codes (code, label, sort_order) VALUES
  ('A', '正常', 1), ('B', '油性', 2), ('C', '乾性', 3), ('D', '混合性', 4),
  ('E', '敏感性', 5), ('F', '粉刺', 6), ('G', '面皰', 7), ('H', '疤痕', 8),
  ('I', '過敏', 9), ('J', '黑斑', 10), ('K', '雀斑', 11), ('L', '缺水', 12),
  ('M', '肉芽', 13), ('N', '鬆弛', 14), ('O', '黑眼圈', 15), ('P', '角質厚', 16),
  ('Q', '毛孔粗大', 17), ('R', '微血管擴張', 18), ('S', '其他', 19)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- 「完成」狀態：老闆在後台按下「標記完成」後，代表療程真的做完了。
-- 只有算進「完成」的預約才計入營收；「已確認但還沒做」的預約不算營收。
-- ============================================================

-- 把原本只允許 confirmed / cancelled 的檢查放寬，加入 completed
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_status_check') THEN
    ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
  END IF;
  ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
    CHECK (status IN ('confirmed', 'completed', 'cancelled'));
END $$;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 原本這個唯一索引只保護「confirmed」不會被同時段重複預約，
-- 標記完成後狀態會變成 completed，如果索引沒有一起涵蓋，
-- 理論上同一個時段可能又被重新預約一次。改成「只要不是 cancelled 就佔用這個時段」。
DROP INDEX IF EXISTS uniq_confirmed_slot;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_slot
  ON bookings (slot_date, start_time)
  WHERE status <> 'cancelled';

-- ============================================================
-- 預約開放範圍：預設客人只能預約「本月」，老闆要主動開放才能預約到下個月（或更後面）。
-- 存的是「開放到哪個月份為止」，每次讀取時會自動跟「本月」取較大值，
-- 這樣就算老闆完全不管它，月份自然往前走的時候也不會被鎖死在過去的月份。
-- ============================================================
CREATE TABLE IF NOT EXISTS booking_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
