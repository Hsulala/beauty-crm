const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

const withApp = (fn) => async () => { const app = await startApp(); try { await fn(app); } finally { await app.stop(); } };

test('一時段一客人：同時搶同一時段只會成功一筆（資料庫唯一索引把關）', withApp(async (app) => {
  const { booking } = app.services;
  const service = (await app.pool.query('SELECT id FROM services WHERE is_active = true AND COALESCE(is_addon, false) = false ORDER BY id LIMIT 1')).rows[0];
  const customers = [];
  for (const n of [1, 2, 3]) customers.push((await app.pool.query(`INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`, [`客${n}`, `091200000${n}`])).rows[0].id);

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const results = await Promise.allSettled(customers.map((customerId) =>
    booking.createBooking({ customerId, serviceId: service.id, slotDate: today, startTime: '14:00' })));

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await app.pool.query(`SELECT count(*)::int AS n FROM bookings WHERE slot_date = $1 AND start_time = '14:00' AND status <> 'cancelled'`, [today])).rows[0].n, 1);
}));

test('資料庫約束：已取消的預約不佔時段，其他狀態會佔', withApp(async (app) => {
  const service = (await app.pool.query('SELECT id FROM services ORDER BY id LIMIT 1')).rows[0];
  const c = (await app.pool.query(`INSERT INTO customers (name) VALUES ('客') RETURNING id`)).rows[0];
  const insert = (status) => app.pool.query(
    `INSERT INTO bookings (customer_id, service_id, slot_date, start_time, status) VALUES ($1, $2, '2030-01-01', '09:00', $3)`,
    [c.id, service.id, status]);
  await insert('cancelled');
  await insert('confirmed');
  await assert.rejects(() => insert('completed'), (e) => e.code === '23505');
  await insert('cancelled');
}));
