const express = require('express');
const lineClient = require('../line');
const bookingService = require('../services/bookingService');

const router = express.Router();

// LINE webhook 進來的每一個 event 都要在幾秒內回應，所以這裡不做太重的事，
// 只負責判斷意圖、回覆對應訊息，實際訂位動作在 LIFF 頁面透過 API 完成。
router.post('/', lineClient.middleware, async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook] 處理事件失敗', err);
    res.sendStatus(200); // 一律回 200，避免 LINE 判定失敗而重送造成重複訊息
  }
});

async function handleEvent(event) {
  if (event.type === 'follow') {
    // 客戶加好友：先建立客戶紀錄（此時還沒有姓名/電話，等他完成第一次預約時再補上）
    await bookingService.findOrCreateCustomerByLine({ lineUserId: event.source.userId });
    return lineClient.replyText(
      event.replyToken,
      '哈囉～歡迎加入妍序 Skin🤍\n輸入「我要預約」就可以開始預約療程囉！'
    );
  }

  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();

  // 輸入「我要預約」直接給預約頁連結，療程跟時段都在 LIFF 頁面裡一次選，
  // 不再多一層「先選療程」的 Quick Reply，省掉一次來回、感覺更快
  // 用明確的完整字句比對（而不是只要含有「預約」兩個字就觸發），
  // 避免像「#預約須知」這種其實只是想看須知、不是要開始預約的訊息被誤判。
  const BOOKING_INTENT_TEXTS = ['我要預約', '我想預約', '想預約', '預約'];
  if (BOOKING_INTENT_TEXTS.includes(text)) {
    return lineClient.replyBookingUrl(event.replyToken);
  }

  const services = await bookingService.listServices();
  // 升級體驗項目不能單獨預約，只能在預約頁裡加選，這裡比對時排除掉
  const matched = services.find((s) => s.name === text && !s.is_addon);
  if (matched) {
    return lineClient.replyBookingLink(event.replyToken, matched.name);
  }

  // 客人打的內容看不懂（不是預約相關、也對不到任何療程名稱）：保持安靜，不回覆任何訊息，
  // 避免每次都跳出同一句罐頭訊息。
}

module.exports = router;
