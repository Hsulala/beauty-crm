// 連結的欄位驗證，以及把 Linkbase 匯出的備份檔轉成連結資料。
export const LINK_STATUSES = ['active', 'pending', 'hidden'];
export const IMPORT_LIMIT = 500;

const textField = (max, message, { required = false } = {}) => ({
  fallback: '',
  parse(raw) {
    if (typeof raw !== 'string') return { error: message };
    const value = raw.trim();
    if (required && !value) return { error: message };
    if (value.length > max) return { error: `最多 ${max} 字` };
    return { value };
  },
});

const fields = {
  title: textField(80, '請填寫名稱', { required: true }),
  label: textField(30, '連結名稱格式不正確'),
  url: {
    parse(raw) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) return { error: '請填寫網址' };
      if (value.length > 500) return { error: '網址太長' };
      try {
        const { protocol } = new URL(value);
        if (protocol !== 'http:' && protocol !== 'https:') return { error: '網址需以 http:// 或 https:// 開頭' };
      } catch { return { error: '網址格式不正確' }; }
      return { value };
    },
  },
  category: textField(30, '分類格式不正確'),
  description: textField(200, '說明格式不正確'),
  tags: textField(100, '標籤格式不正確'),
  note: textField(2000, '備註格式不正確'),
  status: {
    fallback: 'active',
    parse: (raw) => (LINK_STATUSES.includes(raw) ? { value: raw } : { error: '狀態不正確' }),
  },
  pinned: {
    fallback: false,
    parse: (raw) => (typeof raw === 'boolean' ? { value: raw } : { error: '釘選格式不正確' }),
  },
  store_id: {
    fallback: null,
    parse(raw) {
      if (raw === null) return { value: null };
      return Number.isInteger(raw) && raw > 0 && raw < 1_000_000_000 ? { value: raw } : { error: '店家不正確' };
    },
  },
};

export const LINK_FIELD_NAMES = Object.keys(fields);

// partial = true（修改）只處理有帶的欄位；false（新增）缺少的欄位補預設值。
export function parseLink(input, { partial }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: '資料格式不正確' }, value: {} };
  const value = {}, errors = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(input, key)) {
      if (partial) continue;
      if (key === 'title' || key === 'url') { errors[key] = spec.parse(undefined).error; continue; }
      value[key] = spec.fallback;
      continue;
    }
    const result = spec.parse(input[key]);
    if (result.error) errors[key] = result.error; else value[key] = result.value;
  }
  return { value, errors };
}

// ---- Linkbase 備份檔 ----
// 備份格式：{ version, items: [{ title, category, description, tags[], status, pinned, links: [{ label, url }], username, password, note }], categories: [{ id, label }] }
const BASE_CATEGORIES = { clients: '客戶專案', systems: '公司系統', docs: '常用文件' };

function matchStore(title, stores) {
  const wanted = title.toLowerCase();
  const exact = stores.find((store) => store.name.toLowerCase() === wanted);
  if (exact) return exact;
  if (wanted.length < 2) return null;
  return stores.find((store) => {
    const name = store.name.toLowerCase();
    return name.length >= 2 && (name.includes(wanted) || wanted.includes(name));
  }) ?? null;
}

const statusOf = (raw) => (raw === 'pending' ? 'pending' : raw === undefined || raw === null || raw === 'live' ? 'active' : 'hidden');

export function normalizeImport(data, stores) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return { error: '這不是可用的 Linkbase 備份檔（找不到 items）' };
  if (data.items.length > IMPORT_LIMIT) return { error: `一次最多匯入 ${IMPORT_LIMIT} 個項目` };
  const labels = { ...BASE_CATEGORIES };
  for (const entry of Array.isArray(data.categories) ? data.categories : []) {
    if (entry && typeof entry.id === 'string' && typeof entry.label === 'string') labels[entry.id] = entry.label;
  }
  const rows = [], invalid = [];
  let withCredentials = 0;
  for (const item of data.items) {
    if (!item || typeof item !== 'object') { invalid.push('（格式不正確）'); continue; }
    if (item.username || item.password) withCredentials += 1;
    const title = String(item.title ?? '').trim().slice(0, 80);
    const links = Array.isArray(item.links) ? item.links : [];
    if (!title || !links.length) { invalid.push(title || '（沒有名稱）'); continue; }
    const category = item.category === 'pinned' ? '' : String(labels[item.category] ?? item.category ?? '').trim().slice(0, 30);
    const tags = Array.isArray(item.tags) ? item.tags.map((tag) => String(tag).trim()).filter(Boolean).join(', ').slice(0, 100) : '';
    const store = matchStore(title, stores);
    for (const link of links) {
      const label = String(link?.label ?? '').trim().slice(0, 30);
      const { value, errors } = parseLink({
        title, label, url: link?.url, category,
        description: String(item.description ?? '').slice(0, 200), tags,
        note: String(item.note ?? '').slice(0, 2000),
        status: statusOf(item.status), pinned: item.pinned === true, store_id: store?.id ?? null,
      }, { partial: false });
      if (Object.keys(errors).length) invalid.push(label ? `${title}（${label}）` : title);
      else rows.push(value);
    }
  }
  return { rows, invalid, withCredentials };
}
