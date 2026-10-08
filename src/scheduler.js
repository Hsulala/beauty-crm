const cron = require('node-cron');
const { pool } = require('./db');
const lineClient = require('./line');

/**
 * 到店前一天自動提醒。
 * 每天固定時間（REMINDER_HOUR，預設 18 點）跑一次，找出「明天」還沒發過提醒的預約，逐一推播。
 * reminder_sent_at 欄位確保同一筆預約不會被重複提醒兩次（就算排程因故多跑一次也一樣）。
 */
async function sendTomorrowReminders() {
  const { rows } = await pool.query(
    `SELECT b.id, b.start_time, c.line_user_id, c.name, s.name AS service_name
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN services s ON s.id = b.service_id
     WHERE b.status = 'confirmed'
       AND b.slot_date = (CURRENT_DATE AT TIME ZONE 'Asia/Taipei' + INTERVAL '1 day')::date
       AND b.reminder_sent_at IS NULL
       AND c.line_user_id IS NOT NULL`
  );

  for (const booking of rows) {
    try {
      await lineClient.pushText(
        booking.line_user_id,
        `提醒您明天 ${booking.start_time.slice(0, 5)} 有預約「${booking.service_name}」唷～記得先卸妝再到店😊 期待與您見面！`
      );
      await pool.query('UPDATE bookings SET reminder_sent_at = now() WHERE id = $1', [booking.id]);
    } catch (err) {
      console.error(`[scheduler] 發送提醒失敗 (booking ${booking.id})`, err.message);
    }
  }

  console.log(`[scheduler] 提醒排程完成，共處理 ${rows.length} 筆`);
}

function start() {
  const hour = parseInt(process.env.REMINDER_HOUR || '18', 10);
  // node-cron 用伺服器時區跑，Railway 預設是 UTC，所以這裡把「台北時間 hour 點」換算成 UTC 表達式
  const utcHour = (hour - 8 + 24) % 24;
  const cronExpr = `0 ${utcHour} * * *`;

  cron.schedule(cronExpr, () => {
    sendTomorrowReminders().catch((err) => console.error('[scheduler] 執行失敗', err));
  });

  console.log(`[scheduler] 已排程：每天台北時間 ${hour}:00 檢查明日預約提醒`);
}

module.exports = { start, sendTomorrowReminders };
