import { join } from 'node:path';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb, createPgliteDb } from './db.js';
import { migrate } from './migrate.js';

let config;
try { config = loadConfig(); }
catch (error) { console.error(error.message); process.exit(1); }

const root = join(import.meta.dirname, '..');
const db = config.databaseUrl ? createPgDb(config.databaseUrl) : await createPgliteDb(join(root, '.pglite'));
const ran = await migrate(db, join(root, 'migrations'));
if (ran.length) console.log(`已套用 migration：${ran.join(', ')}`);

const app = createApp({ db, config });
const server = app.listen(config.port, () => console.log(`店家 CRM 已啟動：port ${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => db.close().finally(() => process.exit(0))));
