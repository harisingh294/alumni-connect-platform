#!/usr/bin/env node
// CLI entrypoint for SQLite -> PostgreSQL data migration.
//
// Default mode is DRY-RUN:
//   node server/db/importer-cli.js
//
// Transactional execution requires:
//   node server/db/importer-cli.js --execute --confirm-target=127.0.0.1:5544/alumni_test

import { runImport, DEFAULT_MIGRATION_SOURCE } from './importer.js';

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const sourceArg = args.find((a) => a.startsWith('--source='));
const sourcePath = sourceArg ? sourceArg.slice('--source='.length) : DEFAULT_MIGRATION_SOURCE;
const confirmArg = args.find((a) => a.startsWith('--confirm-target='));
const confirmTarget = confirmArg ? confirmArg.slice('--confirm-target='.length) : null;

try {
  await runImport({
    sourcePath,
    execute,
    confirmTarget,
    logger: console
  });

  if (!execute) {
    console.log('\n[SUCCESS] Dry-run completed safely. 0 writes were executed on the destination database.');
  } else {
    console.log('\n[SUCCESS] Migration execution completed transactionally.');
  }
} catch (err) {
  console.error('\n[ERROR] Migration aborted:', err.message);
  process.exit(1);
}
