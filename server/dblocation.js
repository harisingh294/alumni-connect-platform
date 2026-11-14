// Pure helpers that decide WHERE the database lives and whether this looks like a test process.
// No file system access, no database access, no side effects at import time. This module must stay
// that way: the seed CLI imports it to validate a request BEFORE ./db.js is ever loaded.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DATA_DIR points at the host's persistent disk in production (e.g. /var/data on Render).
export function resolveDatabaseLocation(env = process.env) {
  const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(repoRoot, 'data');
  const dbFile = env.DB_FILE || 'alumni_platform.db';
  return { dataDir, dbFile, dbPath: path.join(dataDir, dbFile) };
}

// Heuristic used only to FAIL CLOSED: a process that looks like a test run must have test isolation
// active before it may open any database. It is not what protects destructive operations
// (those need a capability from ./guard.js).
export function isTestProcess(env = process.env, argv = process.argv, execArgv = process.execArgv) {
  return Boolean(env.NODE_TEST_CONTEXT)
    || /\.test\.[cm]?[jt]s$/.test(String(argv[1] || ''))
    || execArgv.includes('--test');
}
