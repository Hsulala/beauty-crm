// 妍序 Skin 預約頁前端邏輯（無框架，單純 fetch + DOM 操作，保持簡單好維護）

const state = {
  liffId: null, // 由後端注入，見下方 fetchLiffId
  services: [],
  addons: [], // 升級體驗項目（is_addon = true，介面上稱為「升級體驗」），不會出現在療程分類清單裡
  categories: [],
  selectedCategory: null,
  selectedService: null, // 完整 service 物件，不只是 id，方便顯示名稱/價格
  selectedAddonIds: new Set(),
  selectedDate: null,
  selectedTime: null,
  weekStart: null, // 目前顯示的這週的週一，YYYY-MM-DD
  minWeekStart: null, // 本週的週一，不能往回翻到更早的週
  intakeQuestions: [], // 「基本狀態諮詢」題目，選填，不影響預約成立
  intakeSelections: {}, // questionId -> Set(選中的選項文字)
  openUntilDate: null, // 目前最多能預約到哪一天（'YYYY-MM-DD'），預設只到本月底
};

// 純日期字串運算，不用 new Date() 做時區轉換，避免手機/電腦時區不同造成算錯天
function parseYmd(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}
function toYmd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function addDays(dateStr, days) {
  const { y, m, d } = parseYmd(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return toYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
function mondayOf(dateStr) {
  const { y, m, d } = parseYmd(dateStr);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=週日...6=週六
  const diff = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dateStr, diff);
}
function todayYmd() {
  const now = new Date();
  return toYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
function formatPrice(price) {
  if (price === null || price === undefined) return '';
  return `$${Number(price).toLocaleString('zh-Hant-TW')}`;
}

async function fetchLiffId() {
  // LIFF ID 不是敏感資訊，但避免寫死在前端原始碼裡難以更換，改由伺服器提供一個小端點
  const res = await fetch('/api/liff-config');
  const data = await res.json();
  return data.liffId;
}

async function init() {
  state.liffId = await fetchLiffId();
  await liff.init({ liffId: state.liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  await loadServices();
  await loadIntakeQuestions();
  await loadBookingWindow();
  await prefillCustomerProfile();
  setupWeekNav();
  bindStepNav();
  bindSubmit();
}

// 老客人之前留過姓名/電話的話，直接帶入表單，不用每次重打；填錯了客人自己還是可以改
async function prefillCustomerProfile() {
  try {
    const idToken = liff.getIDToken();
    const res = await fetch('/api/customer-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) return;
    const profile = await res.json();
    if (profile.name) document.getElementById('nameInput').value = profile.name;
    if (profile.phone) document.getElementById('phoneInput').value = profile.phone;
  } catch (err) {
    // 帶入失敗就算了，客人自己打一次也不影響預約，不用擋住流程
  }
}
async function loadIntakeQuestions() {
  try {
    const res = await fetch('/api/intake-questions', { cache: 'no-store' });
    state.intakeQuestions = await res.json();
  } catch (err) {
    state.intakeQuestions = [];
  }
  renderIntakeQuestions();
}

function renderIntakeQuestions() {
  const card = document.getElementById('intakeCard');
  const wrap = document.getElementById('intakeQuestions');
  if (!state.intakeQuestions.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  wrap.innerHTML = '';
  state.intakeQuestions.forEach((q) => {
    if (!state.intakeSelections[q.id]) state.intakeSelections[q.id] = new Set();
    const block = document.createElement('div');
    block.className = 'intake-q';
    block.innerHTML = `
      <div class="intake-q-title">${q.label}</div>
      <div class="intake-opts" data-question-id="${q.id}">
        ${q.options.map((o) => `<button type="button" class="intake-opt" data-label="${o.label}">${o.label}</button>`).join('')}
      </div>
      ${q.allow_other ? `<input type="text" class="intake-other-input" data-question-id="${q.id}" placeholder="補充說明（選填）">` : ''}
    `;
    wrap.appendChild(block);

    block.querySelectorAll('.intake-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const selections = state.intakeSelections[q.id];
        const label = btn.dataset.label;
        if (q.input_type === 'single') {
          selections.clear();
          block.querySelectorAll('.intake-opt').forEach((b) => b.classList.remove('selected'));
          selections.add(label);
          btn.classList.add('selected');
        } else {
          if (selections.has(label)) {
            selections.delete(label);
            btn.classList.remove('selected');
          } else {
            selections.add(label);
            btn.classList.add('selected');
          }
        }
      });
    });
  });
}

function collectIntakeAnswers() {
  return state.intakeQuestions
    .map((q) => {
      const selections = state.intakeSelections[q.id] || new Set();
      const otherInput = document.querySelector(`.intake-other-input[data-question-id="${q.id}"]`);
      const otherText = otherInput ? otherInput.value.trim() : '';
      return { questionId: q.id, selectedLabels: [...selections], otherText };
    })
    .filter((a) => a.selectedLabels.length || a.otherText);
}

async function loadServices() {
  const res = await fetch('/api/services', { cache: 'no-store' });
  const all = await res.json();
  // 升級體驗項目不能單獨預約，另外拉出來當「加選」用，主療程清單只留可以單獨預約的項目
  state.services = all.filter((s) => !s.is_addon);
  state.addons = all.filter((s) => s.is_addon);
  // 類別順序依「該類別裡排序值最小的療程」決定，不是依第一筆出現的順序，
  // 這樣老闆在後台調整項目的「排序」欄位，就能同時控制療程順序與類別順序
  // （例如基礎管理的項目給 10、一般管理給 20、高端管理給 30、特殊管理給 40）。
  const catMinOrder = new Map();
  state.services.forEach((s) => {
    const cat = s.category || '療程';
    const order = s.sort_order != null ? Number(s.sort_order) : Number.MAX_SAFE_INTEGER;
    if (!catMinOrder.has(cat) || order < catMinOrder.get(cat)) catMinOrder.set(cat, order);
  });
  state.categories = [...catMinOrder.keys()].sort((a, b) => catMinOrder.get(a) - catMinOrder.get(b));

  const params = new URLSearchParams(location.search);
  const preselectName = params.get('service');
  const preselect = preselectName && state.services.find((s) => s.name === preselectName);

  state.selectedCategory = preselect ? (preselect.category || '療程') : state.categories[0];
  renderCatTabs();
  renderServiceList();
  renderAddonList();

  if (preselect) {
    selectService(preselect);
    goToStep('time'); // 從 LINE 選好療程進來的，直接跳到選時間，不用再點一次「下一步」
  }
}

function renderCatTabs() {
  const wrap = document.getElementById('catTabs');
  wrap.innerHTML = '';
  state.categories.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cat-tab' + (cat === state.selectedCategory ? ' active' : '');
    btn.textContent = cat;
    btn.addEventListener('click', () => {
      state.selectedCategory = cat;
      renderCatTabs();
      renderServiceList();
    });
    wrap.appendChild(btn);
  });
}

function renderServiceList() {
  const list = document.getElementById('svcList');
  list.innerHTML = '';
  const items = state.services.filter((s) => (s.category || '療程') === state.selectedCategory);

  if (!items.length) {
    list.innerHTML = '<span class="empty">這個分類目前沒有項目</span>';
    return;
  }

  items.forEach((svc) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'svc-btn' + (state.selectedService && state.selectedService.id === svc.id ? ' selected' : '');
    // 項目說明（note）獨立一行顯示，像紙本價目表那樣列出療程內容，
    // 時長另外放在下面一行，兩者不再擠成同一串
    btn.innerHTML = `
      <div>
        <div class="name">${svc.name}</div>
        ${svc.note ? `<div class="desc">${svc.note}</div>` : ''}
        <div class="meta">約 ${svc.duration_minutes} 分鐘</div>
      </div>
      <div class="price">${formatPrice(svc.price)}</div>
    `;
    btn.addEventListener('click', () => selectService(svc));
    list.appendChild(btn);
  });
}

function selectService(svc) {
  state.selectedService = svc;
  renderServiceList();
  document.getElementById('addonCard').style.display = state.addons.length ? 'block' : 'none';
  document.getElementById('toStepTimeBtn').disabled = false;
}

function renderAddonList() {
  const list = document.getElementById('addonList');
  list.innerHTML = '';
  state.addons.forEach((addon) => {
    const item = document.createElement('div');
    item.className = 'addon-item' + (state.selectedAddonIds.has(addon.id) ? ' selected' : '');
    item.innerHTML = `
      <div class="check">✓</div>
      <div class="name">
        ${addon.name}
        ${addon.note ? `<div class="desc">${addon.note}</div>` : ''}
      </div>
      <div class="price">${formatPrice(addon.price)}</div>
    `;
    item.addEventListener('click', () => {
      if (state.selectedAddonIds.has(addon.id)) {
        state.selectedAddonIds.delete(addon.id);
      } else {
        state.selectedAddonIds.add(addon.id);
      }
      renderAddonList();
    });
    list.appendChild(item);
  });
}

function selectedAddons() {
  return state.addons.filter((a) => state.selectedAddonIds.has(a.id));
}

function totalPrice() {
  const base = state.selectedService ? Number(state.selectedService.price || 0) : 0;
  const addonsTotal = selectedAddons().reduce((sum, a) => sum + Number(a.price || 0), 0);
  return base + addonsTotal;
}

function bindStepNav() {
  document.getElementById('toStepTimeBtn').addEventListener('click', () => {
    if (!state.selectedService) return;
    goToStep('time');
  });
  document.getElementById('backToServiceBtn').addEventListener('click', () => {
    goToStep('service');
  });
  document.getElementById('toStepConfirmBtn').addEventListener('click', () => {
    if (!state.selectedDate || !state.selectedTime) return;
    goToStep('confirm');
  });
  document.getElementById('backToTimeBtn').addEventListener('click', () => {
    goToStep('time');
  });
}

const STEP_HINTS = {
  service: '先選擇想預約的療程，再選方便的時段',
  time: '選擇方便的時段',
  confirm: '確認預約內容並填寫聯絡資料',
  success: '',
};

function goToStep(step) {
  ['service', 'time', 'confirm', 'success'].forEach((s) => {
    document.getElementById(`step-${s}`).classList.toggle('active', s === step);
  });
  document.getElementById('stepHint').textContent = STEP_HINTS[step] || '';

  if (step === 'time') {
    const addons = selectedAddons();
    document.getElementById('pickedName').textContent = state.selectedService.name;
    document.getElementById('pickedAddons').textContent = addons.length
      ? `升級體驗：${addons.map((a) => a.name).join('、')}`
      : '';
    document.getElementById('pickedPrice').textContent = formatPrice(totalPrice());
  } else if (step === 'confirm') {
    renderConfirmSummary();
  }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function renderConfirmSummary() {
  const addons = selectedAddons();
  document.getElementById('sumService').textContent = state.selectedService.name;
  document.getElementById('sumAddonsRow').style.display = addons.length ? 'flex' : 'none';
  document.getElementById('sumAddons').textContent = addons.map((a) => a.name).join('、');
  document.getElementById('sumDate').textContent = state.selectedDate;
  document.getElementById('sumTime').textContent = state.selectedTime.slice(0, 5);
  document.getElementById('sumPrice').textContent = formatPrice(totalPrice());
}

// 客人目前最多能預約到哪一天，載入失敗就當作沒有限制（後端 createBooking 那邊還是會擋，不會真的超賣）
async function loadBookingWindow() {
  try {
    const res = await fetch('/api/booking-window', { cache: 'no-store' });
    const data = await res.json();
    state.openUntilDate = data.openUntilDate;
  } catch (err) {
    state.openUntilDate = null;
  }
}

function setupWeekNav() {
  const today = todayYmd();
  state.minWeekStart = mondayOf(today);
  state.weekStart = state.minWeekStart;

  document.getElementById('prevWeekBtn').addEventListener('click', () => {
    const prev = addDays(state.weekStart, -7);
    if (prev < state.minWeekStart) return; // 不能往回翻到本週以前
    state.weekStart = prev;
    state.selectedDate = null;
    state.selectedTime = null;
    updateSubmitState();
    loadWeek();
  });
  document.getElementById('nextWeekBtn').addEventListener('click', () => {
    state.weekStart = addDays(state.weekStart, 7);
    state.selectedDate = null;
    state.selectedTime = null;
    updateSubmitState();
    loadWeek();
  });

  loadWeek();
}

function formatRange(weekStart) {
  const end = addDays(weekStart, 6);
  const short = (d) => d.slice(5).replace('-', '/');
  return `${short(weekStart)} - ${short(end)}`;
}

async function loadWeek() {
  const grid = document.getElementById('weekGrid');
  grid.innerHTML = '載入中...';
  document.getElementById('weekRange').textContent = formatRange(state.weekStart);
  document.getElementById('prevWeekBtn').disabled = state.weekStart <= state.minWeekStart;
  // 下一週的週一如果已經超過目前開放的範圍，就不用再讓客人往後翻了
  const nextWeekBtn = document.getElementById('nextWeekBtn');
  nextWeekBtn.disabled = !!(state.openUntilDate && addDays(state.weekStart, 7) > state.openUntilDate);

  const res = await fetch(`/api/week?start=${state.weekStart}`, { cache: 'no-store' });
  const overview = await res.json();
  renderWeek(overview);
}

function renderWeek(overview) {
  const grid = document.getElementById('weekGrid');
  const dates = Object.keys(overview);
  const today = todayYmd();

  // 收集這一週所有出現過的時段（不同天開放的時段可能不完全一樣），統一排成列
  const times = [...new Set(dates.flatMap((d) => overview[d].slots.map((s) => s.startTime)))].sort();

  if (!times.length) {
    grid.innerHTML = '<span class="empty">這週沒有開放時段，請看下一週</span>';
    return;
  }

  grid.innerHTML = '';
  grid.style.gridTemplateRows = `auto repeat(${times.length}, auto)`;

  // 第一列：左上角空白 + 7 天的日期標題
  grid.appendChild(el('div', 'corner'));
  dates.forEach((date) => {
    const head = document.createElement('div');
    head.className = 'day-head' + (date === today ? ' today' : '');
    const offBadge = overview[date].isClosed ? '<div class="off-badge">公休</div>' : '';
    head.innerHTML = `<div class="dow">${overview[date].weekday}</div><div>${date.slice(5)}</div>${offBadge}`;
    grid.appendChild(head);
  });

  // 之後每一列：左邊時間標籤 + 7 天同一個時間的格子
  times.forEach((time) => {
    const timeHead = document.createElement('div');
    timeHead.className = 'time-head';
    timeHead.textContent = time.slice(0, 5);
    grid.appendChild(timeHead);

    dates.forEach((date) => {
      const slot = overview[date].slots.find((s) => s.startTime === time);
      if (!slot) {
        grid.appendChild(el('div', 'slot-btn slot-empty'));
        return;
      }
      const btn = document.createElement('button');
      btn.className = 'slot-btn';
      btn.textContent = '可約';
      // 本週一定包含「今天以前」的日子（例如今天是週日，週一~週六都已經過去了），
      // 不能只判斷「今天」的時間有沒有過，整天都已經過去的日期也要一併鎖住
      const isPast = date < today || (date === today && isPastTime(time));
      const isBeyondOpenWindow = state.openUntilDate && date > state.openUntilDate;
      if (slot.status === 'booked' || isPast || isBeyondOpenWindow) {
        btn.disabled = true;
        btn.textContent = isBeyondOpenWindow ? '未開放' : (slot.status === 'booked' ? '已滿' : '－');
      } else {
        if (date === state.selectedDate && time === state.selectedTime) {
          btn.classList.add('selected');
          btn.textContent = time.slice(0, 5);
        }
        btn.addEventListener('click', () => {
          state.selectedDate = date;
          state.selectedTime = time;
          document.querySelectorAll('.slot-btn').forEach((b) => {
            b.classList.remove('selected');
            if (!b.disabled && b.textContent !== '可約') b.textContent = '可約';
          });
          btn.classList.add('selected');
          btn.textContent = time.slice(0, 5);
          updateSubmitState();
        });
      }
      grid.appendChild(btn);
    });
  });
}

function isPastTime(startTime) {
  const now = new Date();
  const [h, m] = startTime.split(':').map(Number);
  return h < now.getHours() || (h === now.getHours() && m <= now.getMinutes());
}

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function updateSubmitState() {
  const ready = state.selectedService && state.selectedDate && state.selectedTime;
  document.getElementById('toStepConfirmBtn').disabled = !ready;
}

function bindSubmit() {
  document.getElementById('submitBtn').addEventListener('click', submitBooking);
  document.getElementById('addToCalendarBtn').addEventListener('click', addLastBookingToCalendar);
  document.getElementById('viewMyBookingsBtn').addEventListener('click', () => {
    location.href = './bookings.html';
  });
}

async function submitBooking() {
  const name = document.getElementById('nameInput').value.trim();
  const phone = document.getElementById('phoneInput').value.trim();
  const note = document.getElementById('noteInput').value.trim();
  const resultEl = document.getElementById('resultMsg');
  const submitBtn = document.getElementById('submitBtn');

  if (!name || !phone) {
    resultEl.innerHTML = '<div class="msg error">請填寫姓名與聯絡電話</div>';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = '送出中...';

  try {
    const idToken = liff.getIDToken();
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idToken,
        name,
        phone,
        serviceId: state.selectedService.id,
        date: state.selectedDate,
        startTime: state.selectedTime,
        addonServiceIds: [...state.selectedAddonIds],
        note,
        intakeAnswers: collectIntakeAnswers(),
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.code === 'TOKEN_EXPIRED') {
        // 頁面開太久，LINE 的登入憑證過期了，重新整理頁面會拿到新的憑證，直接引導客人重整比較不會卡住
        resultEl.innerHTML = `
          <div class="msg error">頁面開太久了，請重新整理頁面後再預約一次</div>
          <button type="button" class="btn-primary" id="reloadBtn" style="margin-top:8px;">重新整理頁面</button>
        `;
        document.getElementById('reloadBtn').addEventListener('click', () => location.reload());
        submitBtn.disabled = false;
        submitBtn.textContent = '確認預約';
        return;
      }
      resultEl.innerHTML = `<div class="msg error">${data.error || '預約失敗，請稍後再試'}</div>`;
      if (data.code === 'SLOT_TAKEN') {
        state.selectedDate = null;
        state.selectedTime = null;
        updateSubmitState();
        goToStep('time');
        await loadWeek(); // 時段被搶走了，重新整理這週的時段狀態
      }
      submitBtn.disabled = false;
      submitBtn.textContent = '確認預約';
      return;
    }

    state.lastBooking = data.summary; // 給「加入我的行事曆」按鈕用
    document.getElementById('successDetail').innerHTML = `
      ${data.summary.serviceName}${data.summary.addons.length ? `（升級體驗：${data.summary.addons.join('、')}）` : ''}<br>
      ${data.summary.date}　${data.summary.startTime.slice(0, 5)}<br>
      詳細資訊已透過 LINE 通知您囉
    `;
    submitBtn.textContent = '確認預約';
    submitBtn.disabled = false;
    resultEl.innerHTML = '';
    goToStep('success');
  } catch (err) {
    resultEl.innerHTML = '<div class="msg error">發生錯誤，請稍後再試一次</div>';
    submitBtn.disabled = false;
    submitBtn.textContent = '確認預約';
  }
}

// 「加入我的行事曆」：不用串金流/OAuth，直接組一個 Google 日曆的新增活動連結，
// 讓客人自己的手機（不管是不是 LINE 內建瀏覽器）跳出來確認加入，最簡單、相容性也最好。
function addLastBookingToCalendar() {
  const booking = state.lastBooking;
  if (!booking) return;

  const [y, m, d] = booking.date.split('-').map(Number);
  const [h, min] = booking.startTime.split(':').map(Number);
  // 預約時間是台北時間（UTC+8），Google 日曆連結的 dates 參數要用 UTC，所以要減 8 小時
  const startUtc = new Date(Date.UTC(y, m - 1, d, h - 8, min));
  const endUtc = new Date(startUtc.getTime() + (booking.durationMinutes || 60) * 60000);
  const fmt = (dt) => dt.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

  const title = encodeURIComponent(`妍序 Skin｜${booking.serviceName}`);
  const details = encodeURIComponent(
    booking.addons && booking.addons.length ? `升級體驗：${booking.addons.join('、')}` : ''
  );
  const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${fmt(startUtc)}/${fmt(endUtc)}&details=${details}`;
  window.open(url, '_blank');
}

init().catch((err) => {
  document.getElementById('resultMsg').innerHTML =
    `<div class="msg error">頁面初始化失敗：${err.message}</div>`;
});
