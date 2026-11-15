import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preloadUrl = pathToFileURL(path.join(repoRoot, 'tests', 'preload.js')).href;

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    'DATABASE_URL', 'TEST_DATABASE_URL', 'DB_FILE', 'DATA_DIR',
    'DATABASE_ENGINE', 'DB_ENGINE', 'NODE_ENV', 'RENDER',
    'SANDBOX', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS'
  ]) delete env[key];

  env.JWT_SECRET = 'app-db-test-' + crypto.randomBytes(8).toString('hex');
  return { ...env, ...extra };
}

function runModule(code, extraEnv = {}, usePreload = false) {
  const args = [];
  if (usePreload) args.push('--import', preloadUrl);
  args.push('--input-type=module', '-e', code);

  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: cleanEnv(extraEnv),
    encoding: 'utf8',
    timeout: 30000
  });
}

describe('application database entrypoint', () => {
  test('defaults to isolated SQLite when no engine is configured', () => {
    const out = runModule(
      "const { db, databaseEngine } = await import('./server/app-db.js'); const result = await db.get('SELECT 1 AS n'); console.log(JSON.stringify({ databaseEngine, result }));",
      {},
      true
    );

    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), {
      databaseEngine: 'sqlite',
      result: { n: 1 }
    });
  });

  test('DATABASE_URL alone does not activate PostgreSQL', () => {
    const out = runModule(
      "const { db, databaseEngine } = await import('./server/app-db.js'); const result = await db.get('SELECT 1 AS n'); console.log(JSON.stringify({ databaseEngine, result }));",
      { DATABASE_URL: 'postgres://test:test@127.0.0.1:1/disposable_test' },
      true
    );

    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), {
      databaseEngine: 'sqlite',
      result: { n: 1 }
    });
  });

  test('explicit PostgreSQL selection creates a PostgreSQL backend without connecting', () => {
    const out = runModule(
      "const { db, databaseEngine } = await import('./server/app-db.js'); console.log(JSON.stringify({ databaseEngine, backend: db.kind })); await db.close();",
      {
        DATABASE_ENGINE: 'postgres',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:1/disposable_test'
      }
    );

    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim()), {
      databaseEngine: 'postgres',
      backend: 'postgres'
    });
  });

  test('explicit PostgreSQL selection rejects a missing connection URL', () => {
    const out = runModule(
      "try { await import('./server/app-db.js'); console.log('UNEXPECTED_SUCCESS'); process.exitCode = 1; } catch (error) { console.log(error.message); }",
      { DATABASE_ENGINE: 'postgres' }
    );

    assert.equal(out.status, 0, out.stderr);
    assert.match(
      out.stdout,
      /PostgreSQL engine selected, but no 'connectionString', 'pool', or DATABASE_URL was provided/
    );
  });
});
