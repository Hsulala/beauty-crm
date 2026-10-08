const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

const withApp = (fn) => async () => { const app = await startApp(); try { await fn(app); } finally { await app.stop(); } };
const setModules = (app, modules) => app.owner('/api/admin/config', { method: 'PUT', body: { modules } });

// 在本月放一筆已完成的預約，營收 = 療程價格
async function seedCompletedBooking(app) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const service = (await app.pool.query('SELECT id, price FROM services WHERE price IS NOT NULL AND price > 0 ORDER BY id LIMIT 1')).rows[0];
  const customer = (await app.pool.query(`INSERT INTO customers (name, phone) VALUES ('測試客', '0912000111') RETURNING id`)).rows[0];
  const booking = (await app.pool.query(
    `INSERT INTO bookings (customer_id, service_id, slot_date, start_time, status, completed_at)
     VALUES ($1, $2, $3, '10:00', 'completed', now()) RETURNING id`,
    [customer.id, service.id, today],
  )).rows[0];
  return { today, month: today.slice(0, 7), price: Number(service.price), bookingId: booking.id };
}

test('營收模組開啟（預設）：月營收、單日營收、明細、客戶累積消費都有', withApp(async (app) => {
  const seed = await seedCompletedBooking(app);
  assert.equal((await app.owner(`/api/admin/month?month=${seed.month}`)).json.stats.totalRevenue, seed.price);
  assert.equal((await app.owner(`/api/admin/day?date=${seed.today}`)).json.revenue, seed.price);
  assert.equal((await app.owner(`/api/admin/revenue-detail?month=${seed.month}`)).json.items.length, 1);
  assert.equal(Number((await app.owner('/api/admin/customers')).json.customers[0].total_revenue), seed.price);
}));

test('營收模組關閉：數字不再回傳、明細 403，但資料還在，重新開啟即恢復', withApp(async (app) => {
  const seed = await seedCompletedBooking(app);
  await setModules(app, { revenue: false });

  assert.equal((await app.owner(`/api/admin/month?month=${seed.month}`)).json.stats.totalRevenue, null);
  assert.equal('revenue' in (await app.owner(`/api/admin/day?date=${seed.today}`)).json, false);
  const detail = await app.owner(`/api/admin/revenue-detail?month=${seed.month}`);
  assert.equal(detail.status, 403);
  assert.equal(detail.json.code, 'module_disabled');
  assert.equal((await app.staff(`/api/admin/revenue-detail?month=${seed.month}`)).status, 403);
  assert.equal((await app.owner('/api/admin/customers')).json.customers[0].total_revenue, null);

  // 預約本身與其他功能不受影響
  assert.equal((await app.owner(`/api/admin/month?month=${seed.month}`)).json.stats.totalBookings, 1);
  assert.equal((await app.pool.query(`SELECT count(*)::int AS n FROM bookings WHERE status = 'completed'`)).rows[0].n, 1);

  await setModules(app, { revenue: true });
  assert.equal((await app.owner(`/api/admin/month?month=${seed.month}`)).json.stats.totalRevenue, seed.price);
  assert.equal((await app.owner(`/api/admin/revenue-detail?month=${seed.month}`)).status, 200);
}));

test('皮膚紀錄模組：關閉時讀寫都 403，資料保留，重新開啟後仍在', withApp(async (app) => {
  const seed = await seedCompletedBooking(app);
  const url = `/api/admin/bookings/${seed.bookingId}/skin-record`;
  const saved = await app.owner(url, { method: 'PUT', body: { codeValues: {}, treatmentSuggestion: '保濕', careProcedure: '', productSuggestion: '' } });
  assert.equal(saved.status, 200);

  await setModules(app, { skinRecord: false });
  assert.equal((await app.owner(url)).status, 403);
  assert.equal((await app.staff(url, { method: 'PUT', body: { treatmentSuggestion: '亂改' } })).status, 403);

  await setModules(app, { skinRecord: true });
  const again = await app.owner(url);
  assert.equal(again.status, 200);
  assert.equal(again.json.skinNotes.treatment_suggestion, '保濕');
}));

test('模組之間互不影響：關營收時皮膚紀錄照常', withApp(async (app) => {
  const seed = await seedCompletedBooking(app);
  await setModules(app, { revenue: false });
  assert.equal((await app.owner(`/api/admin/bookings/${seed.bookingId}/skin-record`)).status, 200);
}));
