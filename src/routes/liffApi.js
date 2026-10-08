const express = require('express');
const bookingService = require('../services/bookingService');
const lineClient = require('../line');

const router = express.Router();

// LIFF ID 的格式是「{頻道ID}-{隨機碼}」，例如 2011574565-UCZ4uzcA，
// 驗證 ID Token 用的 client_id 就是這個頻道ID，不需要另外設定一個環境變數，
// 直接從 LIFF_ID 拆出來即可（若有另外設定 LIFF_CHANNEL_ID 則優先採用它）。
function resolveLiffChannelId() {
  if (process.env.LIFF_CHANNEL_ID) return process.env.LIFF_CHANNEL_ID;
  const liffId = process.env.LIFF_ID || '';
  return liffId.split('-')[0] || '';
}

// 驗證從 LIFF 前端送來的 ID Token，確認真的是本人在操作、不是隨便偽造 lineUserId 打 API。
// LIFF SDK 在前端會提供 liff.getIDToken()，這裡呼叫 LINE 的 verify 端點做驗證。
async function verifyLiffIdToken(idToken) {
  const clientId = resolveLiffChannelId();
  const params = new URLSearchParams({ id_token: idToken, client_id: clientId });
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', body: params });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('[liffApi] LIFF ID Token 驗證失敗', res.status, detail);
    // 頁面開太久沒動作，LINE 發的 ID Token 會過期，這種狀況跟其他錯誤分開，
    // 讓前端可以顯示「請重新整理」而不是籠統的「請稍後再試」
    const isExpired = detail.includes('IdToken expired') || detail.includes('expired');
    throw Object.assign(new Error('LIFF ID Token 驗證失敗'), {
      code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }
  return res.json(); // { sub: lineUserId, name, ... }
}

router.get('/liff-config', (req, res) => {
  res.json({ liffId: process.env.LIFF_ID });
});

router.get('/services', async (req, res) => {
  const services = await bookingService.listServices();
  res.json(services);
});

// 預約頁「基本狀態諮詢」問卷題目（目前啟用的題目＋選項）
router.get('/intake-questions', async (req, res) => {
  const questions = await bookingService.getActiveIntakeQuestions();
  res.json(questions);
});

// 客人目前最多能預約到哪一天（預設只到本月底，老闆開放下個月之後才會延伸）
router.get('/booking-window', async (req, res) => {
  const [openUntilMonth, openUntilDate] = await Promise.all([
    bookingService.getBookingOpenUntilMonth(),
    bookingService.getBookingOpenUntilDate(),
  ]);
  res.json({ openUntilMonth, openUntilDate });
});

router.get('/slots', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '缺少 date 參數' });
  const slots = await bookingService.getSlotsForDate(date);
  res.json(slots);
});

// 給預約頁「本週可預約時段」總覽用，一次把 7 天的時段都撈回來，不用一天一天點
router.get('/week', async (req, res) => {
  const { start } = req.query;
  if (!start) return res.status(400).json({ error: '缺少 start 參數' });
  const overview = await bookingService.getPublicWeekOverview(start);
  res.json(overview);
});

router.post('/bookings', async (req, res) => {
  const { idToken, name, phone, serviceId, date, startTime, addonServiceIds, note, intakeAnswers } = req.body;
  if (!idToken || !serviceId || !date || !startTime) {
    return res.status(400).json({ error: '缺少必要欄位' });
  }

  try {
    const profile = await verifyLiffIdToken(idToken);
    const customer = await bookingService.findOrCreateCustomerByLine({
      lineUserId: profile.sub,
      name: name || profile.name,
      phone,
    });

    const booking = await bookingService.createBooking({
      customerId: customer.id,
      serviceId,
      slotDate: date,
      startTime,
      addonServiceIds,
      note,
      intakeAnswers,
    });

    const addonLine = booking.addons && booking.addons.length
      ? `\n升級體驗：${booking.addons.map((a) => a.name).join('、')}`
      : '';
    const noteLine = booking.note ? `\n備註：${booking.note}` : '';

    await lineClient.pushText(
      profile.sub,
      `✅ 已為您預約：\n${date}　${startTime}　${booking.service.name}${addonLine}${noteLine}\n已自動同步至老闆的 Google 日曆囉！到店前一天會再提醒您唷🤍`
    );

    // 附上療程前須知圖片，讓客人到店前有個依據；圖片推播失敗不影響預約本身已經成立
    try {
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      await lineClient.pushImage(
        profile.sub,
        `${baseUrl}/assets/pre-care.jpg`,
        `${baseUrl}/assets/pre-care-preview.jpg`
      );
    } catch (err) {
      console.error('[liffApi] 推播療程前須知圖片失敗', err.message);
    }

    res.json({
      ok: true,
      bookingId: booking.id,
      summary: {
        serviceName: booking.service.name,
        durationMinutes: booking.service.duration_minutes,
        date,
        startTime,
        addons: booking.addons.map((a) => a.name),
      },
    });
  } catch (err) {
    if (err.code === 'SLOT_TAKEN') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'MONTH_NOT_OPEN') {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    if (err.code === 'TOKEN_EXPIRED') {
      return res.status(401).json({ error: '頁面開太久了，請重新整理頁面後再預約一次', code: err.code });
    }
    console.error('[liffApi] 建立預約失敗', err);
    res.status(500).json({ error: '預約失敗，請稍後再試' });
  }
});

// 「查看我的預約」用：給這位客人（用 idToken 驗證身份）自己未來的預約清單，不含其他客人的資料。
router.post('/my-bookings', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: '缺少必要欄位' });

  try {
    const profile = await verifyLiffIdToken(idToken);
    const bookings = await bookingService.getUpcomingBookingsForLineUser(profile.sub);
    res.json({ bookings });
  } catch (err) {
    if (err.code === 'TOKEN_EXPIRED') {
      return res.status(401).json({ error: '頁面開太久了，請重新整理頁面', code: err.code });
    }
    console.error('[liffApi] 讀取我的預約失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

// 預約頁載入時用：這位客人之前留過姓名/電話的話直接帶入表單，不用每次重打。
// 找不到（第一次來、或還沒填過）就回傳空字串，前端一樣顯示空白讓他填。
router.post('/customer-profile', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: '缺少必要欄位' });

  try {
    const profile = await verifyLiffIdToken(idToken);
    const customerProfile = await bookingService.getCustomerProfileByLine(profile.sub);
    res.json(customerProfile || { name: '', phone: '' });
  } catch (err) {
    if (err.code === 'TOKEN_EXPIRED') {
      return res.status(401).json({ error: '頁面開太久了，請重新整理頁面', code: err.code });
    }
    console.error('[liffApi] 讀取客戶資料失敗', err);
    res.status(500).json({ error: '讀取失敗，請稍後再試' });
  }
});

module.exports = router;
