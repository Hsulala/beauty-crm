const { pool } = require('../db');
const googleCalendar = require('../googleCalendar');
const { weekdayOf, addDays, daysInMonth } = require('../dateUtil');

const WEEKDAY_NAMES = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// 當一天完全沒有 availability_rules（例如原本沒開放的週日），但被老闆臨時加開整天時，
// 用這組預設時段當模板（跟原本 migration seed 的平日時段一致），讓臨時開放的日子也有時段可選。
const DEFAULT_DAILY_TIMES = ['11:00:00', '13:00:00', '14:00:00', '15:00:00', '16:00:00', '17:00:00'];

async function listServices() {
  const { rows } = await pool.query(
    `SELECT id, name, duration_minutes, category, price, note, is_addon, sort_order
     FROM services WHERE is_active = true ORDER BY sort_order, id`
  );
  return rows;
}

async function findOrCreateCustomerByLine({ lineUserId, name, phone }) {
  const existing = await pool.query('SELECT * FROM customers WHERE line_user_id = $1', [lineUserId]);
  if (existing.rows[0]) {
    // 姓名/電話有更新的話一併更新，維持資料最新
    if (name || phone) {
      await pool.query(
        'UPDATE customers SET name = COALESCE($2, name), phone = COALESCE($3, phone) WHERE id = $1',
        [existing.rows[0].id, name, phone]
      );
    }
    return existing.rows[0];
  }
  const inserted = await pool.query(
    'INSERT INTO customers (line_user_id, name, phone) VALUES ($1, $2, $3) RETURNING *',
    [lineUserId, name || '（尚未提供姓名）', phone || null]
  );
  return inserted.rows[0];
}

// 未來加購「電話自助註冊」時，會多一個 findOrCreateCustomerByPhone，
// 邏輯上直接沿用同一張 customers 表，用 phone 欄位辨識是否為同一人。

/** 預約頁載入時用：這位 LINE 使用者之前有沒有留過姓名/電話，有的話讓表單自動帶入 */
async function getCustomerProfileByLine(lineUserId) {
  const { rows } = await pool.query(
    `SELECT name, phone FROM customers WHERE line_user_id = $1`,
    [lineUserId]
  );
  if (!rows[0]) return null;
  // 還沒真的填過名字的（首次加好友時系統自動塞的預設值）就當作沒有資料，不要帶入表單
  const placeholder = '（尚未提供姓名）';
  return {
    name: rows[0].name === placeholder ? '' : rows[0].name || '',
    phone: rows[0].phone || '',
  };
}

// ---------- 預約開放範圍 ----------

/** 客人目前最多能預約到哪個月份（'YYYY-MM'），永遠至少是本月，老闆開放更後面才會延伸 */
async function getBookingOpenUntilMonth() {
  const { rows } = await pool.query(
    `SELECT to_char(CURRENT_DATE AT TIME ZONE 'Asia/Taipei', 'YYYY-MM') AS current_month`
  );
  const currentMonth = rows[0].current_month;
  const settingRes = await pool.query(`SELECT value FROM booking_settings WHERE key = 'open_until_month'`);
  const stored = settingRes.rows[0] ? settingRes.rows[0].value : null;
  return stored && stored > currentMonth ? stored : currentMonth;
}

/** 換算成實際的最後可預約日期（該月最後一天），給比較日期用比較方便 */
async function getBookingOpenUntilDate() {
  const monthStr = await getBookingOpenUntilMonth();
  const [y, m] = monthStr.split('-').map(Number);
  const lastDay = daysInMonth(y, m);
  return `${monthStr}-${String(lastDay).padStart(2, '0')}`;
}

/** 老闆開放預約到某個月份為止（例如開放下個月）；只會讓範圍往後延，不會拿來縮短範圍 */
async function setBookingOpenUntilMonth(monthStr) {
  await pool.query(
    `INSERT INTO booking_settings (key, value) VALUES ('open_until_month', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [monthStr]
  );
  return getBookingOpenUntilMonth();
}

// ---------- 客戶管理 ----------

/** 客戶名單＋統計：總預約數（不含取消）、完成數、累積營收（只算完成的）、第一次／最後一次到店日期 */
async function listCustomersWithStats(search) {
  const params = [];
  let where = '';
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where = 'WHERE c.name ILIKE $1 OR c.phone ILIKE $1';
  }
  const { rows } = await pool.query(
    `SELECT
       c.id, c.name, c.phone, to_char(c.created_at, 'YYYY-MM-DD') AS created_at,
       COUNT(b.id) FILTER (WHERE b.status <> 'cancelled')::int AS total_bookings,
       COUNT(b.id) FILTER (WHERE b.status = 'completed')::int AS completed_bookings,
       COALESCE(SUM(CASE WHEN b.status = 'completed' THEN s.price ELSE 0 END), 0)
         + COALESCE(SUM(CASE WHEN b.status = 'completed' THEN addon.total ELSE 0 END), 0) AS total_revenue,
       to_char(MAX(b.slot_date) FILTER (WHERE b.status <> 'cancelled'), 'YYYY-MM-DD') AS last_visit,
       to_char(MIN(b.slot_date) FILTER (WHERE b.status <> 'cancelled'), 'YYYY-MM-DD') AS first_visit
     FROM customers c
     LEFT JOIN bookings b ON b.customer_id = c.id
     LEFT JOIN services s ON s.id = b.service_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(price), 0) AS total FROM booking_addons WHERE booking_id = b.id
     ) addon ON true
     ${where}
     GROUP BY c.id
     ORDER BY last_visit DESC NULLS LAST, c.created_at DESC`,
    params
  );
  return rows;
}

/** 單一客戶的完整檔案：基本資料 ＋ 全部歷史預約（含每次的問卷答案／皮膚紀錄） */
async function getCustomerDetail(customerId) {
  const custRes = await pool.query(
    `SELECT id, name, phone, line_user_id, to_char(created_at, 'YYYY-MM-DD') AS created_at
     FROM customers WHERE id = $1`,
    [customerId]
  );
  const customer = custRes.rows[0];
  if (!customer) return null;

  const bookingsRes = await pool.query(
    `SELECT b.id, to_char(b.slot_date, 'YYYY-MM-DD') AS slot_date, b.start_time, b.status, b.note,
            to_char(b.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at,
            s.name AS service_name, s.price,
            COALESCE((
              SELECT json_agg(json_build_object('name', ba.name, 'price', ba.price))
              FROM booking_addons ba WHERE ba.booking_id = b.id
            ), '[]'::json) AS addons
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.customer_id = $1
     ORDER BY b.slot_date DESC, b.start_time DESC`,
    [customerId]
  );

  const bookingIds = bookingsRes.rows.map((r) => r.id);
  const intakeMap = new Map();
  const skinNotesMap = new Map();
  if (bookingIds.length) {
    const intakeRes = await pool.query(
      `SELECT booking_id, question_label, selected_labels, other_text
       FROM booking_intake_answers WHERE booking_id = ANY($1::int[]) ORDER BY id`,
      [bookingIds]
    );
    for (const row of intakeRes.rows) {
      if (!intakeMap.has(row.booking_id)) intakeMap.set(row.booking_id, []);
      intakeMap.get(row.booking_id).push(row);
    }
    const notesRes = await pool.query(
      `SELECT * FROM booking_skin_notes WHERE booking_id = ANY($1::int[])`,
      [bookingIds]
    );
    for (const row of notesRes.rows) skinNotesMap.set(row.booking_id, row);
  }

  const bookings = bookingsRes.rows.map((b) => ({
    ...b,
    intakeAnswers: intakeMap.get(b.id) || [],
    skinNotes: skinNotesMap.get(b.id) || null,
  }));

  return { customer, bookings };
}

/**
 * 判斷某一天是不是整天公休，以及公休的原因（固定公休日 or 臨時公休/開放）。
 * 優先權：date_closures（單日手動設定）> weekly_holidays（每週固定公休）。
 */
async function getDayClosure(dateStr) {
  const weekday = weekdayOf(dateStr);

  const override = await pool.query(
    'SELECT is_closed FROM date_closures WHERE slot_date = $1',
    [dateStr]
  );
  if (override.rows[0]) {
    return { isClosed: override.rows[0].is_closed, type: 'adhoc' };
  }

  const weekly = await pool.query('SELECT 1 FROM weekly_holidays WHERE weekday = $1', [weekday]);
  if (weekly.rows[0]) {
    return { isClosed: true, type: 'weekly' };
  }

  return { isClosed: false, type: null };
}

/**
 * 取得某一天所有「已開放」的時段，並標出哪些已經被訂走。
 * 開放規則（由外到內）：date_closures（單日整天覆蓋）> weekly_holidays（每週固定公休）
 * > availability_rules（星期幾固定開放）疊上 slot_overrides（單一時段手動開/關）。
 *
 * includeClosed：給管理後台用，true 的話也會把被老闆手動關閉的時段一起回傳（status:'closed'），
 * 這樣後台才看得到「這個時段本來有開，但被關掉了」，客人端（LIFF）維持 false，直接看不到才對。
 */
async function getSlotsForDate(dateStr, includeClosed = false) {
  const weekday = weekdayOf(dateStr);

  const dayClosure = await getDayClosure(dateStr);
  if (dayClosure.isClosed) {
    // 整天公休（固定公休日或臨時公休），不管前台後台都沒有可預約時段。
    return [];
  }

  const rules = await pool.query(
    'SELECT start_time FROM availability_rules WHERE weekday = $1 AND is_active = true ORDER BY start_time',
    [weekday]
  );
  let baseTimes = rules.rows.map((r) => r.start_time);
  // 這天原本完全沒有星期規則（例如週日），但被老闆臨時整天開放，給一組預設時段模板可以選
  if (baseTimes.length === 0 && dayClosure.type === 'adhoc') {
    baseTimes = DEFAULT_DAILY_TIMES;
  }

  const overrides = await pool.query(
    'SELECT start_time, is_open FROM slot_overrides WHERE slot_date = $1',
    [dateStr]
  );
  const overrideMap = new Map(overrides.rows.map((o) => [o.start_time, o.is_open]));

  const booked = await pool.query(
    `SELECT start_time FROM bookings WHERE slot_date = $1 AND status <> 'cancelled'`,
    [dateStr]
  );
  const bookedSet = new Set(booked.rows.map((b) => b.start_time));

  // 基礎時段來自星期規則（或預設模板），若當天有 override 也要納入(即使原本星期規則沒開，老闆手動加開的情況)
  const timeSet = new Set(baseTimes);
  for (const [time, isOpen] of overrideMap.entries()) {
    if (isOpen) timeSet.add(time);
  }

  const slots = [...timeSet]
    .filter((time) => includeClosed || overrideMap.get(time) !== false) // 客人端：手動關閉的時段直接排除
    .sort()
    .map((time) => ({
      date: dateStr,
      startTime: time,
      status: bookedSet.has(time)
        ? 'booked'
        : overrideMap.get(time) === false
        ? 'closed'
        : 'open',
    }));

  return slots;
}

/**
 * 給管理後台「時段範本設定」用：取得目前每個星期幾預設開放的時段清單。
 * 回傳格式 { 0: ['11:00:00', ...], 1: [...], ..., 6: [...] }（0=週日...6=週六）
 */
async function getAvailabilityRules() {
  const { rows } = await pool.query(
    'SELECT weekday, start_time FROM availability_rules WHERE is_active = true ORDER BY weekday, start_time'
  );
  const rules = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const row of rows) {
    rules[row.weekday].push(row.start_time);
  }
  return rules;
}

/**
 * 設定某個星期幾預設開放的時段（整組取代，不是新增/刪除單一時段）。
 * times 是這個星期幾「應該開放」的完整時段清單，例如 ['10:00','11:30']。
 * 這改的是「範本」，不會動到已經排定的預約，也不會影響已經對某一天做過的臨時開/關（slot_overrides 優先權比這個高）。
 */
async function setAvailabilityForWeekday(weekday, times) {
  const normalized = [...new Set((times || []).map((t) => (t.length === 5 ? `${t}:00` : t)))].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM availability_rules WHERE weekday = $1', [weekday]);
    for (const time of normalized) {
      await client.query(
        'INSERT INTO availability_rules (weekday, start_time, is_active) VALUES ($1, $2, true)',
        [weekday, time]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 設定/取消「固定公休日」：isClosed=true 表示這個星期幾整天公休 */
async function setWeeklyHoliday(weekday, isClosed) {
  if (isClosed) {
    await pool.query('INSERT INTO weekly_holidays (weekday) VALUES ($1) ON CONFLICT DO NOTHING', [weekday]);
  } else {
    await pool.query('DELETE FROM weekly_holidays WHERE weekday = $1', [weekday]);
  }
}

/** 取得目前所有固定公休的星期幾（0=週日...6=週六） */
async function getWeeklyHolidays() {
  const { rows } = await pool.query('SELECT weekday FROM weekly_holidays ORDER BY weekday');
  return rows.map((r) => r.weekday);
}

/**
 * 設定「臨時公休／臨時開放」單一日期整天的狀態。
 * action = 'close'：這天整天公休（就算原本不是固定公休日）
 * action = 'open' ：這天整天開放（就算原本是固定公休日，或當天完全沒有星期規則）
 * action = 'reset'：移除這天的手動設定，恢復跟著固定公休日／星期規則走
 */
async function setDateClosure(dateStr, action) {
  if (action === 'reset') {
    await pool.query('DELETE FROM date_closures WHERE slot_date = $1', [dateStr]);
    return;
  }
  const isClosed = action === 'close';
  await pool.query(
    `INSERT INTO date_closures (slot_date, is_closed) VALUES ($1, $2)
     ON CONFLICT (slot_date) DO UPDATE SET is_closed = EXCLUDED.is_closed`,
    [dateStr, isClosed]
  );
}

/**
 * 老闆在後台手動開關某一天某個時段。
 * action = 'close'：關掉這個時段（就算星期規則本來有開，也會被 override 蓋掉）
 * action = 'open'：確保這個時段是開放的（用在原本星期規則沒開、想臨時加開的情況）
 * action = 'reset'：移除手動設定，恢復成跟著星期規則走
 */
async function setSlotOverride(dateStr, startTime, action) {
  if (action === 'reset') {
    await pool.query('DELETE FROM slot_overrides WHERE slot_date = $1 AND start_time = $2', [dateStr, startTime]);
    return;
  }
  const isOpen = action === 'open';
  await pool.query(
    `INSERT INTO slot_overrides (slot_date, start_time, is_open) VALUES ($1, $2, $3)
     ON CONFLICT (slot_date, start_time) DO UPDATE SET is_open = EXCLUDED.is_open`,
    [dateStr, startTime, isOpen]
  );
}

/**
 * 建立預約。用資料庫的 partial unique index (slot_date, start_time) WHERE status='confirmed'
 * 當作最後一道防線：就算兩個人同時搶同一時段、程式邏輯層的檢查來不及擋下，
 * 資料庫也會讓其中一筆 INSERT 失敗（unique violation, code 23505），
 * 這是保證「一時段一客人」在高併發下依然成立的關鍵。
 */
async function createBooking({ customerId, serviceId, slotDate, startTime, addonServiceIds = [], note, intakeAnswers }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const svcRes = await client.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    const service = svcRes.rows[0];
    if (!service) throw Object.assign(new Error('療程不存在'), { code: 'SERVICE_NOT_FOUND' });

    const custRes = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    const customer = custRes.rows[0];
    if (!customer) throw Object.assign(new Error('客戶不存在'), { code: 'CUSTOMER_NOT_FOUND' });

    const trimmedNote = note && String(note).trim() ? String(note).trim().slice(0, 500) : null;

    // 防止有人繞過前端限制、直接打 API 預約還沒開放的月份（例如老闆還沒開放下個月）
    const openUntilDate = await getBookingOpenUntilDate();
    if (slotDate > openUntilDate) {
      throw Object.assign(new Error('這個月份還沒開放預約，請選擇較近期的日期'), { code: 'MONTH_NOT_OPEN' });
    }

    let bookingId;
    try {
      const insertRes = await client.query(
        `INSERT INTO bookings (customer_id, service_id, slot_date, start_time, status, note)
         VALUES ($1, $2, $3, $4, 'confirmed', $5) RETURNING id`,
        [customerId, serviceId, slotDate, startTime, trimmedNote]
      );
      bookingId = insertRes.rows[0].id;
    } catch (err) {
      if (err.code === '23505') {
        // 這個時段剛好在此刻被別人搶走了
        throw Object.assign(new Error('這個時段剛剛被別人預約走了，請重新選擇時段'), {
          code: 'SLOT_TAKEN',
        });
      }
      throw err;
    }

    // 升級體驗項目：把當下的名稱／價格存進 booking_addons，不會影響時段本身（同一個時段仍然只算一組預約）
    let addons = [];
    const uniqueAddonIds = [...new Set((addonServiceIds || []).map(Number).filter(Boolean))];
    if (uniqueAddonIds.length) {
      const addonRes = await client.query(
        `SELECT id, name, price FROM services WHERE id = ANY($1::int[]) AND is_addon = true AND is_active = true`,
        [uniqueAddonIds]
      );
      addons = addonRes.rows;
      for (const addon of addons) {
        await client.query(
          `INSERT INTO booking_addons (booking_id, service_id, name, price) VALUES ($1, $2, $3, $4)`,
          [bookingId, addon.id, addon.name, addon.price]
        );
      }
    }

    // 客人填的「基本狀態諮詢」問卷，跟預約本身存在同一筆交易裡，預約沒成立就不會留下孤兒答案
    await saveBookingIntakeAnswers(client, bookingId, intakeAnswers);

    await client.query('COMMIT');

    // 日曆同步放在交易 commit 之後執行：就算 Google Calendar 呼叫失敗，
    // 預約本身已經成立不會被卡住，之後可以在管理後台看到「日曆未同步」再手動補。
    let googleEventId = null;
    try {
      googleEventId = await googleCalendar.createBookingEvent({
        slotDate,
        startTime,
        durationMinutes: service.duration_minutes,
        customerName: customer.name,
        phone: customer.phone,
        serviceName: addons.length
          ? `${service.name}（升級體驗：${addons.map((a) => a.name).join('、')}）`
          : service.name,
      });
      if (googleEventId) {
        await pool.query('UPDATE bookings SET google_event_id = $1 WHERE id = $2', [googleEventId, bookingId]);
      }
    } catch (err) {
      console.error('[bookingService] Google 日曆同步失敗', err.message);
    }

    return { id: bookingId, service, customer, slotDate, startTime, googleEventId, addons, note: trimmedNote };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function cancelBooking(bookingId) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  const booking = rows[0];
  if (!booking) throw Object.assign(new Error('找不到這筆預約'), { code: 'NOT_FOUND' });
  if (booking.status === 'completed') {
    throw Object.assign(new Error('這筆預約已經標記完成，不能再取消'), { code: 'ALREADY_COMPLETED' });
  }

  await pool.query(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
    [bookingId]
  );
  if (booking.google_event_id) {
    await googleCalendar.deleteBookingEvent(booking.google_event_id);
  }
  return booking;
}

/**
 * 老闆／店員在後台按下「標記完成」：代表療程真的做完了。
 * 只有標記完成的預約才會算進營收，也才會觸發「療程後須知」的 LINE 推播。
 */
async function completeBooking(bookingId) {
  const { rows } = await pool.query(
    `SELECT b.*, c.line_user_id, c.name AS customer_name, s.name AS service_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE b.id = $1`,
    [bookingId]
  );
  const booking = rows[0];
  if (!booking) throw Object.assign(new Error('找不到這筆預約'), { code: 'NOT_FOUND' });
  if (booking.status === 'cancelled') {
    throw Object.assign(new Error('這筆預約已經取消，不能標記完成'), { code: 'ALREADY_CANCELLED' });
  }
  if (booking.status === 'completed') {
    return booking; // 已經是完成狀態了，不用重複處理，直接回傳現況
  }

  await pool.query(
    `UPDATE bookings SET status = 'completed', completed_at = now() WHERE id = $1`,
    [bookingId]
  );
  booking.status = 'completed';
  return booking;
}

/** 給管理後台用：某一週的所有時段＋預約狀態，用來畫出時段總覽 */
async function getWeekOverview(weekStartDateStr) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(weekStartDateStr, i));
  }

  const result = {};
  for (const date of dates) {
    const dayClosure = await getDayClosure(date);
    const slots = await getSlotsForDate(date, true); // 後台要看得到被關閉的時段，才能點擊重新開放
    // 補上已預約時段的客戶/療程資訊，管理後台點格子要看得到細節
    const detailed = await Promise.all(
      slots.map(async (slot) => {
        if (slot.status !== 'booked') return slot;
        const { rows } = await pool.query(
          `SELECT b.id, b.google_event_id, b.note, b.status, b.completed_at,
                  c.name AS customer_name, c.phone, s.name AS service_name
           FROM bookings b
           JOIN customers c ON c.id = b.customer_id
           JOIN services s ON s.id = b.service_id
           WHERE b.slot_date = $1 AND b.start_time = $2 AND b.status <> 'cancelled'`,
          [date, slot.startTime]
        );
        return { ...slot, booking: rows[0] || null };
      })
    );
    result[date] = {
      weekday: WEEKDAY_NAMES[weekdayOf(date)],
      isClosed: dayClosure.isClosed,
      closureType: dayClosure.type,
      slots: detailed,
    };
  }
  return result;
}

/**
 * 給客戶端（LIFF 預約頁）用：某一週每天的開放時段＋是否已被訂走，
 * 跟 getWeekOverview 不同的是「不」附帶其他客人的姓名/電話，避免外流給其他客戶。
 */
async function getPublicWeekOverview(weekStartDateStr) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    dates.push(addDays(weekStartDateStr, i));
  }

  const result = {};
  for (const date of dates) {
    const dayClosure = await getDayClosure(date);
    const slots = await getSlotsForDate(date);
    result[date] = { weekday: WEEKDAY_NAMES[weekdayOf(date)], isClosed: dayClosure.isClosed, slots };
  }
  return result;
}

/** 給管理後台「單日詳情」用：某一天的公休狀態、完整時段(含關閉)、以及當天營收 */
async function getDayDetail(dateStr) {
  const dayClosure = await getDayClosure(dateStr);
  const slots = await getSlotsForDate(dateStr, true);
  const detailed = await Promise.all(
    slots.map(async (slot) => {
      if (slot.status !== 'booked') return slot;
      const { rows } = await pool.query(
        `SELECT b.id, b.google_event_id, b.note, b.status, b.completed_at,
                c.name AS customer_name, c.phone, s.name AS service_name, s.price
         FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         JOIN services s ON s.id = b.service_id
         WHERE b.slot_date = $1 AND b.start_time = $2 AND b.status <> 'cancelled'`,
        [dateStr, slot.startTime]
      );
      return { ...slot, booking: rows[0] || null };
    })
  );

  // 只有「已標記完成」的預約才算進營收，單純「已確認但還沒做」的不算
  const revenueRes = await pool.query(
    `SELECT
       COALESCE(SUM(s.price), 0) AS service_total,
       COALESCE((
         SELECT SUM(ba.price) FROM booking_addons ba
         JOIN bookings b2 ON b2.id = ba.booking_id
         WHERE b2.slot_date = $1 AND b2.status = 'completed'
       ), 0) AS addon_total
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.slot_date = $1 AND b.status = 'completed'`,
    [dateStr]
  );
  const revenue = Number(revenueRes.rows[0].service_total) + Number(revenueRes.rows[0].addon_total);

  return {
    date: dateStr,
    weekday: WEEKDAY_NAMES[weekdayOf(dateStr)],
    isClosed: dayClosure.isClosed,
    closureType: dayClosure.type,
    revenue,
    slots: detailed,
  };
}

/**
 * 給管理後台「月曆總覽」用：整個月每一天的公休狀態／預約數／營收／時段數，
 * 以及整月的統計摘要（本月預約數、公休天數、可預約時段數、時段使用率）。
 */
async function getMonthOverview(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const totalDays = daysInMonth(year, month);
  const firstDateStr = `${monthStr}-01`;
  const lastDateStr = `${monthStr}-${String(totalDays).padStart(2, '0')}`;
  const exclusiveEnd = addDays(lastDateStr, 1);

  const weeklyHolidays = new Set(await getWeeklyHolidays());

  // 用 to_char 直接在資料庫端把日期轉成 'YYYY-MM-DD' 文字，不透過 JS 的 Date 物件解析，
  // 避免又踩到本專案已經修過一次的時區換算誤差（詳見 dateUtil.js 開頭的說明）。
  const closuresRes = await pool.query(
    `SELECT to_char(slot_date, 'YYYY-MM-DD') AS slot_date, is_closed
     FROM date_closures WHERE slot_date >= $1 AND slot_date < $2`,
    [firstDateStr, exclusiveEnd]
  );
  const closureMap = new Map(closuresRes.rows.map((r) => [r.slot_date, r.is_closed]));

  const bookingsRes = await pool.query(
    `SELECT b.id, b.status, to_char(b.slot_date, 'YYYY-MM-DD') AS slot_date, s.price AS service_price,
            COALESCE((SELECT SUM(price) FROM booking_addons WHERE booking_id = b.id), 0) AS addon_price
     FROM bookings b
     JOIN services s ON s.id = b.service_id
     WHERE b.status <> 'cancelled' AND b.slot_date >= $1 AND b.slot_date < $2`,
    [firstDateStr, exclusiveEnd]
  );
  const perDay = new Map();
  for (const row of bookingsRes.rows) {
    const key = row.slot_date;
    const entry = perDay.get(key) || { count: 0, revenue: 0 };
    entry.count += 1;
    // 營收只算「已標記完成」的預約，單純已確認但還沒做的不算進去
    if (row.status === 'completed') {
      entry.revenue += Number(row.service_price || 0) + Number(row.addon_price || 0);
    }
    perDay.set(key, entry);
  }

  const days = {};
  let totalBookings = 0;
  let closedDays = 0;
  let totalSlots = 0;
  let bookedSlots = 0;
  let totalRevenue = 0;

  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${monthStr}-${String(d).padStart(2, '0')}`;
    const weekday = weekdayOf(dateStr);
    const explicit = closureMap.has(dateStr) ? closureMap.get(dateStr) : null;
    const isClosed = explicit !== null ? explicit : weeklyHolidays.has(weekday);
    const closureType = explicit !== null ? 'adhoc' : weeklyHolidays.has(weekday) ? 'weekly' : null;

    const bookingInfo = perDay.get(dateStr) || { count: 0, revenue: 0 };
    totalBookings += bookingInfo.count;
    totalRevenue += bookingInfo.revenue;
    if (isClosed) closedDays += 1;

    let slotsTotal = 0;
    let slotsBooked = 0;
    if (!isClosed) {
      const slots = await getSlotsForDate(dateStr, true);
      slotsTotal = slots.length;
      slotsBooked = slots.filter((s) => s.status === 'booked').length;
      totalSlots += slotsTotal;
      bookedSlots += slotsBooked;
    }

    days[dateStr] = {
      weekday,
      isClosed,
      closureType,
      bookingsCount: bookingInfo.count,
      revenue: bookingInfo.revenue,
      slotsTotal,
      slotsBooked,
    };
  }

  const utilizationRate = totalSlots > 0 ? Math.round((bookedSlots / totalSlots) * 100) : 0;

  return {
    month: monthStr,
    stats: {
      totalBookings,
      closedDays,
      availableSlots: totalSlots,
      utilizationRate,
      totalRevenue,
    },
    days,
  };
}

/** 給「營收明細」用：某個月份所有已完成預約的逐筆明細（方便對帳），含療程/升級體驗細項與小計 */
async function getMonthRevenueDetail(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const totalDays = daysInMonth(year, month);
  const firstDateStr = `${monthStr}-01`;
  const lastDateStr = `${monthStr}-${String(totalDays).padStart(2, '0')}`;
  const exclusiveEnd = addDays(lastDateStr, 1);

  const { rows } = await pool.query(
    `SELECT b.id, to_char(b.slot_date, 'YYYY-MM-DD') AS slot_date, b.start_time,
            to_char(b.completed_at, 'YYYY-MM-DD HH24:MI') AS completed_at,
            c.name AS customer_name, s.name AS service_name, s.price,
            COALESCE((
              SELECT json_agg(json_build_object('name', ba.name, 'price', ba.price))
              FROM booking_addons ba WHERE ba.booking_id = b.id
            ), '[]'::json) AS addons
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE b.status = 'completed' AND b.slot_date >= $1 AND b.slot_date < $2
     ORDER BY b.slot_date, b.start_time`,
    [firstDateStr, exclusiveEnd]
  );

  return rows.map((r) => ({
    ...r,
    total: Number(r.price || 0) + (r.addons || []).reduce((sum, a) => sum + Number(a.price || 0), 0),
  }));
}

/**
 * 給客人自己的「查看我的預約」頁用：用 LINE 使用者 ID 找到對應的客戶，
 * 回傳這位客人未來（含今天）所有還沒取消的預約，不會看到其他客人的任何資料。
 */
async function getUpcomingBookingsForLineUser(lineUserId) {
  // 「今天」用台北時區在資料庫端算（跟 scheduler.js 判斷明天提醒用同一套時區邏輯），
  // 不用 JS 的 Date 物件本地時間，避免伺服器（Railway 預設 UTC）跟客人所在的台北時區對不上。
  // 日期也用 to_char 轉成文字，同樣是為了不透過 JS Date 物件解析。
  const { rows } = await pool.query(
    `SELECT b.id, to_char(b.slot_date, 'YYYY-MM-DD') AS slot_date, b.start_time, b.note,
            s.name AS service_name, s.duration_minutes, s.price,
            COALESCE((
              SELECT json_agg(json_build_object('name', ba.name, 'price', ba.price))
              FROM booking_addons ba WHERE ba.booking_id = b.id
            ), '[]'::json) AS addons
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE c.line_user_id = $1 AND b.status = 'confirmed'
       AND b.slot_date >= (CURRENT_DATE AT TIME ZONE 'Asia/Taipei')::date
     ORDER BY b.slot_date ASC, b.start_time ASC`,
    [lineUserId]
  );

  return rows.map((r) => ({
    id: r.id,
    date: r.slot_date,
    startTime: r.start_time,
    serviceName: r.service_name,
    durationMinutes: r.duration_minutes,
    price: r.price,
    addons: r.addons || [],
    note: r.note,
  }));
}

/**
 * 給管理後台「品項管理」用：取得所有療程／升級體驗項目（含已停用的），
 * 讓老闆可以看到全部品項並重新啟用，跟給客人看的 listServices（只給啟用中的）分開。
 */
async function listAllServicesForAdmin() {
  const { rows } = await pool.query(
    `SELECT id, name, duration_minutes, category, price, note, is_addon, is_active, sort_order
     FROM services ORDER BY is_addon, sort_order, id`
  );
  return rows;
}

/** 新增療程／升級體驗項目 */
async function createService({ name, category, price, durationMinutes, isAddon, sortOrder, note }) {
  const { rows } = await pool.query(
    `INSERT INTO services (name, category, price, duration_minutes, is_addon, sort_order, note, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING *`,
    [name, category || null, price === '' || price === undefined ? null : price, durationMinutes || 60, !!isAddon, sortOrder || 0, note || null]
  );
  return rows[0];
}

/**
 * 更新療程／升級體驗項目的內容（名稱、價格、時長、類別等）。
 * 只改 services 這張表本身，不會動到 booking_addons 裡已經存的歷史金額，
 * 所以調價不會影響客人之前已經完成的預約單價。
 */
async function updateService(id, { name, category, price, durationMinutes, isAddon, sortOrder, note }) {
  const { rows } = await pool.query(
    `UPDATE services SET
       name = $2, category = $3, price = $4, duration_minutes = $5,
       is_addon = $6, sort_order = $7, note = $8
     WHERE id = $1 RETURNING *`,
    [
      id,
      name,
      category || null,
      price === '' || price === undefined ? null : price,
      durationMinutes || 60,
      !!isAddon,
      sortOrder || 0,
      note || null,
    ]
  );
  if (!rows[0]) throw Object.assign(new Error('找不到這個項目'), { code: 'NOT_FOUND' });
  return rows[0];
}

/** 啟用／停用療程項目（軟刪除，保留舊預約跟這個品項的關聯不會壞掉） */
async function setServiceActive(id, isActive) {
  const { rows } = await pool.query('UPDATE services SET is_active = $2 WHERE id = $1 RETURNING *', [id, isActive]);
  if (!rows[0]) throw Object.assign(new Error('找不到這個項目'), { code: 'NOT_FOUND' });
  return rows[0];
}

// ---------- 基本狀態諮詢（客人預約時填寫） ----------

/** 給 LIFF 預約頁用：目前啟用的題目＋選項，依 sort_order 排序 */
async function getActiveIntakeQuestions() {
  const { rows: questions } = await pool.query(
    `SELECT id, label, input_type, allow_other FROM intake_questions
     WHERE is_active = true ORDER BY sort_order, id`
  );
  if (!questions.length) return [];
  const { rows: options } = await pool.query(
    `SELECT id, question_id, label FROM intake_question_options
     WHERE question_id = ANY($1::int[]) ORDER BY sort_order, id`,
    [questions.map((q) => q.id)]
  );
  return questions.map((q) => ({
    ...q,
    options: options.filter((o) => o.question_id === q.id).map((o) => ({ id: o.id, label: o.label })),
  }));
}

/** 建立預約時一併存進客人填寫的問卷答案（在同一個交易 client 裡執行，跟預約成功與否綁在一起） */
async function saveBookingIntakeAnswers(client, bookingId, answers) {
  if (!Array.isArray(answers) || !answers.length) return;
  const { rows: questions } = await client.query('SELECT id, label FROM intake_questions');
  const byId = new Map(questions.map((q) => [q.id, q.label]));
  for (const ans of answers) {
    const questionId = Number(ans.questionId);
    const label = byId.get(questionId);
    if (!label) continue; // 忽略前端傳來但後台已經找不到的題目 id
    const selected = Array.isArray(ans.selectedLabels) ? ans.selectedLabels.slice(0, 30) : [];
    const otherText = ans.otherText && String(ans.otherText).trim() ? String(ans.otherText).trim().slice(0, 300) : null;
    if (!selected.length && !otherText) continue; // 完全沒填就不用存一筆空的
    await client.query(
      `INSERT INTO booking_intake_answers (booking_id, question_id, question_label, selected_labels, other_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (booking_id, question_id) DO UPDATE SET selected_labels = $4, other_text = $5`,
      [bookingId, questionId, label, selected, otherText]
    );
  }
}

/** 給管理後台單筆預約詳情用：這位客人當初填寫的問卷答案 */
async function getBookingIntakeAnswers(bookingId) {
  const { rows } = await pool.query(
    `SELECT question_label, selected_labels, other_text
     FROM booking_intake_answers WHERE booking_id = $1
     ORDER BY id`,
    [bookingId]
  );
  return rows;
}

/** 後台管理：所有題目（含停用的），給「皮膚紀錄欄位設定」畫面用 */
async function listIntakeQuestionsForAdmin() {
  const { rows: questions } = await pool.query(
    `SELECT id, label, input_type, allow_other, sort_order, is_active
     FROM intake_questions ORDER BY sort_order, id`
  );
  const { rows: options } = await pool.query(
    `SELECT id, question_id, label, sort_order FROM intake_question_options ORDER BY sort_order, id`
  );
  return questions.map((q) => ({
    ...q,
    options: options.filter((o) => o.question_id === q.id),
  }));
}

async function createIntakeQuestion({ label, inputType, allowOther, sortOrder }) {
  const { rows } = await pool.query(
    `INSERT INTO intake_questions (label, input_type, allow_other, sort_order)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [label, inputType === 'single' ? 'single' : 'multi', !!allowOther, sortOrder || 0]
  );
  return rows[0];
}

async function updateIntakeQuestion(id, { label, inputType, allowOther, sortOrder, isActive }) {
  const { rows } = await pool.query(
    `UPDATE intake_questions SET
       label = $2, input_type = $3, allow_other = $4, sort_order = $5, is_active = $6
     WHERE id = $1 RETURNING *`,
    [id, label, inputType === 'single' ? 'single' : 'multi', !!allowOther, sortOrder || 0, isActive !== false]
  );
  if (!rows[0]) throw Object.assign(new Error('找不到這個題目'), { code: 'NOT_FOUND' });
  return rows[0];
}

async function deleteIntakeQuestion(id) {
  await pool.query('DELETE FROM intake_questions WHERE id = $1', [id]);
}

async function addIntakeOption(questionId, label, sortOrder) {
  const { rows } = await pool.query(
    `INSERT INTO intake_question_options (question_id, label, sort_order) VALUES ($1, $2, $3) RETURNING *`,
    [questionId, label, sortOrder || 0]
  );
  return rows[0];
}

async function deleteIntakeOption(optionId) {
  await pool.query('DELETE FROM intake_question_options WHERE id = $1', [optionId]);
}

// ---------- 皮膚狀態紀錄（老闆／店員看診後填寫） ----------

async function listSkinNoteCodes(activeOnly = false) {
  const { rows } = await pool.query(
    `SELECT id, code, label, sort_order, is_active FROM skin_note_codes
     ${activeOnly ? 'WHERE is_active = true' : ''} ORDER BY sort_order, id`
  );
  return rows;
}

async function createSkinNoteCode({ code, label, sortOrder }) {
  const { rows } = await pool.query(
    `INSERT INTO skin_note_codes (code, label, sort_order) VALUES ($1, $2, $3) RETURNING *`,
    [code, label, sortOrder || 0]
  );
  return rows[0];
}

async function updateSkinNoteCode(id, { code, label, sortOrder, isActive }) {
  const { rows } = await pool.query(
    `UPDATE skin_note_codes SET code = $2, label = $3, sort_order = $4, is_active = $5
     WHERE id = $1 RETURNING *`,
    [id, code, label, sortOrder || 0, isActive !== false]
  );
  if (!rows[0]) throw Object.assign(new Error('找不到這個代碼'), { code: 'NOT_FOUND' });
  return rows[0];
}

async function deleteSkinNoteCode(id) {
  await pool.query('DELETE FROM skin_note_codes WHERE id = $1', [id]);
}

async function getBookingSkinNotes(bookingId) {
  const { rows } = await pool.query('SELECT * FROM booking_skin_notes WHERE booking_id = $1', [bookingId]);
  return rows[0] || { booking_id: bookingId, code_values: {}, treatment_suggestion: null, care_procedure: null, product_suggestion: null };
}

async function upsertBookingSkinNotes(bookingId, { codeValues, treatmentSuggestion, careProcedure, productSuggestion }) {
  const { rows } = await pool.query(
    `INSERT INTO booking_skin_notes (booking_id, code_values, treatment_suggestion, care_procedure, product_suggestion, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (booking_id) DO UPDATE SET
       code_values = $2, treatment_suggestion = $3, care_procedure = $4, product_suggestion = $5, updated_at = now()
     RETURNING *`,
    [bookingId, JSON.stringify(codeValues || {}), treatmentSuggestion || null, careProcedure || null, productSuggestion || null]
  );
  return rows[0];
}

module.exports = {
  listServices,
  listAllServicesForAdmin,
  createService,
  updateService,
  setServiceActive,
  findOrCreateCustomerByLine,
  getSlotsForDate,
  getDayClosure,
  setSlotOverride,
  setWeeklyHoliday,
  getWeeklyHolidays,
  setDateClosure,
  createBooking,
  cancelBooking,
  completeBooking,
  getWeekOverview,
  getPublicWeekOverview,
  getDayDetail,
  getMonthOverview,
  getUpcomingBookingsForLineUser,
  getAvailabilityRules,
  setAvailabilityForWeekday,
  getActiveIntakeQuestions,
  saveBookingIntakeAnswers,
  getBookingIntakeAnswers,
  listIntakeQuestionsForAdmin,
  createIntakeQuestion,
  updateIntakeQuestion,
  deleteIntakeQuestion,
  addIntakeOption,
  deleteIntakeOption,
  listSkinNoteCodes,
  createSkinNoteCode,
  updateSkinNoteCode,
  deleteSkinNoteCode,
  getBookingSkinNotes,
  upsertBookingSkinNotes,
  listCustomersWithStats,
  getCustomerDetail,
  getMonthRevenueDetail,
  getCustomerProfileByLine,
  getBookingOpenUntilMonth,
  getBookingOpenUntilDate,
  setBookingOpenUntilMonth,
};
