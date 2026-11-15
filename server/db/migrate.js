#!/usr/bin/env node
// CLI migration runner for PostgreSQL.
//
// Usage:
//   npm run migrate
//   node server/db/migrate.js [--dry-run] [--status]
//
// Requirements:
//   DATABASE_ENGINE=postgres
//   DATABASE_URL=postgres://...

import { runMigrations, getMigrationStatus } from './migrator.js';

async function main() {
  const engine = (process.env.DATABASE_ENGINE || process.env.DB_ENGINE || '').toLowerCase().trim();
  if (engine !== 'postgres' && engine !== 'postgresql') {
    console.error('[migrate] ERROR: Migration CLI only supports PostgreSQL.');
    console.error('[migrate] Set DATABASE_ENGINE=postgres and provide a valid DATABASE_URL.');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || !connectionString.trim()) {
    console.error('[migrate] ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const isStatus = args.includes('--status');
  const isDryRun = args.includes('--dry-run');

  if (isStatus) {
    console.log('[migrate] Checking PostgreSQL migration status...');
    const status = await getMigrationStatus({ connectionString });
    console.log(`[migrate] Applied versions (${status.applied.length}): ${status.applied.length > 0 ? status.applied.join(', ') : 'none'}`);
    console.log(`[migrate] Pending migrations (${status.pending.length}):`);
    for (const m of status.pending) {
      console.log(`  - ${m.filename}`);
    }
    return;
  }

  console.log(`[migrate] Starting PostgreSQL migration runner${isDryRun ? ' (DRY RUN)' : ''}...`);
  const result = await runMigrations({
    connectionString,
    dryRun: isDryRun
  });

  if (isDryRun) {
    console.log(`[migrate] Dry run complete. ${result.pending.length} migration(s) would be applied.`);
  } else if (result.applied.length > 0) {
    console.log(`[migrate] Successfully applied ${result.applied.length} migration(s):`);
    for (const m of result.applied) {
      console.log(`  - ${m.filename} (${m.durationMs}ms)`);
    }
  } else {
    console.log('[migrate] Database is already up to date. 0 migrations applied.');
  }
}

main().catch((err) => {
  console.error('[migrate] Migration failed:', err.message);
  process.exit(1);
});
