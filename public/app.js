const STATUS_LABEL = { building: '建置中', running: '運作中', paused: '暫停', ended: '已結束' };
// 舊版把店名當類型存（heyu、skin）；異動紀錄裡可能還看得到，讓它們顯示得出來。
const LEGACY_TYPE_LABEL = { heyu: '禾域 HEYU', skin: '妍序 Skin' };
const TYPE_FIELD_LABEL = { label: '名稱', description: '說明', repo: '程式 repo', remote_supported: '遠端管理', sort_order: '排序' };
const FIELD_LABEL = {
  name: '店名', system_type: '系統', url: '系統網址', website: '官網網址', github_url: 'GitHub 網址', railway_url: 'Railway 網址', status: '狀態', monthly_fee: '月費',
  contract_start: '合約起日', contract_end: '合約到期日', notes: '備註',
};
const ACTION_LABEL = {
  'store.icon': '顧客頁面 Logo', 'store.create': '新增', 'store.update': '修改', 'store.delete': '刪除', 'store.remote_keys': '連線金鑰', 'store.backup': '下載備份', 'store.modules': '功能模組',
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
  linkFilter: 'default', linkCategory: 'all', linkQuery: '', linkManage: false, categoryOrder: [],
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
    h('dt', {}, label), h('dd', {}, value), hint && (typeof hint === 'string' ? h('p', { class: 'hint' }, hint) : hint));
  const counts = summary.counts;
  const breakdown = h('div', { class: 'stat-chips' }, [`共 ${counts.total} 家`, `建置 ${counts.building}`, `暫停 ${counts.paused}`, `結束 ${counts.ended}`].map((text) => h('span', {}, text)));
  box.append(h('dl', { class: 'stats' },
    stat('運作中', `${summary.counts.running} 家`, breakdown),
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
      h('div', { class: 'store-url store-links' }, storeLinkNodes(store)),
      h('div', { class: 'store-actions' },
        remoteSupported(store) && h('button', { type: 'button', class: 'btn quiet', onclick: () => openRemote(store) }, '店家頁'),
        h('button', { type: 'button', class: 'btn quiet', onclick: () => openDialog(store) }, '編輯')),
    ));
  }
}

// 店家卡片上的入口：後台（系統網址）、GitHub、Railway，有填的才顯示。
function storeLinkNodes(store) {
  const entries = [['後台', store.url], ['GitHub', store.github_url], ['Railway', store.railway_url]].filter(([, url]) => url);
  if (!entries.length) return [h('span', { class: 'muted' }, '尚未填任何網址')];
  return entries.map(([label, url]) => h('a', { class: 'link-chip', href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, label));
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

// ---------- 連結入口 ----------
// 入口頁：搜尋、分類按鈕、常用（釘選）、連結清單。店家系統併入「店家系統」分類，不另做畫面，也不顯示任何金額。
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };

const STORE_CATEGORY = '店家系統';
const STANDARD_CATEGORIES = ['表格', '工具', '文件', '機器人', STORE_CATEGORY];
const UNCATEGORIZED = '未分類';
const zhSort = (a, b) => a.localeCompare(b, 'zh-Hant');
const storeById = (id) => state.stores.find((store) => store.id === id);

// 預設：固定的分類在前，資料裡出現的其他分類（例如舊 Linkbase 匯入的）接在後面，才不會有連結點不到。
// 管理模式拖曳過的順序（state.categoryOrder）優先；沒被排過的分類維持預設順序接在後面。
function categoryList() {
  const extras = new Set();
  for (const link of state.links) if (link.category && !STANDARD_CATEGORIES.includes(link.category)) extras.add(link.category);
  // 存過順序之後，以存的清單為準（改名、合併掉的舊名稱才不會又冒出來）；店家系統永遠在。
  const base = state.categoryOrder.length
    ? [...new Set([...state.categoryOrder, STORE_CATEGORY, ...[...extras].sort(zhSort)])]
    : [...STANDARD_CATEGORIES, ...[...extras].sort(zhSort)];
  const rank = (name) => { const index = state.categoryOrder.indexOf(name); return index < 0 ? 1e9 : index; };
  return base.map((name, index) => [name, index]).sort((a, b) => (rank(a[0]) - rank(b[0])) || a[1] - b[1]).map(([name]) => name);
}

async function renameCategory(from) {
  const input = prompt(`把分類「${from}」改成：\n（填已存在的分類名稱就會合併）`, from);
  const to = input?.trim();
  if (!to || to === from) return;
  if (to === UNCATEGORIZED || to === STORE_CATEGORY) { showLinksNote('#links-error', `不能改成「${to}」`); return; }
  const names = categoryList();
  if (names.includes(to) && !confirm(`已經有「${to}」這個分類，「${from}」底下的連結會全部併進去。確定嗎？`)) return;
  const result = await api('/api/link-categories/rename', { method: 'PATCH', body: { from, to } });
  if (!result.ok) { showLinksNote('#links-error', result.data.error ?? '改名失敗，請稍後再試'); return; }
  const next = [...new Set(names.map((name) => (name === from ? to : name)))];
  const saved = await api('/api/link-categories/order', { method: 'PUT', body: { order: next } });
  showLinksNote('#links-error', saved.ok ? '' : (saved.data.error ?? '儲存分類順序失敗'));
  state.linkCategory = state.linkCategory === from ? to : state.linkCategory;
  showLinksNote('#links-msg', `已把「${from}」改成「${to}」。`);
  await load();
}

let draggingCategory = null;
async function moveCategory(from, to) {
  const names = categoryList();
  const i = names.indexOf(from), j = names.indexOf(to);
  if (i < 0 || j < 0 || i === j) return;
  const [moved] = names.splice(i, 1);
  names.splice(j, 0, moved);
  state.categoryOrder = names;
  renderLinks();
  const result = await api('/api/link-categories/order', { method: 'PUT', body: { order: names } });
  showLinksNote('#links-error', result.ok ? '' : (result.data.error ?? '儲存分類順序失敗，請稍後再試'));
  if (!result.ok) await load();
}

function visibleByStatus(link, filter = state.linkFilter) {
  if (filter === 'all') return true;
  if (filter === 'default') return link.status !== 'hidden';
  return link.status === filter;
}

// 同一個項目（同分類、同名稱）的多個連結合成一張卡；屬於某家店的連結一律併進該店那張卡。
// 店家自己的網址若還沒有對應的連結，補一個「店家網站」讓它也能從入口點進去。
function buildCards(filter = state.linkFilter) {
  const cards = new Map();
  const cardFor = (key, seed) => {
    if (!cards.has(key)) cards.set(key, { key, links: [], ...seed });
    return cards.get(key);
  };
  for (const link of state.links) {
    if (!visibleByStatus(link, filter)) continue;
    const store = link.store_id == null ? null : storeById(link.store_id);
    const card = store
      ? cardFor(`store:${store.id}`, { category: STORE_CATEGORY, title: store.name, store })
      : cardFor(`${link.category}\u0000${link.title}`, { category: link.category || UNCATEGORIZED, title: link.title, store: null });
    card.links.push(link);
  }
  if (['all', 'default', 'active'].includes(filter)) {
    for (const store of state.stores) {
      if (store.status === 'ended' || !store.url) continue;
      const card = cardFor(`store:${store.id}`, { category: STORE_CATEGORY, title: store.name, store });
      if (!card.links.some((link) => link.url === store.url)) {
        card.links.unshift({ synthetic: true, id: null, title: store.name, label: '店家網站', url: store.url, category: STORE_CATEGORY, description: '', tags: '', note: '', status: 'active', pinned: false, store_id: store.id });
      }
    }
  }
  for (const card of cards.values()) {
    const real = card.links.filter((link) => !link.synthetic);
    card.pinned = real.length > 0 && real.every((link) => link.pinned);
    card.description = card.links.map((link) => link.description).find(Boolean) || (card.store ? typeLabel(card.store.system_type) : '');
  }
  return [...cards.values()];
}

const cardText = (card) => [
  card.title, card.category, card.description, card.store ? typeLabel(card.store.system_type) : '',
  ...card.links.flatMap((link) => [link.label, link.tags, link.description, hostOf(link.url)]),
].filter(Boolean).join('\n').toLowerCase();

const byTitle = (a, b) => zhSort(a.title, b.title);

function renderCategoryFilters(cards) {
  const box = $('#link-category-filters');
  const counts = new Map();
  for (const card of cards) counts.set(card.category, (counts.get(card.category) ?? 0) + 1);
  const names = [...categoryList(), ...(counts.has(UNCATEGORIZED) ? [UNCATEGORIZED] : [])];
  if (state.linkCategory !== 'all' && !names.includes(state.linkCategory)) state.linkCategory = 'all';
  const button = (name, label, count, sortable = false) => {
    const node = h('button', {
      type: 'button', class: `link-filter${state.linkCategory === name ? ' is-active' : ''}`, 'aria-pressed': String(state.linkCategory === name),
      onclick: () => { state.linkCategory = name; renderLinks(); },
    }, label, count > 0 && h('span', { class: 'count' }, String(count)));
    if (sortable && state.linkManage) {
      node.draggable = true;
      node.classList.add('is-sortable');
      node.addEventListener('dragstart', (event) => { draggingCategory = name; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', name); node.classList.add('is-dragging'); });
      node.addEventListener('dragend', () => { draggingCategory = null; node.classList.remove('is-dragging'); });
      node.addEventListener('dragover', (event) => { if (draggingCategory && draggingCategory !== name) { event.preventDefault(); node.classList.add('is-drop-target'); } });
      node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
      node.addEventListener('drop', (event) => { event.preventDefault(); node.classList.remove('is-drop-target'); if (draggingCategory) moveCategory(draggingCategory, name); });
      node.addEventListener('keydown', async (event) => {
        if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
        const list = categoryList();
        const target = list[list.indexOf(name) + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (!target) return;
        event.preventDefault();
        await moveCategory(name, target);
        [...$('#link-category-filters').children].find((child) => child.firstChild?.textContent === name)?.focus();
      });
    }
    return node;
  };
  box.replaceChildren(button('all', '全部', cards.length), ...names.map((name) => button(name, name, counts.get(name) ?? 0, name !== UNCATEGORIZED)));
  $('#manage-hint').hidden = !state.linkManage;
  const renamable = state.linkManage && state.linkCategory !== 'all' && state.linkCategory !== UNCATEGORIZED && state.linkCategory !== STORE_CATEGORY;
  const renameBtn = $('#rename-cat-btn');
  renameBtn.hidden = !renamable;
  renameBtn.textContent = renamable ? `重新命名「${state.linkCategory}」` : '';
  const toggle = $('#link-manage-btn');
  toggle.textContent = state.linkManage ? '完成' : '管理';
  toggle.classList.toggle('is-active', state.linkManage);
  toggle.setAttribute('aria-pressed', String(state.linkManage));
}

async function setPinned(card, pinned) {
  const calls = [];
  for (const link of card.links) {
    if (link.synthetic) {
      // 店家網站還不是一筆連結：要釘選時才正式存成連結。
      if (pinned) calls.push(api('/api/links', { method: 'POST', body: { title: card.title, label: link.label, url: link.url, category: STORE_CATEGORY, status: 'active', pinned: true, store_id: card.store.id } }));
    } else if (link.pinned !== pinned) calls.push(api(`/api/links/${link.id}`, { method: 'PATCH', body: { pinned } }));
  }
  const results = await Promise.all(calls);
  const bad = results.find((result) => !result.ok);
  showLinksNote('#links-error', bad ? (bad.data.fields ? Object.values(bad.data.fields).join('、') : (bad.data.error ?? '操作失敗，請稍後再試')) : '');
  await load();
}

// ---------- 側邊欄：常用入口（沿用釘選，順序存在 pin_order） ----------
const sideState = { editing: false };

function pinnedCards() {
  const orderOf = (card) => Math.min(...card.links.filter((link) => !link.synthetic).map((link) => link.pin_order ?? 0));
  return buildCards('default').filter((card) => card.pinned).sort((a, b) => orderOf(a) - orderOf(b) || byTitle(a, b));
}

async function moveSide(index, step) {
  const cards = pinnedCards();
  const target = index + step;
  if (target < 0 || target >= cards.length) return;
  [cards[index], cards[target]] = [cards[target], cards[index]];
  const calls = [];
  cards.forEach((card, position) => {
    for (const link of card.links) {
      if (!link.synthetic && link.pin_order !== position * 10) calls.push(api(`/api/links/${link.id}`, { method: 'PATCH', body: { pin_order: position * 10 } }));
    }
  });
  const results = await Promise.all(calls);
  const bad = results.find((result) => !result.ok);
  showLinksNote('#links-error', bad ? (bad.data.error ?? '調整順序失敗，請稍後再試') : '');
  await load();
}

function renderSidebar() {
  const list = $('#side-pinned');
  const cards = pinnedCards();
  list.replaceChildren();
  $('#side-empty').hidden = cards.length > 0;
  $('#side-edit-btn').hidden = cards.length === 0;
  $('#side-edit-btn').textContent = sideState.editing ? '完成' : '調整';
  cards.forEach((card, index) => {
    // 有多個連結時，標題直接進「後台」，沒有就進第一個；其餘連結在卡片上找。
    const primary = card.links.find((link) => link.label === '後台') ?? card.links[0];
    list.append(h('li', { class: 'side-row' },
      h('a', { class: 'side-link', href: primary.url, target: '_blank', rel: 'noopener noreferrer', title: hostOf(primary.url) }, card.title),
      sideState.editing && h('span', { class: 'side-tools' },
        h('button', { type: 'button', class: 'side-mini', 'aria-label': `${card.title} 上移`, disabled: index === 0, onclick: () => moveSide(index, -1) }, '上移'),
        h('button', { type: 'button', class: 'side-mini', 'aria-label': `${card.title} 下移`, disabled: index === cards.length - 1, onclick: () => moveSide(index, 1) }, '下移'),
        h('button', { type: 'button', class: 'side-mini', 'aria-label': `${card.title} 取消釘選`, onclick: () => setPinned(card, false) }, '移除'))));
  });
}

function renderLinks() {
  const query = state.linkQuery.trim().toLowerCase();
  let cards = buildCards();
  if (query) cards = cards.filter((card) => cardText(card).includes(query));
  renderCategoryFilters(cards);

  const inCategory = state.linkCategory === 'all' ? cards : cards.filter((card) => card.category === state.linkCategory);
  // 釘選的項目改放在左側邊欄；主畫面照分類列出全部，釘選的在各分類裡排最前面。
  const rest = inCategory;
  const pinnedCards = [];
  $('#link-pinned').hidden = true;

  const box = $('#link-list');
  box.replaceChildren();
  if (!rest.length && !pinnedCards.length) {
    box.append(h('p', { class: 'empty' }, state.links.length || state.stores.length ? '沒有符合條件的連結。' : '還沒有連結。按右上角「新增連結」開始，或到頁面最下面從 Linkbase 匯入舊資料。'));
    return;
  }
  const sorted = [...rest].sort((a, b) => (a.pinned === b.pinned ? byTitle(a, b) : a.pinned ? -1 : 1));
  if (state.linkCategory !== 'all') {
    if (sorted.length) box.append(h('div', { class: 'link-cards' }, sorted.map((card) => linkCard(card))));
    else box.append(h('p', { class: 'empty' }, `「${state.linkCategory}」還沒有連結。按右上角「新增連結」。`));
    return;
  }
  for (const name of [...categoryList(), UNCATEGORIZED]) {
    const group = sorted.filter((card) => card.category === name);
    if (group.length) box.append(h('h2', { class: 'link-section' }, name), h('div', { class: 'link-cards' }, group.map((card) => linkCard(card))));
  }
}

// 一張卡：名稱（只有一個連結時名稱本身就是入口）加一句說明；有多個連結時，每個連結一顆黑框按鈕。
function linkCard(card) {
  const many = card.links.length > 1;
  const first = card.links[0];
  const open = (link) => ({ href: link.url, target: '_blank', rel: 'noopener noreferrer', title: hostOf(link.url) });
  const editable = !many && !first.synthetic ? first : null;
  // 平常只有「店家頁」這類看資料的入口；釘選、編輯、管理店家要按右上角「管理」才會出現。
  const footTools = [
    state.linkManage && h('button', { type: 'button', class: 'link-tool', onclick: () => setPinned(card, !card.pinned) }, card.pinned ? '取消釘選' : '釘選'),
    state.linkManage && editable && h('button', { type: 'button', class: 'link-tool', onclick: () => openLinkDialog(editable) }, '編輯'),
    card.store && remoteSupported(card.store) && h('button', { type: 'button', class: 'link-tool', onclick: () => openRemote(card.store) }, '店家頁'),
    state.linkManage && card.store && h('button', { type: 'button', class: 'link-tool', onclick: () => openDialog(card.store) }, '管理店家'),
  ].filter(Boolean);
  return h('article', { class: `link-card status-${first.status}` },
    h('div', { class: 'link-head' },
      h('h3', {}, many ? card.title : h('a', { class: 'card-title-link', ...open(first) }, card.title)),
      !many && first.status !== 'active' && h('span', { class: `badge ${first.status === 'pending' ? 'is-building' : 'is-paused'}` }, LINK_STATUS_LABEL[first.status])),
    card.description && h('p', { class: 'link-desc' }, card.description),
    many && h('ul', { class: 'link-urls' }, card.links.map((link) => h('li', {},
      h('a', { class: 'quick-link', ...open(link) }, link.label || hostOf(link.url)),
      link.status !== 'active' && h('span', { class: 'hint' }, LINK_STATUS_LABEL[link.status]),
      state.linkManage && !link.synthetic && h('button', { type: 'button', class: 'link-tool', onclick: () => openLinkDialog(link) }, '編輯')))),
    footTools.length > 0 && h('div', { class: 'link-foot' }, footTools));
}

const linkDialog = $('#link-dialog');
const linkForm = $('#link-form');
let editingLink = null;

const rowsBox = $('#l-rows');
const moreBox = $('#l-more');
const MAX_ROWS = 6;

// 連結列：預設只有一列（網址）；按「再加一個連結」才出現連結名稱欄，用來分辨同一項目的多個網址。
function syncRows() {
  const rows = [...rowsBox.querySelectorAll('.link-row')];
  rowsBox.classList.toggle('is-single', !editingLink && rows.length === 1);
  rows.forEach((row, index) => { row.querySelector('.row-remove').hidden = editingLink !== null || index === 0; });
  $('#l-add-row').hidden = editingLink !== null || rows.length >= MAX_ROWS;
  $('#l-links-label').textContent = rows.length > 1 ? '連結（名稱 + 網址）' : '網址';
}

function addLinkRow(values = { label: '', url: '' }, { focus = false } = {}) {
  const label = h('input', { class: 'row-label', type: 'text', maxlength: '30', placeholder: '連結名稱，例如：後台', 'aria-label': '連結名稱', autocomplete: 'off' });
  const url = h('input', { class: 'row-url', type: 'url', maxlength: '500', placeholder: 'https://', 'aria-label': '網址', autocomplete: 'off' });
  label.value = values.label ?? '';
  url.value = values.url ?? '';
  const row = h('div', { class: 'link-row' }, label, url,
    h('button', { type: 'button', class: 'link-tool row-remove', onclick: () => { row.remove(); syncRows(); } }, '移除'));
  rowsBox.append(row);
  syncRows();
  if (focus) (rowsBox.querySelectorAll('.link-row').length > 1 ? label : url).focus();
  return row;
}

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
  // 錯誤落在摺起來的「更多設定」裡時自動展開，才看得到。
  if (moreBox.querySelector('.field-error:not([hidden])')) moreBox.open = true;
}

function openLinkDialog(link) {
  editingLink = link ?? null;
  $('#link-dialog-title').textContent = link ? `編輯連結：${link.title}` : '新增連結';
  // 正在看某個分類時按「新增連結」，分類預設帶入那一個。
  const category = state.linkCategory !== 'all' && state.linkCategory !== UNCATEGORIZED ? state.linkCategory : '';
  const values = link ?? { title: '', label: '', url: '', category, description: '', tags: '', note: '', status: 'active', pinned: false, store_id: null };
  const f = linkForm.elements;
  for (const key of ['title', 'description', 'tags', 'note', 'status']) f[key].value = values[key];
  f.pinned.checked = values.pinned;
  rowsBox.replaceChildren();
  addLinkRow({ label: values.label, url: values.url });
  moreBox.open = Boolean(link && (link.status !== 'active' || link.store_id != null || link.tags || link.description || link.note || link.pinned));
  f.store_id.replaceChildren(h('option', { value: '' }, '（不屬於任何店家）'), ...state.stores.map((store) => h('option', { value: String(store.id) }, store.name)));
  f.store_id.value = values.store_id == null ? '' : String(values.store_id);
  const categories = categoryList();
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
    title: f.title.value.trim(), category,
    description: f.description.value.trim(), tags: f.tags.value.trim(), note: f.note.value.trim(), status: f.status.value,
    pinned: f.pinned.checked, store_id: f.store_id.value === '' ? null : Number(f.store_id.value),
  };
}

$('#l-add-row').addEventListener('click', () => addLinkRow(undefined, { focus: true }));

$('#l-category').addEventListener('change', (event) => {
  const input = $('#l-category-new');
  input.hidden = event.target.value !== '__new__';
  if (!input.hidden) input.focus();
});

linkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = readLinkForm();
  const rows = [...rowsBox.querySelectorAll('.link-row')].map((row) => ({ row, label: row.querySelector('.row-label').value.trim(), url: row.querySelector('.row-url').value.trim() }));
  if (editingLink) {
    // 只送出有改的欄位。
    const all = { ...values, label: rows[0].label, url: rows[0].url };
    const changed = Object.fromEntries(Object.entries(all).filter(([key, value]) => value !== editingLink[key]));
    if (!Object.keys(changed).length) { linkDialog.close(); return; }
    const result = await api(`/api/links/${editingLink.id}`, { method: 'PATCH', body: changed });
    if (!result.ok) { showLinkErrors(result.data.fields, result.data.fields ? '' : result.data.error); return; }
    linkDialog.close();
    await load();
    return;
  }
  // 新增：每一列各存成一個連結，共用項目名稱與其他設定。沒填的多餘列直接略過。
  const pending = rows.filter((entry, index) => index === 0 || entry.url || entry.label);
  let created = 0;
  for (const entry of pending) {
    const result = await api('/api/links', { method: 'POST', body: { ...values, label: entry.label, url: entry.url } });
    if (!result.ok) {
      const where = pending.length > 1 ? `第 ${created + 1} 個未存的連結：` : '';
      showLinkErrors(result.data.fields, result.data.fields ? '' : `${where}${result.data.error ?? '儲存失敗'}`);
      if (created) { await load(); showLinkErrors(result.data.fields, `已先存好 ${created} 個連結，其餘請修正後再按儲存。`); }
      return;
    }
    created += 1;
    if (rowsBox.querySelectorAll('.link-row').length > 1) entry.row.remove();
    syncRows();
  }
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
$('#rename-cat-btn').addEventListener('click', () => renameCategory(state.linkCategory));
$('#link-manage-btn').addEventListener('click', () => { state.linkManage = !state.linkManage; renderLinks(); renderSidebar(); });
$('#link-search').addEventListener('input', (event) => { state.linkQuery = event.target.value; renderLinks(); });
$('#link-status').addEventListener('change', (event) => { state.linkFilter = event.target.value; renderLinks(); });
// 按「/」直接跳到搜尋框（正在輸入文字時不攔截）。
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (state.view !== 'links' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  $('#link-search').focus();
});

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

// 三個畫面：links 是入口（預設）；stores、types 屬於「管理」，用右上角按鈕進出。
function setView(view) {
  state.view = view;
  const manage = view !== 'links';
  $('#view-links').hidden = manage;
  $('#manage').hidden = !manage;
  $('#view-stores').hidden = view !== 'stores';
  $('#view-types').hidden = view !== 'types';
  $('#add-link-btn').hidden = manage;
  $('#add-btn').hidden = view !== 'stores';
  $('#add-type-btn').hidden = view !== 'types';
  for (const [id, target] of [['#home-btn', 'links'], ['#manage-btn', 'stores'], ['#types-btn', 'types']]) $(id).classList.toggle('is-active', view === target);
  document.body.classList.remove('menu-open');
  $('#menu-btn').setAttribute('aria-expanded', 'false');
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('is-active', tab.dataset.view === view);
  window.scrollTo(0, 0);
}

function renderAll() { renderSummary(); renderAttention(); renderList(); renderTypes(); renderLinks(); renderSidebar(); renderAudit(); }

async function load() {
  const [stores, summary, audit, types, links, categories] = await Promise.all([api('/api/stores'), api('/api/summary'), api('/api/audit?limit=30'), api('/api/types'), api('/api/links'), api('/api/link-categories')]);
  state.categoryOrder = categories.data.order ?? [];
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

// 顧客頁 Logo：只在店家編輯畫面預覽，不顯示回店家總覽卡片。
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
  $('#icon-fetch-btn').disabled = !editing.website;
  $('#icon-sync-btn').disabled = false;
  const status = $('#icon-sync-status');
  if (editing.icon_sync_state === 'synced') {
    status.textContent = editing.icon_v ? '已同步到顧客頁。' : '已同步，顧客頁已恢復預設圖示。';
    status.className = 'ok-note';
  } else if (editing.icon_sync_state === 'pending') {
    status.textContent = '等待同步到顧客頁。';
    status.className = 'hint';
  } else if (editing.icon_sync_state === 'error') {
    status.textContent = `尚未套用到顧客頁：${editing.icon_sync_error || '同步失敗，請重試'}`;
    status.className = 'field-error';
  } else {
    status.textContent = editing.icon_v ? '尚未同步到顧客頁，請按「立即同步」。' : '顧客頁目前使用預設圖示。';
    status.className = 'hint';
  }
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
  if (!editing || !confirm('移除這家店的顧客頁面 Logo，並讓顧客頁恢復預設圖示？')) return;
  const result = await api(`/api/stores/${editing.id}/icon`, { method: 'DELETE' });
  if (!result.ok) { showMessage('#icon-error', errorText(result)); return; }
  await afterIconChange();
});
$('#icon-sync-btn').addEventListener('click', async () => {
  if (!editing) return;
  const button = $('#icon-sync-btn');
  button.disabled = true;
  showMessage('#icon-error', '');
  $('#icon-sync-status').textContent = '同步中…';
  const result = await api(`/api/stores/${editing.id}/icon/sync`, { method: 'POST' });
  await afterIconChange();
  if (!result.ok || !result.data.sync?.ok) showMessage('#icon-error', result.data.sync?.error ?? errorText(result));
});

function openDialog(store) {
  editing = store ?? null;
  $('#dialog-title').textContent = store ? `編輯：${store.name}` : '新增店家';
  $('#delete-btn').hidden = !store;
  const values = store ?? { name: '', system_type: 'other', status: 'building', monthly_fee: 0, url: '', website: '', github_url: '', railway_url: '', contract_start: '', contract_end: '', notes: '' };
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
    url: raw.url.trim(), website: raw.website.trim(), github_url: raw.github_url.trim(), railway_url: raw.railway_url.trim(), contract_start: raw.contract_start || null, contract_end: raw.contract_end || null, notes: raw.notes,
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
  for (const id of ['#remote-modules-error', '#remote-modules-ok', '#remote-keys-error', '#remote-backup-error', '#remote-backup-ok']) showMessage(id, '');
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
  $('#remote-backup').disabled = !canEdit;
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

// 下載備份：向 CRM 要檔案（CRM 再用寫入金鑰向店家系統取），存成 JSON 檔
$('#remote-backup').addEventListener('click', async () => {
  const button = $('#remote-backup');
  showMessage('#remote-backup-error', ''); showMessage('#remote-backup-ok', '');
  button.disabled = true;
  try {
    const response = await fetch(remoteUrl('/backup'), { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      showMessage('#remote-backup-error', data.error || '下載備份失敗，請稍後再試');
      return;
    }
    const blob = await response.blob();
    const header = response.headers.get('content-disposition') || '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
    const name = encoded ? decodeURIComponent(encoded) : (/filename="([^"]+)"/.exec(header)?.[1] || 'backup.json');
    const link = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    showMessage('#remote-backup-ok', `已下載：${name}`);
    await refreshAudit();
  } catch {
    showMessage('#remote-backup-error', '連不上 CRM，請稍後再試');
  } finally { button.disabled = !remote.overview?.can_edit; }
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

for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));
$('#home-btn').addEventListener('click', () => setView('links'));
$('#manage-btn').addEventListener('click', () => setView('stores'));
$('#types-btn').addEventListener('click', () => setView('types'));
$('#side-edit-btn').addEventListener('click', () => { sideState.editing = !sideState.editing; renderSidebar(); });
$('#menu-btn').addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  $('#menu-btn').setAttribute('aria-expanded', String(open));
});
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

setView('links');
load().catch((error) => { if (error.message !== 'unauthorized') $('#list').replaceChildren(h('p', { class: 'empty' }, '載入失敗，請重新整理頁面。')); });
