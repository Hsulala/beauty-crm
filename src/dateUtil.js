// 日期相關的小工具，全部用「純日曆日期」運算，刻意不碰時區轉換。
//
// 背景（也是這個檔案存在的原因）：一開始 bookingService 用
// `new Date(dateStr + 'T00:00:00+08:00').getDay()` 來算星期幾，
// 但 JS 的 .getDay() 是照「執行環境的本地時區」回傳結果，不是照你在字串裡寫的 +08:00。
// Railway 的伺服器時區預設是 UTC，所以這樣算出來的星期幾會整整錯一天
// （半夜的時段全部被歸到前一天），導致「可預約時段」永遠是空的。
// 這裡改成只用日期的年/月/日數字做運算，完全不經過任何時區轉換，才不會出這個問題。

function parseYmd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}

function toYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 回傳 0(週日)~6(週六)，純用日期數字計算，與任何時區無關 */
function weekdayOf(dateStr) {
  const { y, m, d } = parseYmd(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** dateStr 加上 days 天，回傳新的 YYYY-MM-DD 字串 */
function addDays(dateStr, days) {
  const { y, m, d } = parseYmd(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** 該年月共有幾天（month 是 1~12），純數字運算，不受時區影響 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

module.exports = { weekdayOf, addDays, daysInMonth };
