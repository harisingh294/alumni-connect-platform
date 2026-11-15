// Point-in-time copy of the live database: `npm run backup`.
// Writes DATA_DIR/backups/alumni_platform-YYYYMMDD-HHMMSS.db and keeps the newest 14.
import fs from 'node:fs';
import path from 'node:path';

const rawEngine = process.env.DATABASE_ENGINE !== undefined
  ? process.env.DATABASE_ENGINE
  : process.env.DB_ENGINE;

if (rawEngine !== undefined) {
  const normalized = String(rawEngine).trim().toLowerCase();
  if (normalized === 'postgres' || normalized === 'postgresql') {
    console.error('[backup] ERROR: SQLite backup is not supported when DATABASE_ENGINE=postgres.');
    console.error('[backup] PostgreSQL backups should be performed using pg_dump or your managed database provider (e.g. Neon, Render).');
    process.exit(1);
  }
  if (normalized !== 'sqlite') {
    console.error(`[backup] ERROR: Unsupported database engine: '${rawEngine}'. Must be 'sqlite' or 'postgres'.`);
    process.exit(1);
  }
}

const { db, dataDir } = await import('./db.js');

const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = path.join(dir, `alumni_platform-${stamp}.db`);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
console.log(`Backup written: ${target}`);

const old = fs.readdirSync(dir).filter(f => f.startsWith('alumni_platform-') && f.endsWith('.db')).sort().slice(0, -14);
for (const f of old) fs.unlinkSync(path.join(dir, f));
if (old.length) console.log(`Removed ${old.length} old backup(s)`);
