export const STATUSES = ['building', 'running', 'paused', 'ended'];
export const SYSTEM_TYPES = ['heyu', 'skin', 'order', 'other'];

const isDate = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const fields = {
  name: {
    required: true,
    parse(raw) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) return { error: '請填寫店名' };
      if (value.length > 60) return { error: '店名最多 60 字' };
      return { value };
    },
  },
  system_type: {
    fallback: 'other',
    parse: (raw) => (SYSTEM_TYPES.includes(raw) ? { value: raw } : { error: '系統類型不正確' }),
  },
  url: {
    fallback: '',
    parse(raw) {
      const value = typeof raw === 'string' ? raw.trim() : null;
      if (value === null) return { error: '網址格式不正確' };
      if (value === '') return { value };
      if (value.length > 300) return { error: '網址太長' };
      try {
        const { protocol } = new URL(value);
        if (protocol !== 'http:' && protocol !== 'https:') return { error: '網址需以 http:// 或 https:// 開頭' };
      } catch { return { error: '網址格式不正確' }; }
      return { value };
    },
  },
  status: {
    fallback: 'building',
    parse: (raw) => (STATUSES.includes(raw) ? { value: raw } : { error: '狀態不正確' }),
  },
  monthly_fee: {
    fallback: 0,
    parse(raw) {
      const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
      if (!Number.isInteger(value) || value < 0 || value > 1_000_000) return { error: '月費需為 0 到 1,000,000 的整數' };
      return { value };
    },
  },
  contract_start: { fallback: null, parse: parseDate },
  contract_end: { fallback: null, parse: parseDate },
  notes: {
    fallback: '',
    parse(raw) {
      if (typeof raw !== 'string') return { error: '備註格式不正確' };
      if (raw.length > 2000) return { error: '備註最多 2000 字' };
      return { value: raw };
    },
  },
};

function parseDate(raw) {
  if (raw === null || raw === '') return { value: null };
  return isDate(raw) ? { value: raw } : { error: '日期格式需為 YYYY-MM-DD，且必須是存在的日期' };
}

export const FIELD_NAMES = Object.keys(fields);

// partial = true 時（修改）只處理有帶的欄位；false 時（新增）缺少的欄位補預設值。
export function parseStore(input, { partial }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: '資料格式不正確' }, value: {} };
  const value = {}, errors = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.hasOwn(input, key)) {
      if (partial) continue;
      if (spec.required) { errors[key] = spec.parse(undefined).error; continue; }
      value[key] = spec.fallback;
      continue;
    }
    const result = spec.parse(input[key]);
    if (result.error) errors[key] = result.error; else value[key] = result.value;
  }
  return { value, errors };
}

// 合併後再檢查起訖日順序（修改時另一端可能來自資料庫原有的值）。
export function checkContractOrder({ contract_start: start, contract_end: end }) {
  return start && end && end < start ? { contract_end: '合約到期日不能早於起日' } : null;
}
