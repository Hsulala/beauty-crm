// 店家設定：功能模組開關與品牌（店名、主題色）。
// 設計原則：
//   1) 沒存過的設定用預設值；既有功能的模組預設「開」，升級後行為不變。
//   2) 寫入只動有帶的欄位，其餘（包含這次沒帶的、以及未知的 key）維持原值。
//   3) 每次實際有變動都留異動紀錄。

const MODULES = {
  revenue: { label: '營收數據', description: '月營收、單日營收、營收明細與客戶累積消費', defaultEnabled: true },
  skinRecord: { label: '皮膚紀錄', description: '預約詳情內的皮膚狀態紀錄', defaultEnabled: true },
};

const DEFAULT_BRAND = { name: '妍序 Skin', themeColor: null };
const MODULE_KEYS = Object.keys(MODULES);

async function readRaw(pool) {
  const { rows } = await pool.query('SELECT key, value FROM store_config');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function effective(raw) {
  const storedModules = raw.modules && typeof raw.modules === 'object' ? raw.modules : {};
  const modules = Object.fromEntries(MODULE_KEYS.map((key) => [
    key,
    typeof storedModules[key] === 'boolean' ? storedModules[key] : MODULES[key].defaultEnabled,
  ]));
  const storedBrand = raw.brand && typeof raw.brand === 'object' ? raw.brand : {};
  const brand = {
    name: typeof storedBrand.name === 'string' && storedBrand.name ? storedBrand.name : DEFAULT_BRAND.name,
    themeColor: /^#[0-9a-fA-F]{6}$/.test(storedBrand.themeColor ?? '') ? storedBrand.themeColor.toLowerCase() : DEFAULT_BRAND.themeColor,
  };
  return { modules, brand };
}

async function getConfig(pool) {
  return effective(await readRaw(pool));
}

async function isModuleEnabled(pool, key) {
  return (await getConfig(pool)).modules[key] === true;
}

// 回傳 { errors }（有錯就不寫入）或 { config, changed }
function validate(input) {
  const errors = {};
  const patch = { modules: {}, brand: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: { _: '資料格式不正確' }, patch };

  if (input.modules !== undefined) {
    if (!input.modules || typeof input.modules !== 'object' || Array.isArray(input.modules)) errors.modules = '模組設定格式不正確';
    else {
      for (const [key, value] of Object.entries(input.modules)) {
        if (!MODULE_KEYS.includes(key)) errors[`modules.${key}`] = '沒有這個模組';
        else if (typeof value !== 'boolean') errors[`modules.${key}`] = '必須是開或關';
        else patch.modules[key] = value;
      }
    }
  }
  if (input.brand !== undefined) {
    if (!input.brand || typeof input.brand !== 'object' || Array.isArray(input.brand)) errors.brand = '品牌設定格式不正確';
    else {
      if (Object.hasOwn(input.brand, 'name')) {
        const name = typeof input.brand.name === 'string' ? input.brand.name.trim() : '';
        if (!name) errors['brand.name'] = '請填寫店名';
        else if (name.length > 30) errors['brand.name'] = '店名最多 30 字';
        else patch.brand.name = name;
      }
      if (Object.hasOwn(input.brand, 'themeColor')) {
        const color = input.brand.themeColor;
        if (color === null || color === '') patch.brand.themeColor = null;
        else if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) patch.brand.themeColor = color.toLowerCase();
        else errors['brand.themeColor'] = '主題色需為 #RRGGBB 格式';
      }
      for (const key of Object.keys(input.brand)) if (!['name', 'themeColor'].includes(key)) errors[`brand.${key}`] = '沒有這個設定';
    }
  }
  for (const key of Object.keys(input)) if (!['modules', 'brand'].includes(key)) errors[key] = '沒有這個設定';
  return { errors, patch };
}

async function updateConfig(pool, input, actor = '') {
  const { errors, patch } = validate(input);
  if (Object.keys(errors).length) return { errors };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT key, value FROM store_config FOR UPDATE');
    const raw = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const before = effective(raw);

    const nextModules = { ...(raw.modules && typeof raw.modules === 'object' ? raw.modules : {}), ...patch.modules };
    const nextBrand = { ...(raw.brand && typeof raw.brand === 'object' ? raw.brand : {}), ...patch.brand };
    const after = effective({ ...raw, modules: nextModules, brand: nextBrand });

    const changes = {};
    for (const key of MODULE_KEYS) if (before.modules[key] !== after.modules[key]) changes[`modules.${key}`] = { from: before.modules[key], to: after.modules[key] };
    for (const key of ['name', 'themeColor']) if (before.brand[key] !== after.brand[key]) changes[`brand.${key}`] = { from: before.brand[key], to: after.brand[key] };

    if (Object.keys(changes).length) {
      if (Object.keys(patch.modules).length) {
        await client.query(
          `INSERT INTO store_config (key, value) VALUES ('modules', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [JSON.stringify(nextModules)],
        );
      }
      if (Object.keys(patch.brand).length) {
        await client.query(
          `INSERT INTO store_config (key, value) VALUES ('brand', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [JSON.stringify(nextBrand)],
        );
      }
      await client.query('INSERT INTO config_audit (actor, changes) VALUES ($1, $2::jsonb)', [actor, JSON.stringify(changes)]);
    }
    await client.query('COMMIT');
    return { config: after, changed: Object.keys(changes).length > 0 };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* 連線已斷就算了 */ }
    throw error;
  } finally {
    client.release();
  }
}

async function recentAudit(pool, limit = 30) {
  const { rows } = await pool.query('SELECT id, at, actor, changes FROM config_audit ORDER BY id DESC LIMIT $1', [limit]);
  return rows;
}

module.exports = { MODULES, MODULE_KEYS, DEFAULT_BRAND, getConfig, isModuleEnabled, updateConfig, validate, recentAudit };
