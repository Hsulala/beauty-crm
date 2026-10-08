const express = require('express');
const { pool } = require('../db');
const bookingService = require('../services/bookingService');
const { hashPassword, verifyPassword } = require('../authUtil');
const lineClient = require('../line');
const storeConfig = require('../storeConfig');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: '請先登入' });
}

// 主控管理者專用：品項價格、時段範本、帳號管理都算「結構性」設定，操作人員（staff）帳號不能碰。
function requireOwner(req, res, next) {
  if (req.session && req.session.isAdmin && req.session.role === 'owner') return next();
  return res.status(403).json({ error: '這個功能只有管理者才能操作' });
}

// 功能模組守門：模組關閉時，這個功能的 API 回 403（資料保留，重新開啟後仍在）。
function requireModule(key) {
  return async (req, res, next) => {
    try {
      if (await storeConfig.isModuleEnabled(pool, key)) return next();
      return res.status(403).json({ error: '此功能尚未開通', code: 'module_disabled', module: key });
    } catch (err) {
      console.error('[adminApi] 讀取模組設定失敗', err);
      return res.status(500).json({ error: '讀取失敗，請稍後再試' });
    }
  };
}

// 帳號＋密碼登入：帳號存在 admin_users 表，密碼用 scrypt 雜湊比對，不是明碼比較。
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }
    req.session.isAdmin = true;
    req.session.adminUserId = user.id;
    req.session.adminUsername = user.username;
    req.session.role = user.role;
    res.json({ ok: true, username: user.username, role: user.role });
  } catch (err) {
    console.error('[adminApi] 登入失敗', err);
    res.status(500).json({ error: '登入失敗，請稍後再試' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  const isAdmin = !!(req.session && req.session.isAdmin);
  res.json({
    isAdmin,
    username: isAdmin ? req.session.adminUsername : null,
    role: isAdmin ? req.session.role : null,
  });
});

// 老闆自己在後台改帳號／密碼：一定要先驗證「目前密碼」才能改，避免忘了登出被別人亂改。
// newUsername、newPassword 都是選填，至少要填一個才有意義，但這裡不強制，讓前端自己決定要顯示什麼錯誤。
router.post('/account', requireAdmin, async (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ error: '請輸入目前的密碼以確認身份' });
  }
  if (!newUsername && !newPassword) {
    return res.status(400).json({ error: '請至少填寫新帳號或新密碼其中一項' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [req.session.adminUserId]);
    const user = rows[0];
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: '目前密碼不正確' });
    }

    const nextUsername = newUsername ? newUsername.trim() : user.username;
    if (newUsername && nextUsername !== user.username) {
      const dup = await pool.query('SELECT 1 FROM admin_users WHERE username = $1 AND id <> $2', [nextUsername, user.id]);
      if (dup.rows[0]) {
        return res.status(400).json({ error: '這個帳號名稱已經有人使用了，換一個試試' });
      }
    }
    const nextPasswordHash = newPassword ? hashPassword(newPassword) : user.password_hash;

    await pool.query('UPDATE admin_users SET username = $1, password_hash = $2 WHERE id = $3', [
      nextUsername,
      nextPasswordHash,
      user.id,
    ]);
    req.session.adminUsername = nextUsername;
    res.json({ ok: true, username: nextUsername });
  } catch (err) {
    console.error('[adminApi] 更新帳號失敗', err);
    res.status(500).json({ error: '更新失敗，請稍後再試' });
  }
});

router.get('/week', requireAdmin, async (req, res) => {
  const { start } = req.query; // YYYY-MM-DD，該週的星期一
  if (!start) return res.status(400).json({ error: '缺少 start 參數' });
  const overview = await bookingService.getWeekOverview(start);
  res.json(overview);
});

router.post('/bookings/:id/cancel', requireAdmin, async (req, res) => {
  try {
    await bookingService.cancelBooking(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'ALREADY_COMPLETED' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// 標記某筆預約「已完成」：只限主控管理者（老闆）能按，操作人員看得到但沒有這顆按鈕。
// 只有完成的預約才算進營收，完成後也會推播「療程後須知」圖片給客人
// （客人是用 LINE 進來預約的才會推得到，沒有 line_user_id 就跳過）。
router.post('/bookings/:id/complete', requireOwner, async (req, res) => {
  try {
    const booking = await bookingService.completeBooking(req.params.id);
    if (booking.line_user_id) {
      try {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        await lineClient.pushImage(
          booking.line_user_id,
          `${baseUrl}/assets/post-care.jpg`,
          `${baseUrl}/assets/post-care-preview.jpg`
        );
      } catch (err) {
        console.error('[adminApi] 推播療程後須知圖片失敗', err.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'ALREADY_CANCELLED' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// 老闆手動開關某個時段：action 是 'close'（關閉）、'open'（臨時加開）或 'reset'（恢復跟著星期規則走）
router.post('/slots/toggle', requireAdmin, async (req, res) => {
  const { date, startTime, action } = req.body;
  if (!date || !startTime || !['close', 'open', 'reset'].includes(action)) {
    return res.status(400).json({ error: '缺少必要欄位' });
  }
  try {
    await bookingService.setSlotOverride(date, startTime, action);
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 開關時段失敗', err);
    res.status(500).json({ error: '操作失敗，請稍後再試' });
  }
});

// 月曆總覽：某個月每一天的公休狀態／預約數／營收，以及整月統計摘要
router.get('/month', requireAdmin, async (req, res) => {
  const { month } = req.query; // YYYY-MM
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: '缺少或格式錯誤的 month 參數（需為 YYYY-MM）' });
  }
  try {
    const overview = await bookingService.getMonthOverview(month);
    if (!(await storeConfig.isModuleEnabled(pool, 'revenue')) && overview.stats) overview.stats.totalRevenue = null;
    res.json(overview);
  } catch (err) {
    console.error('[adminApi] 取得月曆總覽失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 單日詳情：公休狀態、完整時段(含關閉/預約明細)、當天營收 — 給月曆點某一天時用
router.get('/day', requireAdmin, async (req, res) => {
  const { date } = req.query; // YYYY-MM-DD
  if (!date) return res.status(400).json({ error: '缺少 date 參數' });
  try {
    const detail = await bookingService.getDayDetail(date);
    if (!(await storeConfig.isModuleEnabled(pool, 'revenue'))) delete detail.revenue;
    res.json(detail);
  } catch (err) {
    console.error('[adminApi] 取得單日詳情失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 固定公休日：取得目前設定為每週固定公休的星期幾清單
router.get('/holidays/weekly', requireAdmin, async (req, res) => {
  try {
    const weekdays = await bookingService.getWeeklyHolidays();
    res.json({ weekdays });
  } catch (err) {
    console.error('[adminApi] 讀取固定公休日失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 固定公休日：開關某個星期幾是否為每週固定公休
router.post('/holidays/weekly', requireAdmin, async (req, res) => {
  const { weekday, isClosed } = req.body;
  if (typeof weekday !== 'number' || weekday < 0 || weekday > 6 || typeof isClosed !== 'boolean') {
    return res.status(400).json({ error: '缺少必要欄位' });
  }
  try {
    await bookingService.setWeeklyHoliday(weekday, isClosed);
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 設定固定公休日失敗', err);
    res.status(500).json({ error: '操作失敗，請稍後再試' });
  }
});

// 臨時公休／臨時開放：針對單一日期整天覆蓋開放狀態。
// action 是 'close'（這天整天公休）、'open'（這天整天臨時開放）或 'reset'（恢復跟著固定公休日走）
router.post('/holidays/date', requireAdmin, async (req, res) => {
  const { date, action } = req.body;
  if (!date || !['close', 'open', 'reset'].includes(action)) {
    return res.status(400).json({ error: '缺少必要欄位' });
  }
  try {
    await bookingService.setDateClosure(date, action);
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 設定臨時公休失敗', err);
    res.status(500).json({ error: '操作失敗，請稍後再試' });
  }
});

// 時段範本設定：取得每個星期幾預設開放的時段（不是某一天的臨時開關，是長期套用的範本）
// 這會影響整個營業時間的結構，跟品項價格一樣只給主控管理者調整。
router.get('/availability', requireOwner, async (req, res) => {
  try {
    const rules = await bookingService.getAvailabilityRules();
    res.json({ rules });
  } catch (err) {
    console.error('[adminApi] 讀取時段範本失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 時段範本設定：設定某個星期幾預設開放的時段（整組取代）
router.post('/availability', requireOwner, async (req, res) => {
  const { weekday, times } = req.body;
  if (typeof weekday !== 'number' || weekday < 0 || weekday > 6 || !Array.isArray(times)) {
    return res.status(400).json({ error: '缺少必要欄位' });
  }
  const validTimes = times.every((t) => /^\d{2}:\d{2}(:\d{2})?$/.test(t));
  if (!validTimes) {
    return res.status(400).json({ error: '時段格式錯誤' });
  }
  try {
    await bookingService.setAvailabilityForWeekday(weekday, times);
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 設定時段範本失敗', err);
    res.status(500).json({ error: '操作失敗，請稍後再試' });
  }
});

// ---------- 品項管理（療程／升級體驗項目的新增、調整價格、啟用停用）：只有主控管理者能用 ----------
router.get('/services', requireOwner, async (req, res) => {
  try {
    const services = await bookingService.listAllServicesForAdmin();
    res.json({ services });
  } catch (err) {
    console.error('[adminApi] 讀取品項失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.post('/services', requireOwner, async (req, res) => {
  const { name, category, price, durationMinutes, isAddon, sortOrder, note } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '請輸入項目名稱' });
  }
  try {
    const service = await bookingService.createService({
      name: String(name).trim(),
      category,
      price,
      durationMinutes,
      isAddon,
      sortOrder,
      note,
    });
    res.json({ ok: true, service });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '已經有同名的項目了，換一個名稱試試' });
    console.error('[adminApi] 新增品項失敗', err);
    res.status(500).json({ error: '新增失敗，請稍後再試' });
  }
});

router.put('/services/:id', requireOwner, async (req, res) => {
  const { name, category, price, durationMinutes, isAddon, sortOrder, note } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '請輸入項目名稱' });
  }
  try {
    const service = await bookingService.updateService(req.params.id, {
      name: String(name).trim(),
      category,
      price,
      durationMinutes,
      isAddon,
      sortOrder,
      note,
    });
    res.json({ ok: true, service });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '已經有同名的項目了，換一個名稱試試' });
    console.error('[adminApi] 更新品項失敗', err);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message || '更新失敗，請稍後再試' });
  }
});

router.post('/services/:id/toggle', requireOwner, async (req, res) => {
  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') return res.status(400).json({ error: '缺少必要欄位' });
  try {
    const service = await bookingService.setServiceActive(req.params.id, isActive);
    res.json({ ok: true, service });
  } catch (err) {
    console.error('[adminApi] 切換品項啟用狀態失敗', err);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message || '操作失敗，請稍後再試' });
  }
});

// ---------- 子帳號管理：開一組權限較低的操作人員帳號給店員，只有主控管理者能用 ----------
router.get('/accounts', requireOwner, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role, created_at FROM admin_users ORDER BY created_at'
    );
    res.json({ accounts: rows });
  } catch (err) {
    console.error('[adminApi] 讀取帳號清單失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.post('/accounts', requireOwner, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !String(username).trim() || !password) {
    return res.status(400).json({ error: '請輸入帳號與密碼' });
  }
  const nextRole = role === 'owner' ? 'owner' : 'staff';
  try {
    const { rows } = await pool.query(
      'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
      [String(username).trim(), hashPassword(password), nextRole]
    );
    res.json({ ok: true, account: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: '這個帳號名稱已經有人使用了，換一個試試' });
    console.error('[adminApi] 新增帳號失敗', err);
    res.status(500).json({ error: '新增失敗，請稍後再試' });
  }
});

// 刪除子帳號：擋兩種危險情況——刪掉自己目前登入的帳號、或刪掉最後一個主控管理者帳號（會讓系統沒人能管理）
router.delete('/accounts/:id', requireOwner, async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.session.adminUserId) {
    return res.status(400).json({ error: '不能刪除自己目前登入中的帳號' });
  }
  try {
    const { rows } = await pool.query('SELECT role FROM admin_users WHERE id = $1', [targetId]);
    if (!rows[0]) return res.status(404).json({ error: '找不到這個帳號' });
    if (rows[0].role === 'owner') {
      const ownerCount = await pool.query(`SELECT COUNT(*)::int AS c FROM admin_users WHERE role = 'owner'`);
      if (ownerCount.rows[0].c <= 1) {
        return res.status(400).json({ error: '至少要保留一個主控管理者帳號，不能刪除' });
      }
    }
    await pool.query('DELETE FROM admin_users WHERE id = $1', [targetId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 刪除帳號失敗', err);
    res.status(500).json({ error: '刪除失敗，請稍後再試' });
  }
});

// ---------- 皮膚紀錄欄位設定：基本狀態諮詢題目／選項（只有主控管理者能改題目結構） ----------
router.get('/intake-questions', requireOwner, async (req, res) => {
  try {
    const questions = await bookingService.listIntakeQuestionsForAdmin();
    res.json({ questions });
  } catch (err) {
    console.error('[adminApi] 讀取問卷題目失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.post('/intake-questions', requireOwner, async (req, res) => {
  const { label, inputType, allowOther, sortOrder } = req.body;
  if (!label) return res.status(400).json({ error: '請輸入題目名稱' });
  try {
    const question = await bookingService.createIntakeQuestion({ label, inputType, allowOther, sortOrder });
    res.json({ question });
  } catch (err) {
    console.error('[adminApi] 新增問卷題目失敗', err);
    res.status(500).json({ error: '新增失敗，請稍後再試' });
  }
});

router.put('/intake-questions/:id', requireOwner, async (req, res) => {
  const { label, inputType, allowOther, sortOrder, isActive } = req.body;
  if (!label) return res.status(400).json({ error: '請輸入題目名稱' });
  try {
    const question = await bookingService.updateIntakeQuestion(Number(req.params.id), {
      label, inputType, allowOther, sortOrder, isActive,
    });
    res.json({ question });
  } catch (err) {
    console.error('[adminApi] 更新問卷題目失敗', err);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message || '更新失敗，請稍後再試' });
  }
});

router.delete('/intake-questions/:id', requireOwner, async (req, res) => {
  try {
    await bookingService.deleteIntakeQuestion(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 刪除問卷題目失敗', err);
    res.status(500).json({ error: '刪除失敗，請稍後再試' });
  }
});

router.post('/intake-questions/:id/options', requireOwner, async (req, res) => {
  const { label, sortOrder } = req.body;
  if (!label) return res.status(400).json({ error: '請輸入選項名稱' });
  try {
    const option = await bookingService.addIntakeOption(Number(req.params.id), label, sortOrder);
    res.json({ option });
  } catch (err) {
    console.error('[adminApi] 新增選項失敗', err);
    res.status(500).json({ error: '新增失敗，請稍後再試' });
  }
});

router.delete('/intake-options/:id', requireOwner, async (req, res) => {
  try {
    await bookingService.deleteIntakeOption(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 刪除選項失敗', err);
    res.status(500).json({ error: '刪除失敗，請稍後再試' });
  }
});

// ---------- 皮膚紀錄欄位設定：皮膚狀態紀錄代碼（A正常、B油性…，只有主控管理者能改） ----------
router.get('/skin-note-codes', requireOwner, async (req, res) => {
  try {
    const codes = await bookingService.listSkinNoteCodes(false);
    res.json({ codes });
  } catch (err) {
    console.error('[adminApi] 讀取代碼失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.post('/skin-note-codes', requireOwner, async (req, res) => {
  const { code, label, sortOrder } = req.body;
  if (!code || !label) return res.status(400).json({ error: '請輸入代碼與名稱' });
  try {
    const created = await bookingService.createSkinNoteCode({ code, label, sortOrder });
    res.json({ code: created });
  } catch (err) {
    console.error('[adminApi] 新增代碼失敗', err);
    res.status(err.code === '23505' ? 409 : 500).json({ error: err.code === '23505' ? '這個代碼已經存在' : '新增失敗，請稍後再試' });
  }
});

router.put('/skin-note-codes/:id', requireOwner, async (req, res) => {
  const { code, label, sortOrder, isActive } = req.body;
  if (!code || !label) return res.status(400).json({ error: '請輸入代碼與名稱' });
  try {
    const updated = await bookingService.updateSkinNoteCode(Number(req.params.id), { code, label, sortOrder, isActive });
    res.json({ code: updated });
  } catch (err) {
    console.error('[adminApi] 更新代碼失敗', err);
    res.status(err.code === 'NOT_FOUND' ? 404 : 500).json({ error: err.message || '更新失敗，請稍後再試' });
  }
});

router.delete('/skin-note-codes/:id', requireOwner, async (req, res) => {
  try {
    await bookingService.deleteSkinNoteCode(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[adminApi] 刪除代碼失敗', err);
    res.status(500).json({ error: '刪除失敗，請稍後再試' });
  }
});

// ---------- 單筆預約的皮膚紀錄：客人填的問卷（唯讀）＋ 老闆填的詳細紀錄（可編輯）----------
// 一般操作人員（staff）也能看、能填寫看診紀錄，只有題目/代碼結構本身才限定主控管理者才能改。
router.get('/bookings/:id/skin-record', requireAdmin, requireModule('skinRecord'), async (req, res) => {
  const bookingId = Number(req.params.id);
  try {
    const [intakeAnswers, skinNotes, codes] = await Promise.all([
      bookingService.getBookingIntakeAnswers(bookingId),
      bookingService.getBookingSkinNotes(bookingId),
      bookingService.listSkinNoteCodes(true),
    ]);
    res.json({ intakeAnswers, skinNotes, codes });
  } catch (err) {
    console.error('[adminApi] 讀取皮膚紀錄失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.put('/bookings/:id/skin-record', requireAdmin, requireModule('skinRecord'), async (req, res) => {
  const bookingId = Number(req.params.id);
  const { codeValues, treatmentSuggestion, careProcedure, productSuggestion } = req.body;
  try {
    const skinNotes = await bookingService.upsertBookingSkinNotes(bookingId, {
      codeValues, treatmentSuggestion, careProcedure, productSuggestion,
    });
    res.json({ ok: true, skinNotes });
  } catch (err) {
    console.error('[adminApi] 儲存皮膚紀錄失敗', err);
    res.status(500).json({ error: '儲存失敗，請稍後再試' });
  }
});

// 預約開放範圍：客人預設只能預約到本月底，owner 可以開放到下個月（或更後面）
router.get('/booking-window', requireAdmin, async (req, res) => {
  try {
    const [openUntilMonth, openUntilDate] = await Promise.all([
      bookingService.getBookingOpenUntilMonth(),
      bookingService.getBookingOpenUntilDate(),
    ]);
    res.json({ openUntilMonth, openUntilDate });
  } catch (err) {
    console.error('[adminApi] 讀取預約開放範圍失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.put('/booking-window', requireOwner, async (req, res) => {
  const { month } = req.body; // 'YYYY-MM'
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: '月份格式不正確' });
  }
  try {
    const openUntilMonth = await bookingService.setBookingOpenUntilMonth(month);
    res.json({ openUntilMonth });
  } catch (err) {
    console.error('[adminApi] 更新預約開放範圍失敗', err);
    res.status(500).json({ error: '更新失敗，請稍後再試' });
  }
});

// ---------- 客戶管理：名單＋統計、單一客戶完整歷史（owner/staff 都能看，日常查詢用）----------
router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const customers = await bookingService.listCustomersWithStats(req.query.search);
    if (!(await storeConfig.isModuleEnabled(pool, 'revenue'))) for (const c of customers) c.total_revenue = null;
    res.json({ customers });
  } catch (err) {
    console.error('[adminApi] 讀取客戶清單失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

router.get('/customers/:id', requireAdmin, async (req, res) => {
  try {
    const detail = await bookingService.getCustomerDetail(Number(req.params.id));
    if (!detail) return res.status(404).json({ error: '找不到這位客戶' });
    res.json(detail);
  } catch (err) {
    console.error('[adminApi] 讀取客戶詳情失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 營收明細（方便對帳）：某個月份所有「已完成」預約的逐筆清單
router.get('/revenue-detail', requireAdmin, requireModule('revenue'), async (req, res) => {
  const { month } = req.query; // 'YYYY-MM'
  if (!month) return res.status(400).json({ error: '缺少 month 參數' });
  try {
    const items = await bookingService.getMonthRevenueDetail(month);
    res.json({ items });
  } catch (err) {
    console.error('[adminApi] 讀取營收明細失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// ---------- 店家設定（功能模組、店名、主題色）----------
// 讀：所有登入的後台帳號都能讀（前端要依模組顯示或淡灰）。寫：只有 owner。
router.get('/config', requireAdmin, async (req, res) => {
  try {
    const config = await storeConfig.getConfig(pool);
    const modules = Object.fromEntries(storeConfig.MODULE_KEYS.map((key) => [key, {
      label: storeConfig.MODULES[key].label,
      description: storeConfig.MODULES[key].description,
      enabled: config.modules[key],
    }]));
    res.json({ modules, brand: config.brand, canEdit: req.session.role === 'owner' });
  } catch (err) {
    console.error('[adminApi] 讀取店家設定失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 只改有帶的欄位：{ modules: { revenue: false }, brand: { name, themeColor } } 都是選填。
router.put('/config', requireOwner, async (req, res) => {
  try {
    const result = await storeConfig.updateConfig(pool, req.body, req.session.adminUsername || '');
    if (result.errors) return res.status(400).json({ error: '設定有誤', fields: result.errors });
    res.json({ ok: true, changed: result.changed, modules: result.config.modules, brand: result.config.brand });
  } catch (err) {
    console.error('[adminApi] 儲存店家設定失敗', err);
    res.status(500).json({ error: '儲存失敗，請稍後再試' });
  }
});

router.get('/config/audit', requireOwner, async (req, res) => {
  try {
    res.json({ entries: await storeConfig.recentAudit(pool, 30) });
  } catch (err) {
    console.error('[adminApi] 讀取設定紀錄失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

module.exports = router;
