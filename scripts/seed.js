import { join } from 'node:path';
import { createPgDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { seedStores } from '../src/seed.js';

if (!process.env.DATABASE_URL) { console.error('請先設定 DATABASE_URL'); process.exit(1); }
const db = createPgDb(process.env.DATABASE_URL);
await migrate(db, join(import.meta.dirname, '..', 'migrations'));
const { added, skipped } = await seedStores(db);
console.log(`新增：${added.join('、') || '（無）'}`);
console.log(`已存在，未更動：${skipped.join('、') || '（無）'}`);
await db.close();
