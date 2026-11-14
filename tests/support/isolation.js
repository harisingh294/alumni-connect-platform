// Creates this process's temporary test database and registers it with the guard.
// Loaded by tests/preload.js (node --import) before any test file runs. Each test process gets its
// own fresh directory under the OS temp folder, so parallel test files never share a database.
//
// Whatever DATA_DIR, DB_FILE or DATABASE_URL the shell exported is discarded, never used, and
// server/db.js ignores them entirely in a test process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { markDisposableTestTarget, isProductionEnvironment, resolveTarget, isInside, closeAll, TEST_DIR_PREFIX } from '../../server/guard.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

if (isProductionEnvironment()) {
  throw new Error('Refusing to run tests: NODE_ENV=production (or RENDER=true) is set. Tests must never run in a production environment.');
}

// Never inherit connection settings from the environment.
delete process.env.DATABASE_URL;
delete process.env.TEST_DATABASE_URL;

const tmpRoot = resolveTarget(os.tmpdir());
export const testDir = resolveTarget(fs.mkdtempSync(path.join(tmpRoot, TEST_DIR_PREFIX)));
export const testDbFile = 'alumni_platform.test.db';
export const testDbPath = path.join(testDir, testDbFile);

if (!isInside(testDir, tmpRoot) || isInside(testDir, repoRoot)) {
  throw new Error(`Refusing to run tests: ${testDir} is not a safe temporary location.`);
}

// Tests never use the real signing secret: a random one per process.
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
// Informational only. server/db.js uses the registered location, not these.
process.env.DATA_DIR = testDir;
process.env.DB_FILE = testDbFile;

// Capability for the full seed and dropAllTables(). Only valid for this exact temporary file.
export const testGrant = markDisposableTestTarget({ dir: testDir, dbPath: testDbPath, activate: true });

let cleaned = false;
// Closes every open database handle first (Windows cannot delete open files), then removes the
// directory this module created. Returns true once the directory is gone. A failed attempt leaves
// `cleaned` false, so a later call (for example the exit handler) retries.
export function cleanupTestDatabase() {
  if (cleaned) return true;
  closeAll();
  try {
    if (path.basename(testDir).startsWith(TEST_DIR_PREFIX) && isInside(testDir, tmpRoot)) {
      fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } catch {
    return false;
  }
  cleaned = !fs.existsSync(testDir);
  return cleaned;
}

process.on('exit', cleanupTestDatabase);
// Ctrl+C and termination: clean up, then let the signal take its normal effect.
// SIGKILL, a hard crash or power loss run no code at all, so a leftover directory is possible there.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanupTestDatabase();
    try { process.kill(process.pid, signal); } catch { process.exit(signal === 'SIGINT' ? 130 : 143); }
  });
}
