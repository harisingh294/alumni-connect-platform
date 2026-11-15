// Tests for PostgreSQL maintenance and seed guards (Phase 3).
//
// Verifies that:
// 1. SQLite backup (server/backup.js) fails immediately with exit code 1 when DATABASE_ENGINE=postgres.
// 2. Full seed and sandbox seed (server/seed-cli.js) fail immediately with exit code 1 when DATABASE_ENGINE=postgres.
// 3. SQLite local development behavior and confirmation guards are 100% preserved.
// 4. Platform sandbox reset route returns 503 in PostgreSQL mode.
// 5. Platform feedback.csv route is available across both engines.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const backupScript = path.join(repoRoot, 'server', 'backup.js');
const seedCliScript = path.join(repoRoot, 'server', 'seed-cli.js');

describe('Database Maintenance & Seed Guards (PostgreSQL Mode)', () => {
  test('server/backup.js fails immediately when DATABASE_ENGINE=postgres', async () => {
    try {
      await execFileAsync(process.execPath, [backupScript], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'postgres'
        }
      });
      assert.fail('Expected backup.js to fail with exit code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /SQLite backup is not supported when DATABASE_ENGINE=postgres/);
      assert.match(err.stderr, /pg_dump/);
    }
  });

  test('server/backup.js fails immediately when DB_ENGINE=postgresql', async () => {
    try {
      const cleanEnv = { ...process.env, DB_ENGINE: 'postgresql' };
      delete cleanEnv.DATABASE_ENGINE;
      await execFileAsync(process.execPath, [backupScript], { env: cleanEnv });
      assert.fail('Expected backup.js to fail with exit code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /SQLite backup is not supported when DATABASE_ENGINE=postgres/);
    }
  });

  test('server/seed-cli.js (full seed) fails immediately when DATABASE_ENGINE=postgres', async () => {
    try {
      await execFileAsync(process.execPath, [seedCliScript], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'postgres'
        }
      });
      assert.fail('Expected seed-cli.js to fail with exit code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /SQLite database seeding is not supported when DATABASE_ENGINE=postgres/);
      assert.match(err.stderr, /npm run migrate/);
    }
  });

  test('server/seed-cli.js (--sandbox) fails immediately when DATABASE_ENGINE=postgres', async () => {
    try {
      await execFileAsync(process.execPath, [seedCliScript, '--sandbox'], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'postgres'
        }
      });
      assert.fail('Expected seed-cli.js --sandbox to fail with exit code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /SQLite database seeding is not supported when DATABASE_ENGINE=postgres/);
      assert.match(err.stderr, /npm run migrate/);
    }
  });
});

describe('Database Maintenance & Seed (SQLite Compatibility Mode)', () => {
  test('server/seed-cli.js preserves wipe confirmation guard in SQLite mode', async () => {
    try {
      await execFileAsync(process.execPath, [seedCliScript], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'sqlite'
        }
      });
      assert.fail('Expected seed-cli.js to require confirmation in SQLite mode');
    } catch (err) {
      assert.equal(err.code, 1);
      // Verifies original SQLite guard message
      assert.match(err.stderr, /--confirm-wipe=/);
    }
  });

  test('server/seed-cli.js preserves sandbox confirmation guard in SQLite mode', async () => {
    try {
      await execFileAsync(process.execPath, [seedCliScript, '--sandbox'], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'sqlite'
        }
      });
      assert.fail('Expected seed-cli.js --sandbox to require confirmation in SQLite mode');
    } catch (err) {
      assert.equal(err.code, 1);
      // Verifies original SQLite sandbox guard message
      assert.match(err.stderr, /--confirm-sandbox=/);
    }
  });

  test('server/backup.js executes vacuum into and writes backup in SQLite mode', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['--import', './tests/preload.js', backupScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_ENGINE: 'sqlite'
      }
    });

    assert.match(stdout, /Backup written:/);
  });
});

describe('Platform Route Guards in PostgreSQL Mode', () => {
  test('sandbox/reset route returns 503 when engine is not sqlite', async () => {
    const script = `
      process.env.DATABASE_URL = 'postgres://localhost/dummy';
      const { default: platformRouter } = await import('./server/routes/platform.js');
      import assert from 'node:assert';
      const resetLayer = platformRouter.stack.find(
        (l) => l.route && l.route.path === '/sandbox/reset' && l.route.methods.post
      );
      assert.ok(resetLayer, 'POST /sandbox/reset route exists');
      let statusCode = null;
      let jsonBody = null;
      const res = {
        status(code) { statusCode = code; return this; },
        json(body) { jsonBody = body; return this; }
      };
      // invoke the route handler
      const handler = resetLayer.route.stack[0].handle;
      await handler({ user: { id: 'test_superadmin', role: 'SUPERADMIN' } }, res, () => {});
      assert.equal(statusCode, 503);
      assert.match(jsonBody?.error || '', /SQLite-only/);
    `;
    await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          JWT_SECRET: 'testsecret12345678901234567890',
          DATABASE_ENGINE: 'postgres'
        }
      }
    );
  });

  test('feedback.csv generates valid CSV with correct headers', async () => {
    const script = `
      import { feedbackCsv } from './server/routes/feedback.js';
      import assert from 'node:assert';
      const csv = await feedbackCsv(false);
      assert.ok(typeof csv === 'string');
      const firstLine = csv.split('\\n')[0];
      assert.equal(
        firstLine,
        'Date,Partner and person,What they said (their words),Type,Decision,Shipped on,Evidence,Partner\\'s reaction'
      );
    `;
    await execFileAsync(
      process.execPath,
      ['--import', './tests/preload.js', '--input-type=module', '-e', script],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_ENGINE: 'sqlite'
        }
      }
    );
  });
});

describe('Invalid Engine Values & Precedence Guards', () => {
  // Helper to test process failure
  async function assertEngineRejection(script, env, expectedPattern) {
    try {
      await execFileAsync(process.execPath, [script], {
        env: {
          ...process.env,
          ...env
        }
      });
      assert.fail(`Expected ${path.basename(script)} to fail with exit code 1`);
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, expectedPattern);
    }
  }

  test('backup.js rejects invalid DATABASE_ENGINE=mysql', async () => {
    await assertEngineRejection(backupScript, { DATABASE_ENGINE: 'mysql', DB_ENGINE: '' }, /Unsupported database engine: 'mysql'/);
  });

  test('backup.js rejects typo DATABASE_ENGINE=postgre', async () => {
    await assertEngineRejection(backupScript, { DATABASE_ENGINE: 'postgre', DB_ENGINE: '' }, /Unsupported database engine: 'postgre'/);
  });

  test('backup.js rejects empty/whitespace DATABASE_ENGINE=""', async () => {
    await assertEngineRejection(backupScript, { DATABASE_ENGINE: '', DB_ENGINE: '' }, /Unsupported database engine: ''/);
  });

  test('backup.js rejects invalid DB_ENGINE=mongo when DATABASE_ENGINE is unset', async () => {
    const cleanEnv = { ...process.env, DB_ENGINE: 'mongo' };
    delete cleanEnv.DATABASE_ENGINE;
    await assertEngineRejection(backupScript, cleanEnv, /Unsupported database engine: 'mongo'/);
  });

  test('backup.js respects precedence: DATABASE_ENGINE overrides DB_ENGINE', async () => {
    // DATABASE_ENGINE=mysql overrides DB_ENGINE=sqlite
    await assertEngineRejection(
      backupScript,
      { DATABASE_ENGINE: 'mysql', DB_ENGINE: 'sqlite' },
      /Unsupported database engine: 'mysql'/
    );
    // DATABASE_ENGINE=postgres overrides DB_ENGINE=sqlite
    await assertEngineRejection(
      backupScript,
      { DATABASE_ENGINE: 'postgres', DB_ENGINE: 'sqlite' },
      /SQLite backup is not supported when DATABASE_ENGINE=postgres/
    );
  });

  test('seed-cli.js rejects invalid DATABASE_ENGINE=mysql', async () => {
    await assertEngineRejection(seedCliScript, { DATABASE_ENGINE: 'mysql', DB_ENGINE: '' }, /Unsupported database engine: 'mysql'/);
  });

  test('seed-cli.js rejects typo DATABASE_ENGINE=postgre', async () => {
    await assertEngineRejection(seedCliScript, { DATABASE_ENGINE: 'postgre', DB_ENGINE: '' }, /Unsupported database engine: 'postgre'/);
  });

  test('seed-cli.js rejects empty/whitespace DATABASE_ENGINE=""', async () => {
    await assertEngineRejection(seedCliScript, { DATABASE_ENGINE: '', DB_ENGINE: '' }, /Unsupported database engine: ''/);
  });

  test('seed-cli.js rejects invalid DB_ENGINE=mongo when DATABASE_ENGINE is unset', async () => {
    const cleanEnv = { ...process.env, DB_ENGINE: 'mongo' };
    delete cleanEnv.DATABASE_ENGINE;
    await assertEngineRejection(seedCliScript, cleanEnv, /Unsupported database engine: 'mongo'/);
  });

  test('seed-cli.js respects precedence: DATABASE_ENGINE overrides DB_ENGINE', async () => {
    // DATABASE_ENGINE=mysql overrides DB_ENGINE=sqlite
    await assertEngineRejection(
      seedCliScript,
      { DATABASE_ENGINE: 'mysql', DB_ENGINE: 'sqlite' },
      /Unsupported database engine: 'mysql'/
    );
    // DATABASE_ENGINE=postgres overrides DB_ENGINE=sqlite
    await assertEngineRejection(
      seedCliScript,
      { DATABASE_ENGINE: 'postgres', DB_ENGINE: 'sqlite' },
      /SQLite database seeding is not supported when DATABASE_ENGINE=postgres/
    );
  });

  test('Default SQLite behavior when neither DATABASE_ENGINE nor DB_ENGINE is set', async () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.DATABASE_ENGINE;
    delete cleanEnv.DB_ENGINE;

    // In seed-cli, default SQLite mode requires --confirm-wipe (does not fail with unsupported engine)
    try {
      await execFileAsync(process.execPath, [seedCliScript], { env: cleanEnv });
      assert.fail('Expected seed-cli to require confirmation in default SQLite mode');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--confirm-wipe=/);
    }
  });

  // Strict primary variable definition precedence tests:
  // 1. DATABASE_ENGINE="" with DB_ENGINE=sqlite -> reject
  test('Strict precedence 1: DATABASE_ENGINE="" with DB_ENGINE=sqlite is rejected', async () => {
    await assertEngineRejection(backupScript, { DATABASE_ENGINE: '', DB_ENGINE: 'sqlite' }, /Unsupported database engine: ''/);
    await assertEngineRejection(seedCliScript, { DATABASE_ENGINE: '', DB_ENGINE: 'sqlite' }, /Unsupported database engine: ''/);
  });

  // 2. DATABASE_ENGINE=" " with DB_ENGINE=postgres -> reject
  test('Strict precedence 2: DATABASE_ENGINE=" " with DB_ENGINE=postgres is rejected', async () => {
    await assertEngineRejection(backupScript, { DATABASE_ENGINE: ' ', DB_ENGINE: 'postgres' }, /Unsupported database engine: ' '/);
    await assertEngineRejection(seedCliScript, { DATABASE_ENGINE: ' ', DB_ENGINE: 'postgres' }, /Unsupported database engine: ' '/);
  });

  // 3. DATABASE_ENGINE=sqlite with DB_ENGINE=postgres -> accept SQLite
  test('Strict precedence 3: DATABASE_ENGINE=sqlite with DB_ENGINE=postgres accepts SQLite', async () => {
    // backup executes SQLite backup
    const { stdout: backupOut } = await execFileAsync(
      process.execPath,
      ['--import', './tests/preload.js', backupScript],
      { cwd: repoRoot, env: { ...process.env, DATABASE_ENGINE: 'sqlite', DB_ENGINE: 'postgres' } }
    );
    assert.match(backupOut, /Backup written:/);

    // seed-cli enters SQLite mode and requires wipe confirmation
    try {
      await execFileAsync(process.execPath, [seedCliScript], {
        env: { ...process.env, DATABASE_ENGINE: 'sqlite', DB_ENGINE: 'postgres' }
      });
      assert.fail('Expected seed-cli to enter SQLite mode and require confirmation');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--confirm-wipe=/);
    }
  });

  // 4. DATABASE_ENGINE undefined with DB_ENGINE=postgres -> reject SQLite backup/seed
  test('Strict precedence 4: DATABASE_ENGINE undefined with DB_ENGINE=postgres rejects backup and seed', async () => {
    const cleanEnv = { ...process.env, DB_ENGINE: 'postgres' };
    delete cleanEnv.DATABASE_ENGINE;

    await assertEngineRejection(
      backupScript,
      cleanEnv,
      /SQLite backup is not supported when DATABASE_ENGINE=postgres/
    );
    await assertEngineRejection(
      seedCliScript,
      cleanEnv,
      /SQLite database seeding is not supported when DATABASE_ENGINE=postgres/
    );
  });
});
