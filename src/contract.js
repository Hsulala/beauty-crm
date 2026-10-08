// 合約到期判斷。日期一律以台北時間的「日」計算，避免跨日差一天。
export const EXPIRY_WARN_DAYS = 30;

export const taipeiToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);

const dayNumber = (dateText) => Math.round(Date.parse(`${dateText}T00:00:00Z`) / 86_400_000);

// state：none 未設定到期日、ok 正常、soon 即將到期、expired 已過期、ended 店家已結束
export function contractInfo({ contract_start: start, contract_end: end, status }, today) {
  if (!end) return { state: 'none', daysLeft: null, progress: null };
  const daysLeft = dayNumber(end) - dayNumber(today);
  let progress = null;
  if (start) {
    const total = dayNumber(end) - dayNumber(start);
    progress = total > 0 ? Math.min(1, Math.max(0, (dayNumber(today) - dayNumber(start)) / total)) : 1;
    progress = Math.round(progress * 1000) / 1000;
  }
  if (status === 'ended') return { state: 'ended', daysLeft, progress };
  const state = daysLeft < 0 ? 'expired' : daysLeft <= EXPIRY_WARN_DAYS ? 'soon' : 'ok';
  return { state, daysLeft, progress };
}
