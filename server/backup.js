// Point-in-time copy of the live database: `npm run backup`.
// Writes DATA_DIR/backups/alumni_platform-YYYYMMDD-HHMMSS.db and keeps the newest 14.
import fs from 'node:fs';
import path from 'node:path';
import { db, dataDir } from './db.js';

const dir = path.join(dataDir, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const target = path.join(dir, `alumni_platform-${stamp}.db`);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
console.log(`Backup written: ${target}`);

const old = fs.readdirSync(dir).filter(f => f.startsWith('alumni_platform-') && f.endsWith('.db')).sort().slice(0, -14);
for (const f of old) fs.unlinkSync(path.join(dir, f));
if (old.length) console.log(`Removed ${old.length} old backup(s)`);
