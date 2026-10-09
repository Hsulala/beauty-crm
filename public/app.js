const STATUS_LABEL = { building: '建置中', running: '運作中', paused: '暫停', ended: '已結束' };
const SYSTEM_LABEL = { heyu: '禾域 HEYU（按摩）', skin: '妍序 Skin（皮膚管理）', other: '其他系統' };
const FIELD_LABEL = {
  name: '店名', system_type: '系統', url: '網址', status: '狀態', monthly_fee: '月費',
  contract_start: '合約起日', contract_end: '合約到期日', notes: '備註',
};
const ACTION_LABEL = { 'store.create': '新增', 'store.update': '修改', 'store.delete': '刪除', 'store.remote_keys': '連線金鑰', 'store.modules': '功能模組' };
const REMOTE_SYSTEMS = ['heyu', 'skin'];

const money = (value) => `NT$${Number(value).toLocaleString('zh-TW')}`;
const $ = (selector) => document.querySelector(selector);

// 一律用 textContent 寫入文字，備註等自由輸入不會被當成 HTML 執行。
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) { location.href = '/login.html'; throw new Error('unauthorized'); }
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

const state = { stores: [], summary: null, audit: [], filter: 'all' };

// ---------- 畫面 ----------
function contractText(store) {
  const { state: kind, daysLeft } = store.contract;
  if (kind === 'none') return '未設定到期日';
  if (kind === 'ended') return `合約至 ${store.contract_end}（已結束）`;
  if (kind === 'expired') return `已過期 ${Math.abs(daysLeft)} 日（${store.contract_end}）`;
  if (kind === 'soon') return daysLeft === 0 ? `今天到期（${store.contract_end}）` : `${daysLeft} 日後到期（${store.contract_end}）`;
  return `至 ${store.contract_end}，剩 ${daysLeft} 日`;
}

function renderSummary() {
  const box = $('#summary');
  box.replaceChildren();
  const { summary } = state;
  if (!summary) return;
  const stat = (label, value, hint, tone) => h('div', { class: `stat${tone ? ` is-${tone}` : ''}` },
    h('dt', {}, label), h('dd', {}, value), hint && h('p', { class: 'hint' }, hint));
  box.append(h('dl', { class: 'stats' },
    stat('運作中', `${summary.counts.running} 家`, `共 ${summary.counts.total} 家，建置中 ${summary.counts.building}、暫停 ${summary.counts.paused}、已結束 ${summary.counts.ended}`),
    stat('每月經常性收入', money(summary.mrr), '只計運作中的店家'),
    stat('30 日內到期', `${summary.expiringSoon} 家`, '不含已結束的店家', summary.expiringSoon ? 'warn' : ''),
    stat('合約已過期', `${summary.expired} 家`, '請確認是否續約或改為已結束', summary.expired ? 'danger' : ''),
  ));
}

function renderAttention() {
  const box = $('#attention');
  box.replaceChildren();
  const items = state.summary?.attention ?? [];
  box.hidden = items.length === 0;
  if (!items.length) return;
  box.append(h('h2', {}, '需要處理的合約'), h('ul', {}, items.map((item) => {
    const text = item.state === 'expired' ? `已過期 ${Math.abs(item.daysLeft)} 日` : item.daysLeft === 0 ? '今天到期' : `${item.daysLeft} 日後到期`;
    return h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => openDialog(state.stores.find((s) => s.id === item.id)) }, item.name), h('span', { class: `tag is-${item.state}` }, text));
  })));
}

function renderList() {
  const box = $('#list');
  box.replaceChildren();
  const visible = state.stores.filter((store) => state.filter === 'all' || store.status === state.filter);
  if (!visible.length) {
    box.append(h('p', { class: 'empty' }, state.stores.length ? '這個狀態目前沒有店家。' : '尚未登錄店家。按右上角「新增店家」開始。'));
    return;
  }
  for (const store of visible) {
    const { progress, state: kind } = store.contract;
    const fill = h('span', { class: `bar-fill is-${kind}` });
    if (progress !== null) fill.style.width = `${Math.round(progress * 100)}%`;
    box.append(h('article', { class: `store status-${store.status}` },
      h('div', { class: 'store-main' },
        h('h2', {}, store.name),
        h('p', { class: 'muted' }, SYSTEM_LABEL[store.system_type] ?? store.system_type),
        store.notes && h('p', { class: 'notes' }, store.notes)),
      h('div', { class: 'store-status' }, h('span', { class: `badge is-${store.status}` }, STATUS_LABEL[store.status])),
      h('div', { class: 'store-fee' },
        h('span', { class: 'fee' }, store.monthly_fee ? `${money(store.monthly_fee)} /月` : '未設定月費'),
        store.monthly_fee > 0 && store.status !== 'running' && h('span', { class: 'hint' }, '未計入收入')),
      h('div', { class: 'store-contract' },
        progress !== null && h('div', { class: 'bar', 'aria-hidden': 'true' }, fill),
        h('p', { class: `contract-text is-${kind}` }, contractText(store))),
      h('div', { class: 'store-url' }, store.url ? h('a', { href: store.url, target: '_blank', rel: 'noopener noreferrer' }, store.url.replace(/^https?:\/\//, '')) : h('span', { class: 'muted' }, '未填網址')),
      h('div', { class: 'store-actions' },
        REMOTE_SYSTEMS.includes(store.system_type) && h('button', { type: 'button', class: 'btn quiet', onclick: () => openRemote(store) }, '店家頁'),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => openDialog(store) }, '編輯')),
    ));
  }
}

function formatValue(key, value) {
  if (value === null || value === '' || value === undefined) return '（空）';
  if (key === 'status') return STATUS_LABEL[value] ?? value;
  if (key === 'system_type') return SYSTEM_LABEL[value] ?? value;
  if (key === 'monthly_fee') return money(value);
  if (key === 'notes') return '（內容已更新）';
  return String(value);
}

function renderAudit() {
  const list = $('#audit-list');
  list.replaceChildren();
  if (!state.audit.length) { list.append(h('li', { class: 'muted' }, '還沒有紀錄')); return; }
  for (const entry of state.audit) {
    const time = new Date(entry.at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    let detail = '';
    if (entry.action === 'store.update') {
      detail = Object.entries(entry.detail.changes ?? {}).map(([key, change]) =>
        key === 'notes' ? '備註已更新' : `${FIELD_LABEL[key] ?? key}：${formatValue(key, change.from)} → ${formatValue(key, change.to)}`).join('；');
    }
    if (entry.action === 'store.remote_keys') {
      const verb = { set: '已設定', cleared: '已清除' };
      detail = [['read', '讀取金鑰'], ['write', '寫入金鑰']].filter(([key]) => entry.detail?.[key]).map(([key, label]) => `${label}${verb[entry.detail[key]] ?? ''}`).join('；');
    }
    if (entry.action === 'store.modules') {
      detail = Object.values(entry.detail?.changes ?? {}).map((change) => `${change.label}：${change.from ? '開' : '關'} → ${change.to ? '開' : '關'}`).join('；');
    }
    list.append(h('li', {}, h('time', {}, time), h('strong', {}, `${ACTION_LABEL[entry.action] ?? entry.action}　${entry.store_name}`), detail && h('span', { class: 'muted' }, detail)));
  }
}

function renderAll() { renderSummary(); renderAttention(); renderList(); renderAudit(); }

async function load() {
  const [stores, summary, audit] = await Promise.all([api('/api/stores'), api('/api/summary'), api('/api/audit?limit=30')]);
  state.stores = stores.data.stores ?? [];
  state.summary = summary.data;
  state.audit = audit.data.entries ?? [];
  renderAll();
}

// ---------- 新增 / 編輯 ----------
const dialog = $('#store-dialog');
const form = $('#store-form');
let editing = null;

function showErrors(fields = {}, general = '') {
  for (const node of form.querySelectorAll('[data-error]')) {
    const message = fields[node.dataset.error];
    node.textContent = message ?? '';
    node.hidden = !message;
  }
  const box = $('#form-error');
  const unmatched = Object.entries(fields).filter(([key]) => !form.querySelector(`[data-error="${key}"]`)).map(([, message]) => message);
  box.textContent = [general, ...unmatched].filter(Boolean).join('；');
  box.hidden = !box.textContent;
}

function openDialog(store) {
  editing = store ?? null;
  $('#dialog-title').textContent = store ? `編輯：${store.name}` : '新增店家';
  $('#delete-btn').hidden = !store;
  const values = store ?? { name: '', system_type: 'other', status: 'building', monthly_fee: 0, url: '', contract_start: '', contract_end: '', notes: '' };
  for (const key of Object.keys(FIELD_LABEL)) form.elements[key].value = values[key] ?? '';
  showErrors();
  dialog.showModal();
  form.elements.name.focus();
}

function readForm() {
  const raw = Object.fromEntries(Object.keys(FIELD_LABEL).map((key) => [key, form.elements[key].value]));
  return {
    name: raw.name.trim(), system_type: raw.system_type, status: raw.status,
    monthly_fee: raw.monthly_fee === '' ? 0 : Number(raw.monthly_fee),
    url: raw.url.trim(), contract_start: raw.contract_start || null, contract_end: raw.contract_end || null, notes: raw.notes,
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readForm();
  let result;
  if (editing) {
    // 只送出有改的欄位，沒動到的欄位維持伺服器上的值。
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== editing[key]));
    if (!Object.keys(changed).length) { dialog.close(); return; }
    result = await api(`/api/stores/${editing.id}`, { method: 'PATCH', body: changed });
  } else {
    result = await api('/api/stores', { method: 'POST', body: values });
  }
  if (!result.ok) { showErrors(result.data.fields, result.data.fields ? '' : result.data.error); return; }
  dialog.close();
  await load();
});

$('#cancel-btn').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

$('#delete-btn').addEventListener('click', async () => {
  if (!editing) return;
  if (!confirm(`確定刪除「${editing.name}」？此動作無法復原（異動紀錄會保留）。`)) return;
  const result = await api(`/api/stores/${editing.id}`, { method: 'DELETE' });
  if (!result.ok) { showErrors({}, result.data.error); return; }
  dialog.close();
  await load();
});


// ---------- 店家頁：本月預約數、功能模組、連線金鑰 ----------
const remoteDialog = $('#remote-dialog');
const remote = { store: null, month: '', overview: null, status: null, seq: 0 };
const remoteUrl = (path = '') => `/api/stores/${remote.store.id}/remote${path}`;
const showMessage = (selector, text) => { const node = $(selector); node.textContent = text ?? ''; node.hidden = !text; };
const errorText = (result) => (result.data.fields ? Object.values(result.data.fields).join('、') : result.data.error) || '操作失敗，請稍後再試';

async function openRemote(store) {
  remote.store = store; remote.month = ''; remote.overview = null; remote.status = null; remote.seq += 1;
  $('#remote-title').textContent = `店家頁：${store.name}`;
  $('#remote-sub').textContent = SYSTEM_LABEL[store.system_type] ?? '';
  for (const id of ['#remote-read-key', '#remote-write-key']) $(id).value = '';
  for (const id of ['#remote-modules-error', '#remote-modules-ok', '#remote-keys-error']) showMessage(id, '');
  $('#remote-stats').replaceChildren(h('p', { class: 'muted' }, '讀取中…'));
  $('#remote-modules').replaceChildren();
  $('#remote-modules-save').disabled = true;
  remoteDialog.showModal();
  await loadRemoteStatus();
  await loadOverview();
}

async function loadRemoteStatus() {
  const token = remote.seq;
  const result = await api(remoteUrl());
  if (token !== remote.seq) return;
  remote.status = result.ok ? result.data : null;
  renderKeys();
}

function renderKeys() {
  const status = remote.status ?? {};
  $('#remote-unavailable').hidden = status.available !== false;
  for (const [kind, flag] of [['read', status.has_read_key], ['write', status.has_write_key]]) {
    const node = $(`#remote-${kind}-state`);
    node.textContent = flag ? '已設定' : '未設定';
    node.classList.toggle('is-set', Boolean(flag));
    $(`#remote-clear-${kind}`).hidden = !flag;
  }
}

async function loadOverview() {
  const token = remote.seq;
  $('#remote-stats').replaceChildren(h('p', { class: 'muted' }, '讀取中…'));
  const result = await api(remoteUrl(`/overview${remote.month ? `?month=${remote.month}` : ''}`));
  if (token !== remote.seq) return;
  if (!result.ok) {
    remote.overview = null;
    $('#remote-stats').replaceChildren(h('p', { class: 'field-error' }, result.data.error ?? '讀取失敗'));
    $('#remote-modules').replaceChildren();
    $('#remote-modules-save').disabled = true;
    return;
  }
  remote.overview = result.data;
  remote.month = result.data.month;
  $('#remote-month').value = result.data.month;
  renderStats();
  renderModules();
}

function renderStats() {
  const box = $('#remote-stats');
  const { stats, month } = remote.overview;
  if (!stats.ok) { box.replaceChildren(h('p', { class: 'field-error' }, stats.error)); return; }
  const { total, cancelled } = stats.data.bookings;
  box.replaceChildren(h('div', { class: 'remote-number' },
    h('strong', {}, `${total} 筆`),
    h('span', { class: 'muted' }, `${month} 預約數`),
    h('span', { class: 'hint' }, `另有已取消 ${cancelled} 筆（不計入）`)));
}

function renderModules() {
  const box = $('#remote-modules');
  const { config, can_edit: canEdit } = remote.overview;
  box.replaceChildren();
  showMessage('#remote-modules-error', '');
  showMessage('#remote-modules-ok', '');
  if (!config.ok) {
    box.append(h('p', { class: 'field-error' }, config.error));
    $('#remote-modules-save').disabled = true;
    return;
  }
  for (const [key, mod] of Object.entries(config.data.modules)) {
    const input = h('input', { type: 'checkbox', 'data-module': key, disabled: !canEdit });
    input.checked = mod.enabled;
    box.append(h('label', { class: `module-row${canEdit ? '' : ' is-locked'}` }, input, h('span', {}, mod.label)));
  }
  if (!canEdit) box.append(h('p', { class: 'hint' }, '還沒設定寫入金鑰，目前只能查看。'));
  $('#remote-modules-save').disabled = !canEdit;
}

$('#remote-modules-save').addEventListener('click', async () => {
  if (!remote.overview?.config.ok) return;
  const current = remote.overview.config.data.modules;
  // 只送出有變動的模組，沒動到的維持店家系統上的狀態。
  const modules = {};
  for (const box of document.querySelectorAll('#remote-modules input[data-module]')) {
    if (box.checked !== current[box.dataset.module].enabled) modules[box.dataset.module] = box.checked;
  }
  showMessage('#remote-modules-error', ''); showMessage('#remote-modules-ok', '');
  if (!Object.keys(modules).length) { showMessage('#remote-modules-ok', '沒有變更'); return; }
  const button = $('#remote-modules-save');
  button.disabled = true;
  const result = await api(remoteUrl('/modules'), { method: 'PUT', body: { modules } });
  if (!result.ok) { showMessage('#remote-modules-error', errorText(result)); button.disabled = false; return; }
  await loadOverview();
  await refreshAudit();
  showMessage('#remote-modules-ok', result.data.changed ? '已儲存，店家系統已套用' : '沒有變更');
});

$('#remote-keys-save').addEventListener('click', async () => {
  const body = {};
  const read = $('#remote-read-key').value.trim(), write = $('#remote-write-key').value.trim();
  if (read) body.read_key = read;
  if (write) body.write_key = write;
  showMessage('#remote-keys-error', '');
  if (!Object.keys(body).length) { showMessage('#remote-keys-error', '請輸入要儲存的金鑰'); return; }
  const result = await api(remoteUrl(), { method: 'PUT', body });
  if (!result.ok) { showMessage('#remote-keys-error', errorText(result)); return; }
  $('#remote-read-key').value = ''; $('#remote-write-key').value = '';
  await loadRemoteStatus();
  await loadOverview();
  await refreshAudit();
});

for (const kind of ['read', 'write']) {
  $(`#remote-clear-${kind}`).addEventListener('click', async () => {
    const label = kind === 'read' ? '讀取' : '寫入';
    if (!confirm(`確定清除「${remote.store.name}」的${label}金鑰？清除後需要重新輸入才能連線。`)) return;
    showMessage('#remote-keys-error', '');
    const result = await api(remoteUrl(), { method: 'PUT', body: { [`${kind}_key`]: null } });
    if (!result.ok) { showMessage('#remote-keys-error', errorText(result)); return; }
    await loadRemoteStatus();
    await loadOverview();
    await refreshAudit();
  });
}

$('#remote-month').addEventListener('change', (event) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) return;
  remote.month = event.target.value;
  loadOverview();
});
$('#remote-close').addEventListener('click', () => { remote.seq += 1; remoteDialog.close(); });
remoteDialog.addEventListener('click', (event) => { if (event.target === remoteDialog) { remote.seq += 1; remoteDialog.close(); } });
remoteDialog.addEventListener('close', () => { remote.seq += 1; });

async function refreshAudit() {
  const audit = await api('/api/audit?limit=30');
  state.audit = audit.data.entries ?? [];
  renderAudit();
}

$('#add-btn').addEventListener('click', () => openDialog(null));
$('#logout-btn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login.html'; });

for (const button of document.querySelectorAll('.filter')) {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    for (const other of document.querySelectorAll('.filter')) other.classList.toggle('is-active', other === button);
    renderList();
  });
}

load().catch((error) => { if (error.message !== 'unauthorized') $('#list').replaceChildren(h('p', { class: 'empty' }, '載入失敗，請重新整理頁面。')); });
