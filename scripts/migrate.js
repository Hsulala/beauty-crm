import { join } from 'node:path';
import { createPgDb } from '../src/db.js';
import { migrate } from '../src/migrate.js';

if (!process.env.DATABASE_URL) { console.error('請先設定 DATABASE_URL'); process.exit(1); }
const db = createPgDb(process.env.DATABASE_URL);
const ran = await migrate(db, join(import.meta.dirname, '..', 'migrations'));
console.log(ran.length ? `已套用：${ran.join(', ')}` : '沒有需要套用的 migration');
await db.close();
