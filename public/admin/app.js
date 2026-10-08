// 妍序 Skin 管理後台前端邏輯

let weekStart = mondayOf(new Date());
let currentMonth = null; // 'YYYY-MM'
let selectedMonthDate = null; // 'YYYY-MM-DD'，目前在月曆上選中的日期
let lastMonthOverview = null;
let weeklyHolidaySet = new Set();
let currentRole = null; // 'owner' | 'staff'
let customerListLoadedOnce = false;
let customerSearchDebounceTimer = null;

const DOW_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const DOW_JS = [1, 2, 3, 4, 5, 6, 0]; // 對應 DOW_LABELS 的 JS weekday（0=週日）

function mondayOf(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day; // 週日算上週的延伸，統一以週一為起點
  date.setDate(date.getDate() + diff);
  return date.toISOString().slice(0, 10);
}

// ---------- 純日期字串工具，跟後端 dateUtil.js 用同一套邏輯，不用 Date() 做時區轉換 ----------
function parseYmd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}
function toYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function weekdayOf(dateStr) {
  const { y, m, d } = parseYmd(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function addDaysStr(dateStr, days) {
  const { y, m, d } = parseYmd(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function todayYmd() {
  const now = new Date();
  return toYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
function daysInMonthOf(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function addMonths(monthStr, delta) {
  let [y, m] = monthStr.split('-').map(Number);
  m += delta;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function formatPrice(price) {
  if (price === null || price === undefined) return '';
  return `$${Number(price).toLocaleString('zh-Hant-TW')}`;
}

async function checkSession() {
  const res = await fetch('/api/admin/session');
  const data = await res.json();
  if (data.isAdmin) showMain(data.username, data.role);
}

function showMain(username, role) {
  currentRole = role || 'staff';
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('mainBox').style.display = 'block';
  const roleLabel = currentRole === 'owner' ? '管理者' : '操作人員';
  document.getElementById('whoami').innerHTML = username
    ? `帳號：${username}<span class="role-tag ${currentRole}">${roleLabel}</span>`
    : '';
  document.querySelectorAll('.owner-only').forEach((el) => {
    el.hidden = currentRole !== 'owner';
  });
  document.getElementById('sideWho').innerHTML = document.getElementById('whoami').innerHTML;
  document.body.classList.add('has-sidebar');
  refreshSidebarGroups();
  loadStoreConfig();
  currentMonth = todayYmd().slice(0, 7);
  document.getElementById('mobileNav').hidden = false; // 登入後才顯示手機版底部導覽列
  switchTab('month'); // 設定預設分頁，順便讓底部導覽列的選取狀態正確
  loadWeeklyHolidays();
  loadMonth();
  loadWeek();
}

document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('userInput').value.trim();
  const password = document.getElementById('pwInput').value;
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (res.ok) {
    showMain(data.username, data.role);
  } else {
    document.getElementById('loginErr').textContent = data.error || '登入失敗，請再試一次';
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  location.reload();
});

// ---------- 帳號設定（改帳號／密碼） ----------
document.getElementById('acctSettingsBtn').addEventListener('click', () => {
  document.getElementById('acctCurrentPw').value = '';
  document.getElementById('acctNewUser').value = '';
  document.getElementById('acctNewPw').value = '';
  document.getElementById('acctMsg').textContent = '';
  document.getElementById('acctMsg').className = 'modal-msg';
  document.getElementById('acctScrim').classList.add('open');
});
document.getElementById('acctCancelBtn').addEventListener('click', () => {
  document.getElementById('acctScrim').classList.remove('open');
});
document.getElementById('acctScrim').addEventListener('click', (e) => {
  if (e.target.id === 'acctScrim') document.getElementById('acctScrim').classList.remove('open');
});
document.getElementById('acctSaveBtn').addEventListener('click', async () => {
  const currentPassword = document.getElementById('acctCurrentPw').value;
  const newUsername = document.getElementById('acctNewUser').value.trim();
  const newPassword = document.getElementById('acctNewPw').value;
  const msg = document.getElementById('acctMsg');

  const res = await fetch('/api/admin/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newUsername: newUsername || undefined, newPassword: newPassword || undefined }),
  });
  const data = await res.json();
  if (res.ok) {
    msg.textContent = '已更新，下次登入請使用新的帳號密碼';
    msg.className = 'modal-msg success';
    document.getElementById('whoami').textContent = `帳號：${data.username}`;
    setTimeout(() => document.getElementById('acctScrim').classList.remove('open'), 1200);
  } else {
    msg.textContent = data.error || '更新失敗，請稍後再試';
    msg.className = 'modal-msg error';
  }
});

// ---------- 分頁切換 ----------
document.getElementById('tabMonthBtn').addEventListener('click', () => switchTab('month'));
document.getElementById('tabWeekBtn').addEventListener('click', () => switchTab('week'));
document.getElementById('tabCustomerBtn').addEventListener('click', () => switchTab('customer'));

function switchTab(tab) {
  document.getElementById('tabMonthBtn').classList.toggle('active', tab === 'month');
  document.getElementById('tabWeekBtn').classList.toggle('active', tab === 'week');
  document.getElementById('tabCustomerBtn').classList.toggle('active', tab === 'customer');
  document.querySelectorAll('#sideNav [data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('monthTab').hidden = tab !== 'month';
  document.getElementById('weekTab').hidden = tab !== 'week';
  document.getElementById('customerTab').hidden = tab !== 'customer';
  document.querySelector('.stat-row').style.display = tab === 'customer' ? 'none' : '';
  // 手機版底部導覽列的選取狀態要跟著一起換
  document.querySelectorAll('#mobileNav button[data-mobile-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mobileTab === tab);
  });
  if (tab === 'customer' && !customerListLoadedOnce) {
    customerListLoadedOnce = true;
    loadCustomers();
  }
}

// ---------- 手機版底部導覽列 ----------
document.querySelectorAll('#mobileNav button[data-mobile-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.mobileTab));
});

// 「更多」面板：裡面的每顆按鈕都直接觸發頂端原本那顆按鈕，
// 不重寫任何邏輯，桌機版行為完全不受影響
document.getElementById('mobileMoreBtn').addEventListener('click', () => {
  document.getElementById('moreScrim').classList.add('open');
});
document.getElementById('moreCloseBtn').addEventListener('click', () => {
  document.getElementById('moreScrim').classList.remove('open');
});
document.getElementById('moreScrim').addEventListener('click', (e) => {
  if (e.target.id === 'moreScrim') document.getElementById('moreScrim').classList.remove('open');
});
document.querySelectorAll('#moreScrim button[data-proxy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('moreScrim').classList.remove('open');
    document.getElementById(btn.dataset.proxy).click();
  });
});

// ---------- 本週時段表 ----------
document.getElementById('prevWeek').addEventListener('click', () => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() - 7);
  weekStart = mondayOf(d);
  loadWeek();
});
document.getElementById('nextWeek').addEventListener('click', () => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 7);
  weekStart = mondayOf(d);
  loadWeek();
});

async function loadWeek() {
  document.getElementById('weekLabel').textContent = weekStart;
  const res = await fetch(`/api/admin/week?start=${weekStart}`, { cache: 'no-store' });
  const overview = await res.json();
  renderCalendar(overview);
}

function renderCalendar(overview) {
  const dates = Object.keys(overview);
  const times = [...new Set(dates.flatMap((d) => overview[d].slots.map((s) => s.startTime)))].sort();

  const cal = document.getElementById('cal');
  cal.innerHTML = '';
  cal.appendChild(div('cal-corner', ''));
  dates.forEach((date) => {
    const offTag = overview[date].isClosed ? ' 🌙公休' : '';
    cal.appendChild(div('cal-day', `${overview[date].weekday}${offTag}<br><span style="font-weight:400;color:#8C7378;">${date.slice(5)}</span>`));
  });

  if (!times.length) {
    // 這一週每天都是公休或完全沒有任何時段
    const note = document.createElement('div');
    note.className = 'day-off-note';
    note.style.gridColumn = '1 / -1';
    note.textContent = '這一週目前沒有任何開放時段';
    cal.appendChild(note);
    return;
  }

  times.forEach((time) => {
    cal.appendChild(div('cal-time', time.slice(0, 5)));
    dates.forEach((date) => {
      const cell = document.createElement('div');
      cell.className = 'slot';

      if (overview[date].isClosed) {
        // 整天公休：不提供逐時段開關，統一到「月曆總覽」的單日詳情去設定
        const note = document.createElement('div');
        note.style.cssText = 'font-size:10.5px;color:#B69EA1;text-align:center;padding-top:14px;';
        note.textContent = '公休';
        cell.appendChild(note);
        cal.appendChild(cell);
        return;
      }

      const slot = overview[date].slots.find((s) => s.startTime === time);
      if (!slot) {
        // 這個時段在這一天原本完全沒開（例如沒有星期規則），
        // 顯示「未開放」讓管理者也能臨時加開單一時段。
        const btn = document.createElement('button');
        btn.className = 'slot-btn unset';
        btn.textContent = '未開放';
        btn.addEventListener('click', async () => {
          if (!confirm(`確定要臨時開放 ${date} ${time.slice(0, 5)} 這個時段嗎？`)) return;
          await toggleSlot(date, time, 'open');
        });
        cell.appendChild(btn);
      } else if (slot.status === 'open') {
        const btn = document.createElement('button');
        btn.className = 'slot-btn open';
        btn.textContent = '可預約';
        btn.addEventListener('click', async () => {
          if (!confirm(`確定要關閉 ${date} ${time.slice(0, 5)} 這個時段嗎？關閉後客人在預約頁就看不到了`)) return;
          await toggleSlot(date, time, 'close');
        });
        cell.appendChild(btn);
      } else if (slot.status === 'closed') {
        const btn = document.createElement('button');
        btn.className = 'slot-btn closed';
        btn.textContent = '已關閉';
        btn.addEventListener('click', async () => {
          if (!confirm(`確定要重新開放 ${date} ${time.slice(0, 5)} 這個時段嗎？`)) return;
          await toggleSlot(date, time, 'reset');
        });
        cell.appendChild(btn);
      } else {
        const btn = document.createElement('button');
        btn.className = 'slot-btn booked';
        const doneMark = slot.booking.status === 'completed' ? '✅ ' : '';
        btn.innerHTML = `${doneMark}${slot.booking.customer_name}<br>${slot.booking.service_name}`;
        btn.addEventListener('click', () => openDrawer(date, time, slot.booking, 'week'));
        cell.appendChild(btn);
      }
      cal.appendChild(cell);
    });
  });
}

async function toggleSlot(date, startTime, action) {
  await fetch('/api/admin/slots/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, startTime, action }),
  });
  loadWeek();
}

function div(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function openDrawer(date, time, booking, context) {
  context = context || 'week';
  const drawer = document.getElementById('drawer');
  const isCompleted = booking.status === 'completed';
  drawer.innerHTML = `
    <button class="close-x" id="closeDrawer">✕</button>
    <h3>${booking.customer_name}</h3>
    <p>${date} ${time.slice(0, 5)}</p>
    <p>療程：${booking.service_name}</p>
    <p>電話：${booking.phone || '未提供'}</p>
    ${booking.note ? `<p>客人備註：${booking.note}</p>` : ''}
    <p>${booking.google_event_id ? '🗓 已同步 Google 日曆' : '⚠️ 尚未同步日曆'}</p>
    <p>${isCompleted ? '✅ 已標記完成（已算進營收）' : '◦ 尚未完成（還沒算進營收）'}</p>
    ${isCompleted ? '' : (currentRole === 'owner' ? '<button id="completeBtn" style="background:var(--sage);">標記完成</button>' : '')}
    ${isCompleted ? '' : '<button id="cancelBtn">取消這筆預約</button>'}
  `;
  document.getElementById('scrim').classList.add('open');
  drawer.classList.add('open');
  renderSkinRecordSection(booking.id);
  document.getElementById('closeDrawer').addEventListener('click', closeDrawer);

  const refreshAfterChange = async () => {
    closeDrawer();
    if (context === 'day') {
      await loadMonth();
      await loadDayDetail(date);
    } else {
      loadWeek();
    }
  };

  const completeBtn = document.getElementById('completeBtn');
  if (completeBtn) {
    completeBtn.addEventListener('click', async () => {
      if (!confirm('確定要標記這筆預約為「已完成」嗎？完成後會算進當天營收，並發送療程後須知圖片給客人。')) return;
      const res = await fetch(`/api/admin/bookings/${booking.id}/complete`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || '操作失敗，請稍後再試');
        return;
      }
      await refreshAfterChange();
    });
  }

  const cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('確定要取消這筆預約嗎？')) return;
      await fetch(`/api/admin/bookings/${booking.id}/cancel`, { method: 'POST' });
      await refreshAfterChange();
    });
  }
}

function closeDrawer() {
  document.getElementById('scrim').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
}
document.getElementById('scrim').addEventListener('click', closeDrawer);

// ---------- 月曆總覽 ----------
document.getElementById('prevMonthBtn').addEventListener('click', () => {
  currentMonth = addMonths(currentMonth, -1);
  loadMonth();
});
document.getElementById('nextMonthBtn').addEventListener('click', () => {
  currentMonth = addMonths(currentMonth, 1);
  loadMonth();
});

async function loadMonth() {
  const [y, m] = currentMonth.split('-').map(Number);
  document.getElementById('monthLabel').textContent = `${y}年${m}月`;
  const res = await fetch(`/api/admin/month?month=${currentMonth}`, { cache: 'no-store' });
  const overview = await res.json();
  lastMonthOverview = overview;
  renderMonthStats(overview.stats);
  renderMonthGrid(overview);
}

function renderMonthStats(stats) {
  document.getElementById('statBookings').textContent = stats.totalBookings;
  document.getElementById('statClosedDays').textContent = stats.closedDays;
  document.getElementById('statSlots').textContent = stats.availableSlots;
  document.getElementById('statRevenue').textContent = formatPrice(stats.totalRevenue);
}

function renderMonthGrid(overview) {
  const grid = document.getElementById('monthGrid');
  grid.innerHTML = '';
  DOW_LABELS.forEach((label) => {
    const d = document.createElement('div');
    d.className = 'dow-label';
    d.textContent = label;
    grid.appendChild(d);
  });

  const [year, month] = currentMonth.split('-').map(Number);
  const total = daysInMonthOf(year, month);
  const firstDateStr = `${currentMonth}-01`;
  const firstJsWeekday = weekdayOf(firstDateStr); // 0=週日
  const leading = firstJsWeekday === 0 ? 6 : firstJsWeekday - 1; // 週一起始，前面要留的空格數

  for (let i = leading; i >= 1; i--) {
    grid.appendChild(otherMonthCell(addDaysStr(firstDateStr, -i)));
  }

  const today = todayYmd();
  for (let d = 1; d <= total; d++) {
    const dateStr = `${currentMonth}-${String(d).padStart(2, '0')}`;
    const info = overview.days[dateStr];
    grid.appendChild(dayCell(dateStr, d, info, dateStr === today));
  }

  const lastDateStr = `${currentMonth}-${String(total).padStart(2, '0')}`;
  const lastJsWeekday = weekdayOf(lastDateStr);
  const trailing = lastJsWeekday === 0 ? 0 : 7 - lastJsWeekday;
  for (let i = 1; i <= trailing; i++) {
    grid.appendChild(otherMonthCell(addDaysStr(lastDateStr, i)));
  }
}

function otherMonthCell(dateStr) {
  const d = document.createElement('div');
  d.className = 'day other-month';
  d.innerHTML = `<div class="date">${Number(dateStr.slice(8, 10))}</div>`;
  return d;
}

function dayCell(dateStr, dayNum, info, isToday) {
  const cell = document.createElement('div');
  cell.className = 'day'
    + (isToday ? ' today' : '')
    + (info.isClosed ? ' off' : '')
    + (dateStr === selectedMonthDate ? ' selected' : '');

  let inner = `<div class="date">${dayNum}</div>`;
  if (info.isClosed) {
    inner += `<div class="day-off-tag">${info.closureType === 'adhoc' ? '臨時公休' : '公休'}</div>`;
  } else {
    const ratio = info.slotsTotal > 0 ? info.slotsBooked / info.slotsTotal : 0;
    const dotClass = info.slotsTotal > 0 && info.slotsBooked >= info.slotsTotal
      ? 'full'
      : ratio >= 0.6
      ? 'busy'
      : 'open';
    inner += `<div class="day-dots"><i class="dot ${dotClass}"></i></div>`;
    inner += `<div class="day-count">${info.bookingsCount}件</div>`;
  }
  cell.innerHTML = inner;
  cell.addEventListener('click', () => selectMonthDate(dateStr));
  return cell;
}

function selectMonthDate(dateStr) {
  selectedMonthDate = dateStr;
  if (lastMonthOverview) renderMonthGrid(lastMonthOverview);
  loadDayDetail(dateStr);
}

async function loadDayDetail(dateStr) {
  const panel = document.getElementById('dayDetail');
  panel.innerHTML = '<div class="detail-empty">載入中...</div>';
  const res = await fetch(`/api/admin/day?date=${dateStr}`, { cache: 'no-store' });
  const detail = await res.json();
  renderDayDetail(detail);
}

function renderDayDetail(detail) {
  const panel = document.getElementById('dayDetail');
  const [, m, d] = detail.date.split('-').map(Number);
  const isToday = detail.date === todayYmd();
  const bookedCount = detail.slots.filter((s) => s.status === 'booked').length;

  let subLine;
  if (detail.isClosed) {
    subLine = detail.closureType === 'adhoc' ? '臨時公休' : '固定公休日';
  } else {
    subLine = `${isToday ? '今天・' : ''}已預約 ${bookedCount} 件 / 開放 ${detail.slots.length} 個時段`;
  }
  if (detail.revenue) subLine += `・營收 ${formatPrice(detail.revenue)}`;

  let html = `
    <h3>${m}月${d}日（週${detail.weekday.replace('週', '')}）</h3>
    <p class="d-sub">${subLine}</p>
    <div class="toggle-switch" id="holidaySwitchRow" style="margin-bottom:6px;">
      <div class="switch ${detail.isClosed ? 'on' : ''}" id="holidaySwitch"></div>
      設為本日公休
    </div>
  `;
  if (detail.closureType === 'adhoc') {
    html += `<div style="margin:0 0 12px;"><a href="#" id="resetClosureLink" style="font-size:11.5px;color:var(--text-muted);">恢復跟著固定公休日設定走</a></div>`;
  } else {
    html += `<div style="margin-bottom:14px;"></div>`;
  }

  if (detail.isClosed) {
    html += `<div class="detail-empty">今天公休，沒有開放時段</div>`;
  } else if (!detail.slots.length) {
    html += `<div class="detail-empty">這天沒有設定任何開放時段</div>`;
  } else {
    detail.slots.forEach((slot) => {
      const time = slot.startTime.slice(0, 5);
      let badgeHtml;
      if (slot.status === 'booked') {
        badgeHtml = `<span class="badge-pill booked">${slot.booking.status === 'completed' ? '✅ ' : ''}${slot.booking.customer_name}・${slot.booking.service_name}</span>`;
      } else if (slot.status === 'closed') {
        badgeHtml = `<span class="badge-pill closed">已關閉</span>`;
      } else {
        badgeHtml = `<span class="badge-pill open">可預約</span>`;
      }
      html += `<div class="detail-row" data-time="${slot.startTime}" data-status="${slot.status}" style="cursor:pointer;">
        <span>${time}</span>${badgeHtml}
      </div>`;
    });
  }

  panel.innerHTML = html;

  document.getElementById('holidaySwitch').addEventListener('click', async () => {
    const nextClosed = !detail.isClosed;
    if (!confirm(`確定要把 ${detail.date} 設為${nextClosed ? '公休' : '開放'}嗎？`)) return;
    await fetch('/api/admin/holidays/date', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: detail.date, action: nextClosed ? 'close' : 'open' }),
    });
    await loadMonth();
    await loadDayDetail(detail.date);
  });

  const resetLink = document.getElementById('resetClosureLink');
  if (resetLink) {
    resetLink.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/admin/holidays/date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: detail.date, action: 'reset' }),
      });
      await loadMonth();
      await loadDayDetail(detail.date);
    });
  }

  if (!detail.isClosed) {
    panel.querySelectorAll('.detail-row').forEach((row) => {
      row.addEventListener('click', () =>
        onDayDetailSlotClick(detail.date, row.dataset.time, row.dataset.status, detail)
      );
    });
  }
}

async function onDayDetailSlotClick(date, time, status, detail) {
  if (status === 'booked') {
    const slot = detail.slots.find((s) => s.startTime === time);
    if (slot && slot.booking) openDrawer(date, time, slot.booking, 'day');
    return;
  }
  const action = status === 'closed' ? 'open' : 'close';
  if (!confirm(`確定要${action === 'close' ? '關閉' : '重新開放'} ${date} ${time.slice(0, 5)} 這個時段嗎？`)) return;
  await fetch('/api/admin/slots/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, startTime: time, action: action === 'open' ? 'reset' : 'close' }),
  });
  await loadMonth();
  await loadDayDetail(date);
}

// ---------- 固定公休日（每週幾） ----------
async function loadWeeklyHolidays() {
  const res = await fetch('/api/admin/holidays/weekly', { cache: 'no-store' });
  const data = await res.json();
  weeklyHolidaySet = new Set(data.weekdays);
  renderDowToggle();
}

function renderDowToggle() {
  const wrap = document.getElementById('dowToggle');
  wrap.innerHTML = '';
  DOW_LABELS.forEach((label, i) => {
    const jsWeekday = DOW_JS[i];
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.className = weeklyHolidaySet.has(jsWeekday) ? 'active' : '';
    btn.addEventListener('click', async () => {
      const nextClosed = !weeklyHolidaySet.has(jsWeekday);
      if (!confirm(`確定要把「每週${label}」設為${nextClosed ? '固定公休' : '恢復開放'}嗎？`)) return;
      await fetch('/api/admin/holidays/weekly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekday: jsWeekday, isClosed: nextClosed }),
      });
      await loadWeeklyHolidays();
      await loadMonth();
      await loadWeek();
      if (selectedMonthDate) await loadDayDetail(selectedMonthDate);
    });
    wrap.appendChild(btn);
  });
}

// ---------- 時段範本設定 ----------
let availCandidateTimes = []; // 目前表格顯示的候選時段（'HH:MM:SS'），使用者可以再加新的進來
let availRules = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

function defaultHourlyTimes() {
  const times = [];
  for (let h = 9; h <= 21; h++) times.push(`${String(h).padStart(2, '0')}:00:00`);
  return times;
}

document.getElementById('availSettingsBtn').addEventListener('click', async () => {
  document.getElementById('availMsg').textContent = '';
  document.getElementById('availMsg').className = 'modal-msg';
  document.getElementById('availScrim').classList.add('open');
  document.getElementById('availTable').innerHTML = '<tr><td>載入中...</td></tr>';

  const res = await fetch('/api/admin/availability', { cache: 'no-store' });
  const data = await res.json();
  availRules = data.rules;

  const usedTimes = new Set(Object.values(availRules).flat());
  defaultHourlyTimes().forEach((t) => usedTimes.add(t));
  availCandidateTimes = [...usedTimes].sort();

  renderAvailGenDays();
  renderAvailTable();
});

// ---------- 快速產生時段（開始時間 + 間隔 + 最後接客時間 → 一組時段清單） ----------
function renderAvailGenDays() {
  const wrap = document.getElementById('availGenDays');
  wrap.innerHTML = '';
  DOW_LABELS.forEach((label, i) => {
    const jsWeekday = DOW_JS[i];
    const id = `availGenDay${jsWeekday}`;
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" id="${id}" data-weekday="${jsWeekday}" ${jsWeekday === 0 ? '' : 'checked'}> 星期${label}`;
    wrap.appendChild(lab);
  });
}

document.getElementById('availGenInterval').addEventListener('change', (e) => {
  document.getElementById('availGenCustomMin').style.display = e.target.value === 'custom' ? 'inline-block' : 'none';
});

// 把 "HH:MM" 轉成當天的分鐘數，方便用固定間隔遞增產生時段清單
function timeStrToMinutes(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
}

// 把表格目前實際勾選的狀態寫回 availRules，避免重新產生時段時，
// 蓋掉使用者剛剛手動微調過、但還沒按「儲存」的其他星期幾
function syncAvailRulesFromTable() {
  const table = document.getElementById('availTable');
  if (!table.querySelector('input[type=checkbox]')) return; // 表格還沒渲染過，跳過
  DOW_JS.forEach((weekday) => {
    availRules[weekday] = [...table.querySelectorAll(`input[data-weekday="${weekday}"]:checked`)].map(
      (cb) => cb.dataset.time
    );
  });
}

document.getElementById('availGenApplyBtn').addEventListener('click', () => {
  syncAvailRulesFromTable();
  const msg = document.getElementById('availMsg');
  const startVal = document.getElementById('availGenStart').value;
  const endVal = document.getElementById('availGenEnd').value;
  const intervalSel = document.getElementById('availGenInterval').value;
  const customMin = document.getElementById('availGenCustomMin').value;
  const interval = intervalSel === 'custom' ? parseInt(customMin, 10) : parseInt(intervalSel, 10);

  if (!startVal || !endVal || !interval || interval <= 0) {
    msg.textContent = '請填寫開始時間、最後接客時間，並選擇（或輸入）有效的間隔分鐘數';
    msg.className = 'modal-msg error';
    return;
  }
  const startMin = timeStrToMinutes(startVal);
  const endMin = timeStrToMinutes(endVal);
  if (endMin < startMin) {
    msg.textContent = '最後接客時間不能早於開始營業時間';
    msg.className = 'modal-msg error';
    return;
  }

  const generated = [];
  for (let m = startMin; m <= endMin; m += interval) generated.push(minutesToTimeStr(m));

  const selectedWeekdays = [...document.querySelectorAll('#availGenDays input:checked')].map(
    (cb) => Number(cb.dataset.weekday)
  );
  if (selectedWeekdays.length === 0) {
    msg.textContent = '請至少勾選一個要套用的星期幾';
    msg.className = 'modal-msg error';
    return;
  }

  // 把產生出來的時段加進候選清單（不會動到其他已經存在、未被選到的星期幾）
  const candidateSet = new Set(availCandidateTimes);
  generated.forEach((t) => candidateSet.add(t));
  availCandidateTimes = [...candidateSet].sort();

  // 對「勾選的星期幾」直接套用這組產生出來的時段（取代原本的勾選狀態），
  // 沒被勾選的星期幾維持原樣，之後仍可在下方表格手動微調再儲存。
  selectedWeekdays.forEach((weekday) => {
    availRules[weekday] = [...generated];
  });

  renderAvailTable();
  msg.textContent = '已產生時段，套用到表格中，確認／微調後別忘了按「儲存」';
  msg.className = 'modal-msg success';
});

function renderAvailTable() {
  const table = document.getElementById('availTable');
  let html = '<tr><th>時段</th>' + DOW_LABELS.map((l) => `<th>${l}</th>`).join('') + '</tr>';
  availCandidateTimes.forEach((time) => {
    html += `<tr data-time="${time}"><td class="time-col">${time.slice(0, 5)}</td>`;
    DOW_JS.forEach((weekday) => {
      const checked = (availRules[weekday] || []).includes(time) ? 'checked' : '';
      html += `<td><input type="checkbox" data-weekday="${weekday}" data-time="${time}" ${checked}></td>`;
    });
    html += '</tr>';
  });
  table.innerHTML = html;
}

document.getElementById('availAddTimeBtn').addEventListener('click', () => {
  const input = document.getElementById('availNewTime');
  if (!input.value) return;
  const time = `${input.value}:00`;
  if (!availCandidateTimes.includes(time)) {
    availCandidateTimes.push(time);
    availCandidateTimes.sort();
    renderAvailTable();
  }
  input.value = '';
});

document.getElementById('availCancelBtn').addEventListener('click', () => {
  document.getElementById('availScrim').classList.remove('open');
});
document.getElementById('availScrim').addEventListener('click', (e) => {
  if (e.target.id === 'availScrim') document.getElementById('availScrim').classList.remove('open');
});

document.getElementById('availSaveBtn').addEventListener('click', async () => {
  const msg = document.getElementById('availMsg');
  const table = document.getElementById('availTable');
  const saveBtn = document.getElementById('availSaveBtn');
  saveBtn.disabled = true;
  msg.textContent = '儲存中...';
  msg.className = 'modal-msg';

  try {
    for (const weekday of DOW_JS) {
      const times = [...table.querySelectorAll(`input[data-weekday="${weekday}"]:checked`)].map(
        (cb) => cb.dataset.time
      );
      await fetch('/api/admin/availability', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weekday, times }),
      });
    }
    msg.textContent = '已儲存！之後套用這個星期幾的日子都會用新的時段範本（已經確定的預約不受影響）';
    msg.className = 'modal-msg success';
    await loadMonth();
    await loadWeek();
    if (selectedMonthDate) await loadDayDetail(selectedMonthDate);
  } catch (err) {
    msg.textContent = '儲存失敗，請稍後再試';
    msg.className = 'modal-msg error';
  } finally {
    saveBtn.disabled = false;
  }
});

// ---------- 品項管理（只有主控管理者能開這個按鈕，但保險起見前端也擋一下） ----------
let svcList = [];
let editingServiceId = null;

document.getElementById('serviceMgmtBtn').addEventListener('click', async () => {
  document.getElementById('serviceScrim').classList.add('open');
  resetSvcForm();
  await loadServices();
});
document.getElementById('svcCloseBtn').addEventListener('click', () => {
  document.getElementById('serviceScrim').classList.remove('open');
});
document.getElementById('serviceScrim').addEventListener('click', (e) => {
  if (e.target.id === 'serviceScrim') document.getElementById('serviceScrim').classList.remove('open');
});

async function loadServices() {
  const msg = document.getElementById('svcMsg');
  msg.textContent = '';
  msg.className = 'modal-msg';
  try {
    const res = await fetch('/api/admin/services', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) {
      document.getElementById('svcTable').innerHTML = '';
      msg.textContent = data.error || '讀取失敗';
      msg.className = 'modal-msg error';
      return;
    }
    svcList = data.services;
    renderSvcTable();
  } catch (err) {
    msg.textContent = '讀取失敗，請稍後再試';
    msg.className = 'modal-msg error';
  }
}

function renderSvcTable() {
  const table = document.getElementById('svcTable');
  let html = '<tr><th>名稱</th><th>類別</th><th>價格</th><th>時長</th><th>升級體驗</th><th>狀態</th><th></th></tr>';
  svcList.forEach((s) => {
    html += `<tr class="${s.is_active ? '' : 'row-inactive'}" data-id="${s.id}">
      <td>${s.name}</td>
      <td>${s.category || '—'}</td>
      <td class="num">${s.price != null ? formatPrice(s.price) : '—'}</td>
      <td class="num">${s.duration_minutes} 分</td>
      <td>${s.is_addon ? '是' : '—'}</td>
      <td>${s.is_active ? '啟用中' : '已停用'}</td>
      <td class="op-btns">
        <button type="button" data-action="edit">編輯</button>
        <button type="button" data-action="toggle">${s.is_active ? '停用' : '啟用'}</button>
      </td>
    </tr>`;
  });
  table.innerHTML = html;

  table.querySelectorAll('button[data-action]').forEach((btn) => {
    const row = btn.closest('tr');
    const id = Number(row.dataset.id);
    const service = svcList.find((s) => s.id === id);
    if (btn.dataset.action === 'edit') {
      btn.addEventListener('click', () => fillSvcFormForEdit(service));
    } else {
      btn.addEventListener('click', () => toggleServiceActive(service));
    }
  });
}

function resetSvcForm() {
  editingServiceId = null;
  document.getElementById('svcFormTitle').textContent = '新增項目';
  document.getElementById('svcName').value = '';
  document.getElementById('svcCategory').value = '';
  document.getElementById('svcPrice').value = '';
  document.getElementById('svcDuration').value = '';
  document.getElementById('svcSortOrder').value = '';
  document.getElementById('svcNote').value = '';
  document.getElementById('svcIsAddon').checked = false;
  document.getElementById('svcSaveBtn').textContent = '新增項目';
  document.getElementById('svcCancelEditBtn').hidden = true;
}

function fillSvcFormForEdit(service) {
  editingServiceId = service.id;
  document.getElementById('svcFormTitle').textContent = `編輯：${service.name}`;
  document.getElementById('svcName').value = service.name;
  document.getElementById('svcCategory').value = service.category || '';
  document.getElementById('svcPrice').value = service.price != null ? service.price : '';
  document.getElementById('svcDuration').value = service.duration_minutes;
  document.getElementById('svcSortOrder').value = service.sort_order != null ? service.sort_order : '';
  document.getElementById('svcNote').value = service.note || '';
  document.getElementById('svcIsAddon').checked = !!service.is_addon;
  document.getElementById('svcSaveBtn').textContent = '儲存修改';
  document.getElementById('svcCancelEditBtn').hidden = false;
  document.getElementById('svcForm').scrollIntoView({ block: 'nearest' });
}

document.getElementById('svcCancelEditBtn').addEventListener('click', resetSvcForm);

document.getElementById('svcSaveBtn').addEventListener('click', async () => {
  const msg = document.getElementById('svcMsg');
  const name = document.getElementById('svcName').value.trim();
  if (!name) {
    msg.textContent = '請輸入項目名稱';
    msg.className = 'modal-msg error';
    return;
  }
  const payload = {
    name,
    category: document.getElementById('svcCategory').value.trim() || null,
    price: document.getElementById('svcPrice').value === '' ? null : Number(document.getElementById('svcPrice').value),
    durationMinutes: document.getElementById('svcDuration').value === '' ? 60 : Number(document.getElementById('svcDuration').value),
    isAddon: document.getElementById('svcIsAddon').checked,
    // 一定要把排序值送出去。之前漏掉這個欄位，後端收到 undefined 會存成 0，
    // 導致老闆每編輯一次項目，該項目的排序就被歸零，整個療程/類別順序跟著亂掉。
    sortOrder: document.getElementById('svcSortOrder').value === ''
      ? 0
      : Number(document.getElementById('svcSortOrder').value),
    note: document.getElementById('svcNote').value.trim() || null,
  };
  const url = editingServiceId ? `/api/admin/services/${editingServiceId}` : '/api/admin/services';
  const method = editingServiceId ? 'PUT' : 'POST';
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.textContent = data.error || '儲存失敗';
      msg.className = 'modal-msg error';
      return;
    }
    msg.textContent = editingServiceId ? '已更新這個項目' : '已新增這個項目';
    msg.className = 'modal-msg success';
    resetSvcForm();
    await loadServices();
  } catch (err) {
    msg.textContent = '儲存失敗，請稍後再試';
    msg.className = 'modal-msg error';
  }
});

async function toggleServiceActive(service) {
  const nextActive = !service.is_active;
  if (!confirm(`確定要把「${service.name}」設為${nextActive ? '啟用' : '停用'}嗎？`)) return;
  await fetch(`/api/admin/services/${service.id}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: nextActive }),
  });
  await loadServices();
}

// ---------- 子帳號管理 ----------
document.getElementById('subAcctBtn').addEventListener('click', async () => {
  document.getElementById('subAcctScrim').classList.add('open');
  document.getElementById('subAcctMsg').textContent = '';
  document.getElementById('newAcctUser').value = '';
  document.getElementById('newAcctPw').value = '';
  document.getElementById('newAcctRole').value = 'staff';
  await loadAccounts();
});
document.getElementById('subAcctCloseBtn').addEventListener('click', () => {
  document.getElementById('subAcctScrim').classList.remove('open');
});
document.getElementById('subAcctScrim').addEventListener('click', (e) => {
  if (e.target.id === 'subAcctScrim') document.getElementById('subAcctScrim').classList.remove('open');
});

async function loadAccounts() {
  const wrap = document.getElementById('acctListWrap');
  wrap.innerHTML = '<div class="modal-sub">載入中...</div>';
  const res = await fetch('/api/admin/accounts', { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) {
    wrap.innerHTML = `<div class="modal-msg error">${data.error || '讀取失敗'}</div>`;
    return;
  }
  wrap.innerHTML = '';
  data.accounts.forEach((acc) => {
    const roleLabel = acc.role === 'owner' ? '管理者' : '操作人員';
    const row = document.createElement('div');
    row.className = 'acct-list-row';
    row.innerHTML = `<span>${acc.username}<span class="role-tag ${acc.role}">${roleLabel}</span></span>`;
    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn';
    delBtn.textContent = '刪除';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`確定要刪除帳號「${acc.username}」嗎？`)) return;
      const delRes = await fetch(`/api/admin/accounts/${acc.id}`, { method: 'DELETE' });
      const delData = await delRes.json();
      if (!delRes.ok) {
        document.getElementById('subAcctMsg').textContent = delData.error || '刪除失敗';
        document.getElementById('subAcctMsg').className = 'modal-msg error';
        return;
      }
      await loadAccounts();
    });
    row.appendChild(delBtn);
    wrap.appendChild(row);
  });
}

document.getElementById('newAcctAddBtn').addEventListener('click', async () => {
  const msg = document.getElementById('subAcctMsg');
  const username = document.getElementById('newAcctUser').value.trim();
  const password = document.getElementById('newAcctPw').value;
  const role = document.getElementById('newAcctRole').value;
  if (!username || !password) {
    msg.textContent = '請輸入帳號與密碼';
    msg.className = 'modal-msg error';
    return;
  }
  const res = await fetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, role }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error || '新增失敗';
    msg.className = 'modal-msg error';
    return;
  }
  msg.textContent = `已新增帳號「${data.account.username}」`;
  msg.className = 'modal-msg success';
  document.getElementById('newAcctUser').value = '';
  document.getElementById('newAcctPw').value = '';
  await loadAccounts();
});

// ---------- 皮膚紀錄欄位設定（只有主控管理者能開這個按鈕）----------
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadIntakeSettings() {
  const msg = document.getElementById('intakeMsg');
  msg.textContent = '';
  msg.className = 'modal-msg';
  const [qRes, cRes] = await Promise.all([
    fetch('/api/admin/intake-questions', { cache: 'no-store' }),
    fetch('/api/admin/skin-note-codes', { cache: 'no-store' }),
  ]);
  const qData = await qRes.json();
  const cData = await cRes.json();
  renderIntakeQuestionList(qData.questions || []);
  renderSkinCodeList(cData.codes || []);
}

function renderIntakeQuestionList(questions) {
  const wrap = document.getElementById('intakeQuestionList');
  wrap.innerHTML = '';
  questions.forEach((q) => {
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <div class="field-item-row">
        <input type="text" class="q-label" value="${escapeHtml(q.label)}">
        <select class="q-type">
          <option value="multi" ${q.input_type === 'multi' ? 'selected' : ''}>可複選</option>
          <option value="single" ${q.input_type === 'single' ? 'selected' : ''}>單選</option>
        </select>
        <label><input type="checkbox" class="q-allow-other" ${q.allow_other ? 'checked' : ''}>補充欄</label>
        <label><input type="checkbox" class="q-active" ${q.is_active ? 'checked' : ''}>啟用</label>
        <button type="button" class="mini-btn q-save">儲存</button>
        <button type="button" class="mini-btn danger q-delete">刪除題目</button>
      </div>
      <div class="field-opts">
        ${q.options.map((o) => `<span class="field-opt-chip" data-option-id="${o.id}">${escapeHtml(o.label)}<button type="button" class="opt-delete">✕</button></span>`).join('')}
      </div>
      <div class="field-add-opt">
        <input type="text" class="new-opt-input" placeholder="新增選項">
        <button type="button" class="new-opt-btn">加入</button>
      </div>
    `;
    wrap.appendChild(item);

    item.querySelector('.q-save').addEventListener('click', async () => {
      const label = item.querySelector('.q-label').value.trim();
      if (!label) return;
      await fetch(`/api/admin/intake-questions/${q.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          inputType: item.querySelector('.q-type').value,
          allowOther: item.querySelector('.q-allow-other').checked,
          sortOrder: q.sort_order,
          isActive: item.querySelector('.q-active').checked,
        }),
      });
      document.getElementById('intakeMsg').textContent = `已儲存「${label}」`;
      document.getElementById('intakeMsg').className = 'modal-msg success';
    });

    item.querySelector('.q-delete').addEventListener('click', async () => {
      if (!confirm(`確定要刪除題目「${q.label}」嗎？之前客人填過的答案仍會保留，但不會再顯示在預約頁。`)) return;
      await fetch(`/api/admin/intake-questions/${q.id}`, { method: 'DELETE' });
      loadIntakeSettings();
    });

    item.querySelectorAll('.opt-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const optionId = btn.closest('.field-opt-chip').dataset.optionId;
        await fetch(`/api/admin/intake-options/${optionId}`, { method: 'DELETE' });
        loadIntakeSettings();
      });
    });

    item.querySelector('.new-opt-btn').addEventListener('click', async () => {
      const input = item.querySelector('.new-opt-input');
      const label = input.value.trim();
      if (!label) return;
      await fetch(`/api/admin/intake-questions/${q.id}/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, sortOrder: q.options.length }),
      });
      loadIntakeSettings();
    });
  });
}

function renderSkinCodeList(codes) {
  const wrap = document.getElementById('skinCodeList');
  wrap.innerHTML = '';
  codes.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'field-item';
    item.innerHTML = `
      <div class="field-item-row">
        <input type="text" class="c-code" value="${escapeHtml(c.code)}" style="max-width:60px; flex:0 0 auto;">
        <input type="text" class="c-label" value="${escapeHtml(c.label)}">
        <label><input type="checkbox" class="c-active" ${c.is_active ? 'checked' : ''}>啟用</label>
        <button type="button" class="mini-btn c-save">儲存</button>
        <button type="button" class="mini-btn danger c-delete">刪除</button>
      </div>
    `;
    wrap.appendChild(item);

    item.querySelector('.c-save').addEventListener('click', async () => {
      const code = item.querySelector('.c-code').value.trim();
      const label = item.querySelector('.c-label').value.trim();
      if (!code || !label) return;
      const res = await fetch(`/api/admin/skin-note-codes/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label, sortOrder: c.sort_order, isActive: item.querySelector('.c-active').checked }),
      });
      const data = await res.json();
      document.getElementById('intakeMsg').textContent = res.ok ? `已儲存代碼「${code}」` : (data.error || '儲存失敗');
      document.getElementById('intakeMsg').className = res.ok ? 'modal-msg success' : 'modal-msg error';
    });

    item.querySelector('.c-delete').addEventListener('click', async () => {
      if (!confirm(`確定要刪除代碼「${c.code} ${c.label}」嗎？`)) return;
      await fetch(`/api/admin/skin-note-codes/${c.id}`, { method: 'DELETE' });
      loadIntakeSettings();
    });
  });
}

document.getElementById('intakeSettingsBtn').addEventListener('click', () => {
  document.getElementById('intakeScrim').classList.add('open');
  loadIntakeSettings();
});
document.getElementById('intakeCloseBtn').addEventListener('click', () => {
  document.getElementById('intakeScrim').classList.remove('open');
});
document.getElementById('intakeScrim').addEventListener('click', (e) => {
  if (e.target.id === 'intakeScrim') document.getElementById('intakeScrim').classList.remove('open');
});

document.getElementById('addQuestionBtn').addEventListener('click', async () => {
  const input = document.getElementById('newQuestionLabel');
  const label = input.value.trim();
  if (!label) return;
  await fetch('/api/admin/intake-questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      label,
      inputType: document.getElementById('newQuestionType').value,
      allowOther: document.getElementById('newQuestionAllowOther').checked,
      sortOrder: 999,
    }),
  });
  input.value = '';
  loadIntakeSettings();
});

document.getElementById('addCodeBtn').addEventListener('click', async () => {
  const codeInput = document.getElementById('newCodeLetter');
  const labelInput = document.getElementById('newCodeLabel');
  const code = codeInput.value.trim();
  const label = labelInput.value.trim();
  if (!code || !label) return;
  const res = await fetch('/api/admin/skin-note-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label, sortOrder: 999 }),
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById('intakeMsg').textContent = data.error || '新增失敗';
    document.getElementById('intakeMsg').className = 'modal-msg error';
    return;
  }
  codeInput.value = '';
  labelInput.value = '';
  loadIntakeSettings();
});

// ---------- 單筆預約詳情裡的「皮膚狀態紀錄」：客人填的問卷（唯讀）＋老闆填的詳細紀錄（可編輯）----------
async function renderSkinRecordSection(bookingId) {
  if (!isModuleOn('skinRecord')) return; // 皮膚紀錄模組未開通：預約詳情不顯示這一區
  const drawer = document.getElementById('drawer');
  const holder = document.createElement('div');
  holder.className = 'skin-record-section';
  holder.innerHTML = '<h4>皮膚狀態紀錄</h4><p style="font-size:12px;color:var(--text-muted);">載入中...</p>';
  drawer.appendChild(holder);

  try {
    const res = await fetch(`/api/admin/bookings/${bookingId}/skin-record`, { cache: 'no-store' });
    const data = await res.json();
    const answers = data.intakeAnswers || [];
    const codes = data.codes || [];
    const notes = data.skinNotes || {};
    const codeValues = notes.code_values || {};

    const answersHtml = answers.length
      ? answers.map((a) => `
          <div class="skin-answer-row">
            <span class="qk">${escapeHtml(a.question_label)}：</span>
            ${a.selected_labels && a.selected_labels.length ? escapeHtml(a.selected_labels.join('、')) : ''}
            ${a.other_text ? `（${escapeHtml(a.other_text)}）` : ''}
          </div>
        `).join('')
      : '<p style="font-size:12px;color:var(--text-muted);">客人預約時沒有填寫基本狀態諮詢</p>';

    holder.innerHTML = `
      <h4>皮膚狀態紀錄</h4>
      <div style="margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:4px;">客人填寫的基本狀態諮詢</div>
        ${answersHtml}
      </div>
      <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:6px;">您的看診紀錄</div>
      <div class="skin-code-grid" id="skinCodeGrid"></div>
      <label style="display:block;margin-top:6px;">療程建議</label>
      <textarea id="skinTreatmentSuggestion">${escapeHtml(notes.treatment_suggestion || '')}</textarea>
      <label style="display:block;margin-top:6px;">護理程序</label>
      <textarea id="skinCareProcedure">${escapeHtml(notes.care_procedure || '')}</textarea>
      <label style="display:block;margin-top:6px;">產品建議</label>
      <textarea id="skinProductSuggestion">${escapeHtml(notes.product_suggestion || '')}</textarea>
      <button type="button" id="skinNotesSaveBtn" style="background:var(--accent);">儲存看診紀錄</button>
      <div class="modal-msg" id="skinNotesMsg"></div>
    `;

    const grid = document.getElementById('skinCodeGrid');
    codes.forEach((c) => {
      const field = document.createElement('div');
      field.innerHTML = `
        <label>${escapeHtml(c.code)}．${escapeHtml(c.label)}</label>
        <input type="text" class="skin-code-input" data-code="${escapeHtml(c.code)}" value="${escapeHtml(codeValues[c.code] || '')}">
      `;
      grid.appendChild(field);
    });

    document.getElementById('skinNotesSaveBtn').addEventListener('click', async () => {
      const msg = document.getElementById('skinNotesMsg');
      const newCodeValues = {};
      grid.querySelectorAll('.skin-code-input').forEach((inp) => {
        if (inp.value.trim()) newCodeValues[inp.dataset.code] = inp.value.trim();
      });
      msg.textContent = '儲存中...';
      msg.className = 'modal-msg';
      const saveRes = await fetch(`/api/admin/bookings/${bookingId}/skin-record`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codeValues: newCodeValues,
          treatmentSuggestion: document.getElementById('skinTreatmentSuggestion').value.trim(),
          careProcedure: document.getElementById('skinCareProcedure').value.trim(),
          productSuggestion: document.getElementById('skinProductSuggestion').value.trim(),
        }),
      });
      msg.textContent = saveRes.ok ? '已儲存' : '儲存失敗，請稍後再試';
      msg.className = saveRes.ok ? 'modal-msg success' : 'modal-msg error';
    });
  } catch (err) {
    holder.innerHTML = '<h4>皮膚狀態紀錄</h4><p style="font-size:12px;color:var(--danger);">讀取失敗，請稍後再試</p>';
  }
}

// ---------- 客戶管理 ----------
document.getElementById('customerSearchInput').addEventListener('input', (e) => {
  clearTimeout(customerSearchDebounceTimer);
  const value = e.target.value;
  customerSearchDebounceTimer = setTimeout(() => loadCustomers(value), 300);
});

async function loadCustomers(search) {
  const wrap = document.getElementById('customerListWrap');
  wrap.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">載入中...</p>';
  const qs = search && search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
  try {
    const res = await fetch(`/api/admin/customers${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('讀取失敗');
    const data = await res.json();
    renderCustomerList(data.customers || []);
  } catch (err) {
    wrap.innerHTML = '<p style="font-size:13px;color:var(--danger, #B3453A);">讀取失敗，請重新整理頁面再試一次</p>';
  }
}

function renderCustomerList(customers) {
  const wrap = document.getElementById('customerListWrap');
  if (!customers.length) {
    wrap.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">沒有符合的客戶</p>';
    return;
  }
  wrap.innerHTML = '';
  customers.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'customer-row';
    row.innerHTML = `
      <div>
        <div class="c-name">${escapeHtml(c.name)}</div>
        <div class="c-phone">${escapeHtml(c.phone || '未提供電話')}</div>
      </div>
      <div class="c-stats">
        <div><b>${c.total_bookings}</b> 次預約・<b>${c.completed_bookings}</b> 次完成</div>
        ${c.total_revenue == null ? '' : `<div>累積消費 ${formatPrice(c.total_revenue)}</div>`}
        <div>最近到店：${c.last_visit || '尚未到店'}</div>
      </div>
    `;
    row.addEventListener('click', () => openCustomerDetail(c.id));
    wrap.appendChild(row);
  });
}

const BOOKING_STATUS_LABEL = { confirmed: '已確認', completed: '已完成', cancelled: '已取消' };
const BOOKING_STATUS_CLASS = { confirmed: 'booked', completed: 'completed', cancelled: 'cancelled' };

async function openCustomerDetail(customerId) {
  document.getElementById('customerScrim').classList.add('open');
  document.getElementById('customerDetailName').textContent = '載入中...';
  document.getElementById('customerDetailSub').textContent = '';
  document.getElementById('customerHistoryList').innerHTML = '';

  const res = await fetch(`/api/admin/customers/${customerId}`, { cache: 'no-store' });
  if (!res.ok) {
    document.getElementById('customerDetailName').textContent = '讀取失敗';
    return;
  }
  const data = await res.json();
  const { customer, bookings } = data;

  document.getElementById('customerDetailName').textContent = customer.name;
  document.getElementById('customerDetailSub').textContent =
    `${customer.phone || '未提供電話'}・註冊於 ${customer.created_at}・共 ${bookings.length} 筆歷史紀錄`;

  const list = document.getElementById('customerHistoryList');
  if (!bookings.length) {
    list.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">這位客戶還沒有任何預約紀錄</p>';
    return;
  }

  list.innerHTML = bookings.map((b) => {
    const addonsText = (b.addons || []).map((a) => a.name).join('、');
    const price = Number(b.price || 0) + (b.addons || []).reduce((sum, a) => sum + Number(a.price || 0), 0);
    const answersHtml = (b.intakeAnswers || []).length
      ? b.intakeAnswers.map((a) => `
          <div class="skin-answer-row">
            <span class="qk">${escapeHtml(a.question_label)}：</span>
            ${a.selected_labels && a.selected_labels.length ? escapeHtml(a.selected_labels.join('、')) : ''}
            ${a.other_text ? `（${escapeHtml(a.other_text)}）` : ''}
          </div>
        `).join('')
      : '';
    const notes = b.skinNotes;
    const hasNotes = notes && (Object.keys(notes.code_values || {}).length || notes.treatment_suggestion || notes.care_procedure || notes.product_suggestion);
    const notesHtml = hasNotes
      ? `
        ${Object.entries(notes.code_values || {}).map(([code, val]) => `<div class="skin-answer-row"><span class="qk">${escapeHtml(code)}：</span>${escapeHtml(val)}</div>`).join('')}
        ${notes.treatment_suggestion ? `<div class="skin-answer-row"><span class="qk">療程建議：</span>${escapeHtml(notes.treatment_suggestion)}</div>` : ''}
        ${notes.care_procedure ? `<div class="skin-answer-row"><span class="qk">護理程序：</span>${escapeHtml(notes.care_procedure)}</div>` : ''}
        ${notes.product_suggestion ? `<div class="skin-answer-row"><span class="qk">產品建議：</span>${escapeHtml(notes.product_suggestion)}</div>` : ''}
      `
      : '';

    return `
      <div class="cust-booking-item">
        <div class="cbi-head">
          <span class="cbi-date">${b.slot_date} ${b.start_time.slice(0, 5)}</span>
          <span class="badge-pill ${BOOKING_STATUS_CLASS[b.status] || 'booked'}">${BOOKING_STATUS_LABEL[b.status] || b.status}</span>
        </div>
        <div class="cbi-detail">${escapeHtml(b.service_name)}${addonsText ? `（+${escapeHtml(addonsText)}）` : ''}・${formatPrice(price)}</div>
        ${b.note ? `<div class="cbi-detail">客人備註：${escapeHtml(b.note)}</div>` : ''}
        ${answersHtml || notesHtml ? `<div class="cbi-sub">${answersHtml}${notesHtml}</div>` : ''}
      </div>
    `;
  }).join('');
}

document.getElementById('customerDetailCloseBtn').addEventListener('click', () => {
  document.getElementById('customerScrim').classList.remove('open');
});
document.getElementById('customerScrim').addEventListener('click', (e) => {
  if (e.target.id === 'customerScrim') document.getElementById('customerScrim').classList.remove('open');
});

// ---------- 營收明細 ----------
document.getElementById('statRevenueCard').addEventListener('click', openRevenueDetail);
document.getElementById('revenueDetailCloseBtn').addEventListener('click', () => {
  document.getElementById('revenueScrim').classList.remove('open');
});
document.getElementById('revenueScrim').addEventListener('click', (e) => {
  if (e.target.id === 'revenueScrim') document.getElementById('revenueScrim').classList.remove('open');
});

async function openRevenueDetail() {
  const month = currentMonth;
  document.getElementById('revenueScrim').classList.add('open');
  document.getElementById('revenueDetailTitle').textContent = `${month} 營收明細`;
  const list = document.getElementById('revenueDetailList');
  list.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">載入中...</p>';

  let items;
  try {
    const res = await fetch(`/api/admin/revenue-detail?month=${encodeURIComponent(month)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('讀取失敗');
    const data = await res.json();
    items = data.items || [];
  } catch (err) {
    list.innerHTML = '<p style="font-size:13px;color:var(--danger, #B3453A);">讀取失敗，請重新整理頁面再試一次</p>';
    return;
  }

  if (!items.length) {
    list.innerHTML = '<p style="font-size:13px;color:var(--text-muted);">這個月還沒有已完成的預約</p>';
    return;
  }

  const total = items.reduce((sum, it) => sum + Number(it.total || 0), 0);
  list.innerHTML = items.map((it) => {
    const addonsText = (it.addons || []).map((a) => `${a.name} ${formatPrice(a.price)}`).join('、');
    return `
      <div class="rev-row">
        <div class="rev-left">
          <b>${it.slot_date} ${it.start_time.slice(0, 5)}・${escapeHtml(it.customer_name)}</b>
          <div class="rev-sub">${escapeHtml(it.service_name)} ${formatPrice(it.price)}${addonsText ? `・升級體驗：${escapeHtml(addonsText)}` : ''}</div>
        </div>
        <div class="rev-amount">${formatPrice(it.total)}</div>
      </div>
    `;
  }).join('') + `<div class="rev-total-row"><span>合計（${items.length} 筆）</span><span>${formatPrice(total)}</span></div>`;
}

// ---------- 預約開放範圍 ----------
document.getElementById('bookingWindowBtn').addEventListener('click', () => {
  document.getElementById('bookingWindowScrim').classList.add('open');
  loadBookingWindow();
});
document.getElementById('bookingWindowCloseBtn').addEventListener('click', () => {
  document.getElementById('bookingWindowScrim').classList.remove('open');
});
document.getElementById('bookingWindowScrim').addEventListener('click', (e) => {
  if (e.target.id === 'bookingWindowScrim') document.getElementById('bookingWindowScrim').classList.remove('open');
});

async function loadBookingWindow() {
  const msg = document.getElementById('bookingWindowMsg');
  msg.textContent = '';
  msg.className = 'modal-msg';
  const res = await fetch('/api/admin/booking-window', { cache: 'no-store' });
  const data = await res.json();
  document.getElementById('bookingWindowCurrent').textContent = formatMonthLabel(data.openUntilMonth);
  document.getElementById('bookingWindowOpenNextBtn').dataset.currentOpenUntil = data.openUntilMonth;
}

function formatMonthLabel(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return `${y}年${m}月`;
}

document.getElementById('bookingWindowOpenNextBtn').addEventListener('click', async () => {
  const msg = document.getElementById('bookingWindowMsg');
  const currentOpenUntil = document.getElementById('bookingWindowOpenNextBtn').dataset.currentOpenUntil;
  const nextMonth = addMonths(currentOpenUntil, 1);
  const res = await fetch('/api/admin/booking-window', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ month: nextMonth }),
  });
  const data = await res.json();
  if (!res.ok) {
    msg.textContent = data.error || '更新失敗，請稍後再試';
    msg.className = 'modal-msg error';
    return;
  }
  document.getElementById('bookingWindowCurrent').textContent = formatMonthLabel(data.openUntilMonth);
  document.getElementById('bookingWindowOpenNextBtn').dataset.currentOpenUntil = data.openUntilMonth;
  msg.textContent = `已開放到 ${formatMonthLabel(data.openUntilMonth)}`;
  msg.className = 'modal-msg success';
});

checkSession();


// ============================================================
// 店家設定：功能模組、店名、主題色，以及電腦版左側導覽
// ============================================================
let storeConfigState = null;

function isModuleOn(key) {
  // 設定還沒載入、或讀取失敗時，維持原本行為（顯示功能），不要因為網路問題誤把功能藏起來。
  const mod = storeConfigState && storeConfigState.modules && storeConfigState.modules[key];
  return mod ? mod.enabled : true;
}

function showToast(text) {
  const el = document.createElement('div');
  el.textContent = text;
  el.setAttribute('role', 'status');
  el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#2E2426;color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;z-index:60;max-width:90vw;';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

// 沒有任何可見項目的群組整組收起來（例如操作人員看不到的設定類項目）。
function refreshSidebarGroups() {
  document.querySelectorAll('#sideNav .side-group').forEach((group) => {
    const visible = [...group.querySelectorAll('.side-item')].some((btn) => !btn.hidden);
    group.classList.toggle('is-empty', !visible);
  });
}

function mixHex(hex, target, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const goal = parseInt(target.slice(1), 16);
  const goals = [(goal >> 16) & 255, (goal >> 8) & 255, goal & 255];
  return '#' + channels.map((c, i) => Math.round(c + (goals[i] - c) * amount).toString(16).padStart(2, '0')).join('');
}

function applyTheme(color) {
  const root = document.documentElement.style;
  if (!color) {
    ['--accent', '--accent-strong', '--accent-soft'].forEach((name) => root.removeProperty(name));
    return;
  }
  root.setProperty('--accent', color);
  root.setProperty('--accent-strong', mixHex(color, '#000000', 0.22));
  root.setProperty('--accent-soft', mixHex(color, '#ffffff', 0.82));
}

function applyStoreConfig() {
  const cfg = storeConfigState;
  if (!cfg) return;
  const name = cfg.brand.name;
  document.getElementById('sideBrand').textContent = name;
  const h1 = document.querySelector('#mainBox .top h1');
  if (h1) h1.textContent = `${name} 管理後台`;
  document.title = `${name} 預約管理後台`;
  applyTheme(cfg.brand.themeColor);

  document.querySelectorAll('#sideNav [data-module]').forEach((btn) => {
    const off = !isModuleOn(btn.dataset.module);
    btn.classList.toggle('is-off', off);
    btn.setAttribute('aria-disabled', off ? 'true' : 'false');
    btn.title = off ? '此功能尚未開通' : '';
  });
  const revenueOn = isModuleOn('revenue');
  document.getElementById('statRevenueCard').style.display = revenueOn ? '' : 'none';
  document.querySelector('.stat-row').classList.toggle('rev-off', !revenueOn);
  refreshSidebarGroups();
}

async function loadStoreConfig() {
  try {
    const res = await fetch('/api/admin/config', { cache: 'no-store' });
    if (!res.ok) return;
    storeConfigState = await res.json();
    applyStoreConfig();
    loadMonth(); // 營收數字是否顯示取決於模組，重新載入一次月曆統計
  } catch (err) {
    console.error('讀取店家設定失敗', err);
  }
}

document.querySelectorAll('#sideNav .side-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('is-off')) {
      showToast('此功能尚未開通，需要的話請聯絡系統管理者');
      return;
    }
    if (btn.dataset.tab) { switchTab(btn.dataset.tab); return; }
    const target = document.getElementById(btn.dataset.proxy);
    if (target) target.click();
  });
});

// ---------- 功能模組視窗 ----------
const modulesScrim = document.getElementById('modulesScrim');

function openModulesModal() {
  const cfg = storeConfigState;
  if (!cfg) { showToast('設定尚未載入，請稍後再試'); return; }
  const list = document.getElementById('modulesList');
  list.innerHTML = '';
  Object.entries(cfg.modules).forEach(([key, mod]) => {
    const row = document.createElement('label');
    row.className = 'module-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.module = key;
    box.checked = mod.enabled;
    const text = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = mod.label;
    const desc = document.createElement('span');
    desc.textContent = mod.description;
    text.append(title, desc);
    row.append(box, text);
    list.appendChild(row);
  });
  document.getElementById('brandNameInput').value = cfg.brand.name;
  document.getElementById('brandColorInput').value = cfg.brand.themeColor || '#c97b86';
  document.getElementById('brandColorDefault').checked = !cfg.brand.themeColor;
  document.getElementById('modulesMsg').textContent = '';
  modulesScrim.classList.add('open');
}

document.getElementById('modulesBtn').addEventListener('click', openModulesModal);
document.getElementById('modulesCloseBtn').addEventListener('click', () => modulesScrim.classList.remove('open'));
modulesScrim.addEventListener('click', (e) => { if (e.target === modulesScrim) modulesScrim.classList.remove('open'); });
document.getElementById('brandColorInput').addEventListener('input', () => {
  document.getElementById('brandColorDefault').checked = false;
});

document.getElementById('modulesSaveBtn').addEventListener('click', async () => {
  const msg = document.getElementById('modulesMsg');
  const cfg = storeConfigState;
  // 只送出有變動的項目，沒動到的設定維持伺服器上的值。
  const body = {};
  const modules = {};
  document.querySelectorAll('#modulesList input[data-module]').forEach((box) => {
    if (box.checked !== cfg.modules[box.dataset.module].enabled) modules[box.dataset.module] = box.checked;
  });
  if (Object.keys(modules).length) body.modules = modules;
  const brand = {};
  const name = document.getElementById('brandNameInput').value.trim();
  if (name !== cfg.brand.name) brand.name = name;
  const color = document.getElementById('brandColorDefault').checked ? null : document.getElementById('brandColorInput').value;
  if (color !== cfg.brand.themeColor) brand.themeColor = color;
  if (Object.keys(brand).length) body.brand = brand;
  if (!Object.keys(body).length) { modulesScrim.classList.remove('open'); return; }

  msg.style.color = '';
  msg.textContent = '儲存中...';
  const res = await fetch('/api/admin/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    msg.style.color = '#B3453A';
    msg.textContent = data.fields ? Object.values(data.fields).join('、') : (data.error || '儲存失敗，請稍後再試');
    return;
  }
  modulesScrim.classList.remove('open');
  await loadStoreConfig();
  showToast('已儲存');
});
