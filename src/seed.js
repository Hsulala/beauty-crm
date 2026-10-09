// 預先登錄既有兩家店。只新增不存在的店名，已存在的一律不動（不覆蓋你已改過的資料）。
export const SEED_STORES = [
  {
    name: '禾域 HEYU',
    system_type: 'heyu',
    url: 'https://heyu-booking-production-bcf9.up.railway.app',
    status: 'running',
    monthly_fee: 1000,
    notes: '按摩工作室。GitHub Hsulala/heyu-booking，Railway Volume 存 JSON 檔，推到 main 自動部署。',
  },
  {
    name: '妍序 Skin',
    system_type: 'skin',
    url: '',
    status: 'running',
    monthly_fee: 1000,
    notes: '皮膚管理。Railway 專案 crm-system，GitHub Hsulala/skin-crm（私有），目前以 zip 上傳部署。',
  },
  {
    name: '戀鳳爪',
    system_type: 'order',
    url: 'https://lianfengzhua-app-production.up.railway.app',
    status: 'building',
    monthly_fee: 3000,
    notes: '訂購型（B2B＋B2C）LINE 機器人與後台。GitHub Hsulala/lianfengzhua-line-bot，推到 main 自動部署。建置費 3 萬、月費 3,000（含流量費與每月 4 小時支援）。',
  },
];

export async function seedStores(db, stores = SEED_STORES) {
  const added = [], skipped = [];
  for (const store of stores) {
    await db.tx(async (tx) => {
      const exists = await tx.query('SELECT 1 FROM stores WHERE lower(name) = lower($1)', [store.name]);
      if (exists.rows.length) { skipped.push(store.name); return; }
      const { rows } = await tx.query(
        `INSERT INTO stores (name, system_type, url, status, monthly_fee, notes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [store.name, store.system_type, store.url, store.status, store.monthly_fee, store.notes],
      );
      await tx.query(
        'INSERT INTO audit_log (action, store_id, store_name, detail) VALUES ($1, $2, $3, $4::jsonb)',
        ['store.create', rows[0].id, store.name, JSON.stringify({ source: 'seed' })],
      );
      added.push(store.name);
    });
  }
  return { added, skipped };
}
