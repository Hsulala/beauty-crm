const { google } = require('googleapis');

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !key) return null;

  return new google.auth.JWT({
    email,
    // Railway 環境變數存不了真正的換行，設定時會把 \n 打成兩個字元，這裡轉回真正的換行
    key: key.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

function getCalendar() {
  const auth = getAuth();
  if (!auth) return null;
  return google.calendar({ version: 'v3', auth });
}

// 建立日曆事件：預約成立時呼叫，回傳 event id 存進 bookings.google_event_id
async function createBookingEvent({ slotDate, startTime, durationMinutes, customerName, phone, serviceName }) {
  const calendar = getCalendar();
  if (!calendar) {
    console.warn('[googleCalendar] 尚未設定 Service Account，略過日曆同步');
    return null;
  }

  const start = new Date(`${slotDate}T${startTime}`);
  const end = new Date(start.getTime() + durationMinutes * 60000);

  const event = {
    summary: `【預約】${customerName}－${serviceName}`,
    description: `客戶：${customerName}\n電話：${phone || '未提供'}\n療程：${serviceName}\n來源：LINE 官方帳號預約系統`,
    start: { dateTime: start.toISOString(), timeZone: 'Asia/Taipei' },
    end: { dateTime: end.toISOString(), timeZone: 'Asia/Taipei' },
  };

  const res = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    requestBody: event,
  });
  return res.data.id;
}

async function deleteBookingEvent(eventId) {
  const calendar = getCalendar();
  if (!calendar || !eventId) return;
  try {
    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      eventId,
    });
  } catch (err) {
    // 事件可能已經被老闆手動刪掉，這種情況不用讓整個取消預約流程失敗
    console.warn('[googleCalendar] 刪除事件失敗（可能已不存在）', err.message);
  }
}

module.exports = { createBookingEvent, deleteBookingEvent, isConfigured: () => !!getAuth() };
