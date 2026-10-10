const STATUS_LABEL = { building: '建置中', running: '運作中', paused: '暫停', ended: '已結束' };
// 舊版把店名當類型存（heyu、skin）；異動紀錄裡可能還看得到，讓它們顯示得出來。
const LEGACY_TYPE_LABEL = { heyu: '禾域 HEYU', skin: '妍序 Skin' };
const TYPE_FIELD_LABEL = { label: '名稱', description: '說明', repo: '程式 repo', remote_supported: '遠端管理', sort_order: '排序' };
const FIELD_LABEL = {
  name: '店名', system_type: '系統', url: '網址', status: '狀態', monthly_fee: '月費',
  contract_start: '合約起日', contract_end: '合約到期日', notes: '備註',
};
const ACTION_LABEL = {
  'store.icon': '顧客頁面 Logo', 'store.create': '新增', 'store.update': '修改', 'store.delete': '刪除', 'store.remote_keys': '連線金鑰', 'store.modules': '功能模組',
  'type.create': '新增類型', 'type.update': '修改類型', 'type.delete': '刪除類型',
  'links.import': '匯入連結',
};
const LINK_STATUS_LABEL = { active: '正常', pending: '待處理', hidden: '隱藏' };

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

const state = {
  stores: [], types: [], links: [], summary: null, audit: [], filter: 'all', view: 'stores',
  linkFilter: 'all', linkCategory: 'all', linkQuery: '', linkStore: null,
};

const typeOf = (key) => state.types.find((type) => type.key === key);
const typeLabel = (key) => typeOf(key)?.label ?? LEGACY_TYPE_LABEL[key] ?? key;
const remoteSupported = (store) => Boolean(typeOf(store.system_type)?.remote_supported);

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
        h('div', { class: 'store-text' },
          h('h2', {}, store.name),
          h('p', { class: 'muted' }, typeLabel(store.system_type)),
          store.notes && h('p', { class: 'notes' }, store.notes))),
      h('div', { class: 'store-status' }, h('span', { class: `badge is-${store.status}` }, STATUS_LABEL[store.status])),
      h('div', { class: 'store-fee' },
        h('span', { class: 'fee' }, store.monthly_fee ? `${money(store.monthly_fee)} /月` : '未設定月費'),
        store.monthly_fee > 0 && store.status !== 'running' && h('span', { class: 'hint' }, '未計入收入')),
      h('div', { class: 'store-contract' },
        progress !== null && h('div', { class: 'bar', 'aria-hidden': 'true' }, fill),
        h('p', { class: `contract-text is-${kind}` }, contractText(store))),
      h('div', { class: 'store-url' }, store.url ? h('a', { href: store.url, target: '_blank', rel: 'noopener noreferrer' }, store.url.replace(/^https?:\/\//, '')) : h('span', { class: 'muted' }, '未填網址')),
      h('div', { class: 'store-actions' },
        remoteSupported(store) && h('button', { type: 'button', class: 'btn quiet', onclick: () => openRemote(store) }, '店家頁'),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => openDialog(store) }, '編輯')),
    ));
  }
}

function formatValue(key, value) {
  if (value === null || value === '' || value === undefined) return '（空）';
  if (key === 'status') return STATUS_LABEL[value] ?? value;
  if (key === 'system_type') return typeLabel(value);
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
    if (entry.action === 'links.import') {
      const d = entry.detail ?? {};
      detail = `新增 ${d.imported ?? 0} 筆，略過重複 ${d.duplicates ?? 0} 筆，無法匯入 ${d.invalid ?? 0} 筆`;
    }
    if (entry.action === 'type.update') {
      detail = Object.entries(entry.detail.changes ?? {}).map(([key, change]) => {
        if (key === 'description') return '說明已更新';
        if (key === 'remote_supported') return `遠端管理：${change.from ? '支援' : '不支援'} → ${change.to ? '支援' : '不支援'}`;
        return `${TYPE_FIELD_LABEL[key] ?? key}：${change.from === '' ? '（空）' : change.from} → ${change.to === '' ? '（空）' : change.to}`;
      }).join('；');
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

// ---------- 系統類型 ----------
function renderTypes() {
  const box = $('#type-list');
  box.replaceChildren();
  if (!state.types.length) { box.append(h('p', { class: 'empty' }, '還沒有系統類型。按右上角「新增類型」開始。')); return; }
  for (const type of state.types) {
    box.append(h('article', { class: 'type-card' },
      h('div', { class: 'type-head' },
        h('h2', {}, type.label),
        h('code', { class: 'type-key' }, type.key),
        h('span', { class: `badge ${type.remote_supported ? 'is-running' : ''}` }, type.remote_supported ? '支援遠端管理' : '未接遠端管理'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => openTypeDialog(type) }, '編輯')),
      type.description && h('p', { class: 'type-desc' }, type.description),
      type.repo && h('p', { class: 'muted' }, `程式 repo：${type.repo}`),
      h('div', { class: 'type-stores' },
        h('span', { class: 'type-count' }, `${type.store_count} 家店`),
        type.stores.map((store) => h('button', {
          type: 'button', class: `chip status-${store.status}`, title: '編輯這家店',
          onclick: () => openDialog(state.stores.find((s) => s.id === store.id)),
        }, store.name)),
        !type.store_count && h('span', { class: 'muted' }, '目前沒有店家使用這個類型'))));
  }
}

function fillTypeSelect(selected) {
  const select = $('#f-system_type');
  select.replaceChildren(...state.types.map((type) => h('option', { value: type.key }, type.label)));
  // 舊紀錄的類型若已不存在，仍保留原值避免被誤改。
  if (selected && !typeOf(selected)) select.append(h('option', { value: selected }, `${typeLabel(selected)}（已不存在）`));
  select.value = selected ?? 'other';
}

// ---------- 連結 ----------
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };

const storeName = (id) => state.stores.find((store) => store.id === id)?.name ?? '';

// 常用工具預設列出全部連結；可再用店家、分類、狀態與搜尋縮小範圍。
function visibleLinks() {
  const query = state.linkQuery.trim().toLowerCase();
  return state.links.filter((link) => {
    if (state.linkStore != null) { if (link.store_id !== state.linkStore) return false; }
    if (state.linkCategory !== 'all' && (link.category || '') !== state.linkCategory) return false;
    if (state.linkFilter !== 'all' && link.status !== state.linkFilter) return false;
    if (!query) return true;
    return [link.title, link.label, link.tags, link.category, link.description, storeName(link.store_id)].some((text) => text.toLowerCase().includes(query));
  });
}

function renderCategoryFilters() {
  const box = $('#link-category-filters');
  const categories = [...new Set(state.links.map((link) => link.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (state.linkCategory !== 'all' && !categories.includes(state.linkCategory)) state.linkCategory = 'all';
  box.replaceChildren(
    h('button', { type: 'button', class: `link-filter${state.linkCategory === 'all' ? ' is-active' : ''}`, onclick: () => { state.linkCategory = 'all'; renderLinks(); } }, '所有分類'),
    ...categories.map((category) => h('button', { type: 'button', class: `link-filter${state.linkCategory === category ? ' is-active' : ''}`, onclick: () => { state.linkCategory = category; renderLinks(); } }, category)),
  );
}

function renderLinkScope() {
  const box = $('#link-scope');
  box.replaceChildren();
  box.hidden = state.linkStore == null;
  $('#links-hint').hidden = state.linkStore != null;
  if (state.linkStore == null) return;
  box.append(
    h('span', {}, `店家連結：${storeName(state.linkStore)}`),
    h('button', { type: 'button', class: 'btn quiet', onclick: () => { state.linkStore = null; renderLinks(); } }, '回到常用工具'));
}

// 釘選的排最前面，其餘依分類分組；同分類、同名稱的連結合成一張卡。
async function setPinned(card, pinned) {
  const results = await Promise.all(card.links.filter((link) => link.pinned !== pinned).map((link) => api(`/api/links/${link.id}`, { method: 'PATCH', body: { pinned } })));
  const bad = results.find((result) => !result.ok);
  showLinksNote('#links-error', bad ? (bad.data.error ?? '操作失敗，請稍後再試') : '');
  await load();
}

function renderLinks() {
  const box = $('#link-list');
  box.replaceChildren();
  renderLinkScope();
  renderCategoryFilters();
  const shown = visibleLinks();
  if (!shown.length) {
    const none = state.linkStore != null ? '這家店還沒有連結。按右上角「新增連結」。'
      : state.links.length ? '沒有符合條件的連結。' : '還沒有連結。按右上角「新增連結」，或到頁面最下面從 Linkbase 匯入舊資料。';
    box.append(h('p', { class: 'empty' }, none));
    return;
  }
  const cards = new Map();
  for (const link of shown) {
    const key = `${link.category}\u0000${link.title}`;
    if (!cards.has(key)) cards.set(key, { category: link.category, title: link.title, links: [] });
    cards.get(key).links.push(link);
  }
  const sections = new Map();
  const place = (name, card) => { if (!sections.has(name)) sections.set(name, []); sections.get(name).push(card); };
  for (const card of cards.values()) place(card.links.some((link) => link.pinned) ? '釘選' : (card.category || '未分類'), card);
  const names = [...sections.keys()].sort((a, b) => (a === '釘選' ? -1 : b === '釘選' ? 1 : a === '未分類' ? 1 : b === '未分類' ? -1 : a.localeCompare(b, 'zh-Hant')));
  for (const name of names) {
    box.append(h('h2', { class: 'link-section' }, name), h('div', { class: 'link-cards' }, sections.get(name).map((card) => linkCard(card, name))));
  }
}

// 只有一個連結：項目名稱本身就能開啟，不另外放按鈕。有多個連結：每個連結一顆黑框按鈕。
function linkCard(card, sectionName) {
  const first = card.links[0];
  const many = card.links.length > 1;
  const pinned = card.links.every((link) => link.pinned);
  const owner = state.linkStore == null ? storeName(first.store_id) : '';
  const open = (link) => ({ href: link.url, target: '_blank', rel: 'noopener noreferrer', title: hostOf(link.url) });
  return h('article', { class: `link-card status-${first.status}` },
    h('div', { class: 'link-head' },
      h('h3', {}, many ? card.title : h('a', { class: 'card-title-link', ...open(first) }, card.title)),
      first.status !== 'active' && h('span', { class: `badge ${first.status === 'pending' ? 'is-building' : 'is-paused'}` }, LINK_STATUS_LABEL[first.status])),
    (owner || (sectionName === '釘選' && card.category)) && h('div', { class: 'link-meta' },
      owner && h('span', { class: 'chip-static' }, owner),
      sectionName === '釘選' && card.category && h('span', { class: 'chip-static' }, card.category)),
    first.description && h('p', { class: 'muted' }, first.description),
    first.tags && h('p', { class: 'hint' }, `標籤：${first.tags}`),
    many && h('ul', { class: 'link-urls' }, card.links.map((link) => h('li', {},
      h('a', { class: 'quick-link', ...open(link) }, link.label || hostOf(link.url)),
      h('button', { type: 'button', class: 'link-tool', onclick: () => openLinkDialog(link) }, '編輯')))),
    first.note && h('p', { class: 'notes' }, first.note),
    // 次要操作統一放在卡片底部：釘選；只有一個連結時也在這裡編輯。
    h('div', { class: 'link-foot' },
      h('button', { type: 'button', class: 'link-tool', onclick: () => setPinned(card, !pinned) }, pinned ? '取消釘選' : '釘選'),
      !many && h('button', { type: 'button', class: 'link-tool', onclick: () => openLinkDialog(first) }, '編輯')));
}

const linkDialog = $('#link-dialog');
const linkForm = $('#link-form');
let editingLink = null;

function showLinkErrors(fields = {}, general = '') {
  for (const node of linkForm.querySelectorAll('[data-error]')) {
    const message = fields[node.dataset.error];
    node.textContent = message ?? '';
    node.hidden = !message;
  }
  const box = $('#link-form-error');
  const unmatched = Object.entries(fields).filter(([key]) => !linkForm.querySelector(`[data-error="${key}"]`)).map(([, message]) => message);
  box.textContent = [general, ...unmatched].filter(Boolean).join('；');
  box.hidden = !box.textContent;
}

function openLinkDialog(link) {
  editingLink = link ?? null;
  $('#link-dialog-title').textContent = link ? `編輯連結：${link.title}` : '新增連結';
  // 從店家的連結清單按「新增連結」時，預設掛在那家店底下。
  const values = link ?? { title: '', label: '', url: '', category: '', description: '', tags: '', note: '', status: 'active', pinned: false, store_id: state.linkStore };
  const f = linkForm.elements;
  for (const key of ['title', 'label', 'url', 'description', 'tags', 'note', 'status']) f[key].value = values[key];
  f.pinned.checked = values.pinned;
  f.store_id.replaceChildren(h('option', { value: '' }, '（不屬於任何店家）'), ...state.stores.map((store) => h('option', { value: String(store.id) }, store.name)));
  f.store_id.value = values.store_id == null ? '' : String(values.store_id);
  const categories = [...new Set(state.links.map((item) => item.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (values.category && !categories.includes(values.category)) categories.push(values.category);
  f.category.replaceChildren(h('option', { value: '' }, '未分類'), ...categories.map((name) => h('option', { value: name }, name)), h('option', { value: '__new__' }, '新增分類…'));
  f.category.value = values.category || '';
  $('#l-category-new').value = '';
  $('#l-category-new').hidden = true;
  $('#link-delete-btn').hidden = !link;
  showLinkErrors();
  linkDialog.showModal();
  f.title.focus();
}

function readLinkForm() {
  const f = linkForm.elements;
  const category = f.category.value === '__new__' ? $('#l-category-new').value.trim() : f.category.value;
  return {
    title: f.title.value.trim(), label: f.label.value.trim(), url: f.url.value.trim(), category,
    description: f.description.value.trim(), tags: f.tags.value.trim(), note: f.note.value.trim(), status: f.status.value,
    pinned: f.pinned.checked, store_id: f.store_id.value === '' ? null : Number(f.store_id.value),
  };
}

$('#l-category').addEventListener('change', (event) => {
  const input = $('#l-category-new');
  input.hidden = event.target.value !== '__new__';
  if (!input.hidden) input.focus();
});

linkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readLinkForm();
  let result;
  if (editingLink) {
    // 只送出有改的欄位。
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== editingLink[key]));
    if (!Object.keys(changed).length) { linkDialog.close(); return; }
    result = await api(`/api/links/${editingLink.id}`, { method: 'PATCH', body: changed });
  } else {
    result = await api('/api/links', { method: 'POST', body: values });
  }
  if (!result.ok) { showLinkErrors(result.data.fields, result.data.fields ? '' : result.data.error); return; }
  linkDialog.close();
  await load();
});

$('#link-cancel-btn').addEventListener('click', () => linkDialog.close());
linkDialog.addEventListener('click', (event) => { if (event.target === linkDialog) linkDialog.close(); });

$('#link-delete-btn').addEventListener('click', async () => {
  if (!editingLink) return;
  if (!confirm(`確定刪除「${editingLink.title}${editingLink.label ? `（${editingLink.label}）` : ''}」這個連結？`)) return;
  const result = await api(`/api/links/${editingLink.id}`, { method: 'DELETE' });
  if (!result.ok) { showLinkErrors({}, result.data.error); return; }
  linkDialog.close();
  await load();
});

$('#add-link-btn').addEventListener('click', () => openLinkDialog(null));
$('#link-search').addEventListener('input', (event) => { state.linkQuery = event.target.value; renderLinks(); });
for (const button of document.querySelectorAll('.link-filter')) {
  button.addEventListener('click', () => {
    state.linkFilter = button.dataset.linkFilter;
    for (const other of document.querySelectorAll('.link-filter')) other.classList.toggle('is-active', other === button);
    renderLinks();
  });
}

// 匯入 Linkbase 備份檔（JSON）。帳號密碼不會被存進來。
const showLinksNote = (selector, text) => { const node = $(selector); node.textContent = text ?? ''; node.hidden = !text; };

$('#import-links-btn').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  showLinksNote('#links-msg', ''); showLinksNote('#links-error', '');
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { showLinksNote('#links-error', '這個檔案不是正確的 JSON 備份檔。'); return; }
  const result = await api('/api/links/import', { method: 'POST', body: data });
  if (!result.ok) { showLinksNote('#links-error', result.data.error ?? '匯入失敗，請稍後再試。'); return; }
  const { imported, duplicates, invalid, with_credentials: withCredentials } = result.data;
  const parts = [`匯入完成：新增 ${imported} 筆，略過重複 ${duplicates} 筆`];
  if (invalid.length) parts.push(`${invalid.length} 筆無法匯入（${invalid.slice(0, 5).join('、')}${invalid.length > 5 ? '…' : ''}）`);
  if (withCredentials) parts.push(`備份裡有 ${withCredentials} 個項目帶帳號密碼，這裡不會存，請放進密碼管理器`);
  showLinksNote('#links-msg', `${parts.join('；')}。`);
  await load();
});

function setView(view) {
  state.view = view;
  $('#view-stores').hidden = view !== 'stores';
  $('#view-types').hidden = view !== 'types';
  $('#view-links').hidden = view !== 'links';
  $('#add-btn').hidden = view !== 'stores';
  $('#add-type-btn').hidden = view !== 'types';
  $('#add-link-btn').hidden = view !== 'links';
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab.dataset.view === view);
}

function renderAll() { renderSummary(); renderAttention(); renderList(); renderTypes(); renderLinks(); renderAudit(); }

async function load() {
  const [stores, summary, audit, types, links] = await Promise.all([api('/api/stores'), api('/api/summary'), api('/api/audit?limit=30'), api('/api/types'), api('/api/links')]);
  state.types = types.data.types ?? [];
  state.links = links.data.links ?? [];
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

// 店家小圖示：有上傳就顯示圖片，沒有就用店名第一個字
function iconNode(store, large = false) {
  const cls = `store-icon${large ? ' is-lg' : ''}`;
  if (store?.icon_v) return h('span', { class: cls }, h('img', { src: `/api/stores/${store.id}/icon?v=${store.icon_v}`, alt: '' }));
  return h('span', { class: `${cls} is-empty`, 'aria-hidden': 'true' }, (store?.name ?? '').trim().slice(0, 1) || '店');
}
function renderIconField() {
  $('#icon-field').hidden = !editing;
  if (!editing) return;
  $('#icon-preview').replaceWith(Object.assign(iconNode(editing, true), { id: 'icon-preview' }));
  $('#icon-remove-btn').disabled = !editing.icon_v;
  $('#icon-fetch-btn').disabled = !editing.url;
  showMessage('#icon-error', '');
}
async function afterIconChange() {
  await load();
  editing = state.stores.find((s) => s.id === editing.id) ?? editing;
  renderIconField();
}
function toSquarePng(file, size = 128) {
  // 用 data: 讀圖（頁面的 CSP 只允許 self 與 data: 圖片）
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('讀不到這張圖片'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('圖片轉換失敗'))), 'image/png');
      };
      img.onerror = () => reject(new Error('讀不到這張圖片'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
$('#icon-upload-btn').addEventListener('click', () => $('#icon-file').click());
$('#icon-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file || !editing) return;
  try {
    const blob = await toSquarePng(file);
    const response = await fetch(`/api/stores/${editing.id}/icon`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: blob });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '上傳失敗');
    await afterIconChange();
  } catch (error) { showMessage('#icon-error', error.message); }
});
$('#icon-fetch-btn').addEventListener('click', async () => {
  if (!editing) return;
  const result = await api(`/api/stores/${editing.id}/icon/fetch`, { method: 'POST' });
  if (!result.ok) { showMessage('#icon-error', errorText(result)); return; }
  await afterIconChange();
});
$('#icon-remove-btn').addEventListener('click', async () => {
  if (!editing || !confirm('移除這家店的小圖示？')) return;
  const result = await api(`/api/stores/${editing.id}/icon`, { method: 'DELETE' });
  if (!result.ok) { showMessage('#icon-error', errorText(result)); return; }
  await afterIconChange();
});

function openDialog(store) {
  editing = store ?? null;
  $('#dialog-title').textContent = store ? `編輯：${store.name}` : '新增店家';
  $('#delete-btn').hidden = !store;
  const values = store ?? { name: '', system_type: 'other', status: 'building', monthly_fee: 0, url: '', contract_start: '', contract_end: '', notes: '' };
  fillTypeSelect(values.system_type);
  for (const key of Object.keys(FIELD_LABEL)) if (key !== 'system_type') form.elements[key].value = values[key] ?? '';
  showErrors();
  renderIconField();
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
  $('#remote-sub').textContent = typeLabel(store.system_type);
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
  const isOrder = stats.data.system === 'order' && stats.data.orders;
  box.replaceChildren(h('div', { class: 'remote-number' },
    h('strong', {}, `${total} 筆`),
    h('span', { class: 'muted' }, `${month} ${isOrder ? '訂單數' : '預約數'}`),
    isOrder && h('span', { class: 'muted' }, `　訂單金額 $${Number(stats.data.orders.amount).toLocaleString('en-US')}`),
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
  // 依分類分組：共用功能、臉部專屬、多位老師才需要、包堂。沒帶分類的放在「其他功能」一組。
  // 舊版禾域系統（還沒更新的）把老師排班、分潤、包堂、老師通知都標成 body，這裡依模組代碼換成新分類。
  const GROUPS = [['common', '共用功能'], ['skin', '臉部專屬'], ['multi', '多位老師才需要'], ['package', '包堂'], ['order', '訂購型專屬']];
  const LEGACY_BODY = { schedule: 'multi', commission: 'multi', packages: 'package', teacherNotify: 'common' };
  const scopeOf = (key, mod) => (mod.scope === 'body' ? LEGACY_BODY[key] : mod.scope);
  const entries = Object.entries(config.data.modules);
  const known = GROUPS.map(([scope]) => scope);
  const buckets = [...GROUPS, ['other', '其他功能']];
  for (const [scope, title] of buckets) {
    const items = entries.filter(([key, mod]) => (scope === 'other' ? !known.includes(scopeOf(key, mod)) : scopeOf(key, mod) === scope));
    if (!items.length) continue;
    box.append(h('h4', { class: 'module-group' }, title));
    for (const [key, mod] of items) {
      const input = h('input', { type: 'checkbox', 'data-module': key, disabled: !canEdit });
      input.checked = mod.enabled;
      box.append(h('label', { class: `module-row${canEdit ? '' : ' is-locked'}` }, input, h('span', {}, mod.label)));
    }
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

// ---------- 新增 / 編輯系統類型 ----------
const typeDialog = $('#type-dialog');
const typeForm = $('#type-form');
let editingType = null;

function showTypeErrors(fields = {}, general = '') {
  for (const node of typeForm.querySelectorAll('[data-error]')) {
    const message = fields[node.dataset.error];
    node.textContent = message ?? '';
    node.hidden = !message;
  }
  const box = $('#type-form-error');
  const unmatched = Object.entries(fields).filter(([key]) => !typeForm.querySelector(`[data-error="${key}"]`)).map(([, message]) => message);
  box.textContent = [general, ...unmatched].filter(Boolean).join('；');
  box.hidden = !box.textContent;
}

function openTypeDialog(type) {
  editingType = type ?? null;
  $('#type-dialog-title').textContent = type ? `編輯類型：${type.label}` : '新增系統類型';
  const values = type ?? { key: '', label: '', description: '', repo: '', remote_supported: false, sort_order: 50 };
  typeForm.elements.key.value = values.key;
  typeForm.elements.key.disabled = Boolean(type);
  typeForm.elements.label.value = values.label;
  typeForm.elements.description.value = values.description;
  typeForm.elements.repo.value = values.repo;
  typeForm.elements.remote_supported.checked = values.remote_supported;
  typeForm.elements.sort_order.value = values.sort_order;
  // 「其他」是預設類型，不能刪；仍有店家使用的類型要先改走店家，所以刪除鈕只在可刪時出現。
  $('#type-delete-btn').hidden = !type || type.key === 'other';
  showTypeErrors();
  typeDialog.showModal();
  typeForm.elements.label.focus();
}

function readTypeForm() {
  const f = typeForm.elements;
  return {
    key: f.key.value.trim(), label: f.label.value.trim(), description: f.description.value, repo: f.repo.value.trim(),
    remote_supported: f.remote_supported.checked, sort_order: f.sort_order.value === '' ? 50 : Number(f.sort_order.value),
  };
}

typeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readTypeForm();
  let result;
  if (editingType) {
    delete values.key;
    // 只送出有改的欄位。
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== editingType[key]));
    if (!Object.keys(changed).length) { typeDialog.close(); return; }
    result = await api(`/api/types/${encodeURIComponent(editingType.key)}`, { method: 'PATCH', body: changed });
  } else {
    result = await api('/api/types', { method: 'POST', body: values });
  }
  if (!result.ok) { showTypeErrors(result.data.fields, result.data.fields ? '' : result.data.error); return; }
  typeDialog.close();
  await load();
});

$('#type-cancel-btn').addEventListener('click', () => typeDialog.close());
typeDialog.addEventListener('click', (event) => { if (event.target === typeDialog) typeDialog.close(); });

$('#type-delete-btn').addEventListener('click', async () => {
  if (!editingType) return;
  if (!confirm(`確定刪除系統類型「${editingType.label}」？只有沒有店家使用時才能刪除。`)) return;
  const result = await api(`/api/types/${encodeURIComponent(editingType.key)}`, { method: 'DELETE' });
  if (!result.ok) { showTypeErrors({}, result.data.error); return; }
  typeDialog.close();
  await load();
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    // 直接按「連結」分頁回到獨立的常用工具；從店家卡片進來的範圍只在那一次有效。
    if (tab.dataset.view === 'links' && state.linkStore != null) { state.linkStore = null; renderLinks(); }
    setView(tab.dataset.view);
  });
}
$('#add-type-btn').addEventListener('click', () => openTypeDialog(null));

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
