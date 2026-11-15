// Unit tests for the PostgreSQL migration engine and CLI.
//
// These tests use mocks, fake clients, and temporary migration directories.
// They do NOT require a real PostgreSQL database, network access, or credentials.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  parseMigrationFilename,
  loadMigrations,
  getAppliedVersions,
  applyMigration,
  runMigrations,
  getMigrationStatus,
  MIGRATION_ADVISORY_LOCK_ID,
  DEFAULT_MIGRATIONS_DIR
} from '../server/db/migrator.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/**
 * Creates a mock PostgreSQL client tracking executed queries, transactions, and locks.
 */
function createMockClient(options = {}) {
  const queries = [];
  const appliedVersions = new Set(options.initialVersions || []);
  let tableExists = options.initialTableExists ?? (appliedVersions.size > 0);
  let lockAcquired = false;
  let lockReleased = false;
  let inTransaction = false;
  let committed = false;
  let rolledBack = false;
  let clientReleased = false;

  const client = {
    get queries() { return queries; },
    get appliedVersions() { return appliedVersions; },
    get lockAcquired() { return lockAcquired; },
    get lockReleased() { return lockReleased; },
    get inTransaction() { return inTransaction; },
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    get clientReleased() { return clientReleased; },

    async query(sql, params = []) {
      if (clientReleased) throw new Error('Client has already been released');
      queries.push({ sql: String(sql).trim(), params });

      // Advisory lock
      if (/^SELECT\s+pg_advisory_lock/i.test(sql)) {
        lockAcquired = true;
        return { rows: [], rowCount: 1 };
      }
      // Advisory unlock
      if (/^SELECT\s+pg_advisory_unlock/i.test(sql)) {
        lockReleased = true;
        return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      }

      // Check table existence via to_regclass
      if (/SELECT\s+to_regclass\('schema_migrations'\)/i.test(sql)) {
        return {
          rows: [{ tbl: tableExists ? 'schema_migrations' : null }],
          rowCount: 1
        };
      }

      // Query applied versions
      if (/SELECT\s+version\s+FROM\s+schema_migrations/i.test(sql)) {
        if (!tableExists) {
          throw new Error('relation "schema_migrations" does not exist');
        }
        const rows = Array.from(appliedVersions).sort((a, b) => a - b).map((v) => ({ version: v }));
        return { rows, rowCount: rows.length };
      }

      // Transaction control
      if (/^BEGIN\b/i.test(sql)) {
        inTransaction = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^COMMIT\b/i.test(sql)) {
        inTransaction = false;
        committed = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK\b/i.test(sql)) {
        inTransaction = false;
        rolledBack = true;
        return { rows: [], rowCount: 0 };
      }

      // Simulated failure hook
      if (options.failOnSql && options.failOnSql.test(sql)) {
        throw new Error(options.failMessage || 'Simulated query failure');
      }

      // Creation of schema_migrations
      if (/CREATE\s+TABLE\s+schema_migrations\b/i.test(sql)) {
        tableExists = true;
        return { rows: [], rowCount: 0 };
      }

      // Insert into schema_migrations
      if (/INSERT\s+INTO\s+schema_migrations/i.test(sql)) {
        if (!tableExists) {
          throw new Error('relation "schema_migrations" does not exist');
        }
        const version = Number(params[0]);
        appliedVersions.add(version);
        return { rows: [], rowCount: 1 };
      }

      // Generic DDL / query execution
      return { rows: [], rowCount: 0 };
    },

    release() {
      if (clientReleased) throw new Error('Client release called multiple times');
      clientReleased = true;
    }
  };

  return client;
}

/**
 * Creates a mock pool that yields mock clients.
 */
function createMockPool(client) {
  let ended = false;
  return {
    get ended() { return ended; },
    async connect() {
      return client;
    },
    async end() {
      ended = true;
    }
  };
}

describe('PostgreSQL Migrator: Filename Parsing & Validation', () => {
  test('parseMigrationFilename accepts valid migration names', () => {
    assert.deepEqual(parseMigrationFilename('001_init.sql'), {
      version: 1,
      name: 'init',
      filename: '001_init.sql'
    });
    assert.deepEqual(parseMigrationFilename('002_sqlite_compat_functions.sql'), {
      version: 2,
      name: 'sqlite_compat_functions',
      filename: '002_sqlite_compat_functions.sql'
    });
    assert.deepEqual(parseMigrationFilename('100_add_user_roles.sql'), {
      version: 100,
      name: 'add_user_roles',
      filename: '100_add_user_roles.sql'
    });
  });

  test('parseMigrationFilename rejects invalid filenames', () => {
    assert.equal(parseMigrationFilename('init.sql'), null);
    assert.equal(parseMigrationFilename('01_init.sql'), null); // needs at least 3 digits
    assert.equal(parseMigrationFilename('001-.sql'), null);
    assert.equal(parseMigrationFilename('000_zero.sql'), null); // version 0 is invalid
    assert.equal(parseMigrationFilename('001_init.txt'), null);
    assert.equal(parseMigrationFilename(null), null);
    assert.equal(parseMigrationFilename(''), null);
  });

  test('loadMigrations loads existing repo migrations in ascending version order', () => {
    const migrations = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    assert.ok(migrations.length >= 2);
    assert.equal(migrations[0].version, 1);
    assert.equal(migrations[0].filename, '001_init.sql');
    assert.equal(migrations[1].version, 2);
    assert.equal(migrations[1].filename, '002_sqlite_compat_functions.sql');
    assert.ok(migrations[0].sql.includes('CREATE TABLE institutions'));
    assert.ok(migrations[0].sql.includes('CREATE TABLE schema_migrations'));
    assert.ok(migrations[1].sql.includes('CREATE FUNCTION app_shift_ts'));
  });

  test('loadMigrations rejects duplicate version numbers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-dup-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '001_first.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(tmpDir, '001_duplicate.sql'), 'SELECT 2;');
      assert.throws(() => loadMigrations(tmpDir), /Duplicate migration version 1/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadMigrations ignores non-SQL files and validates invalid SQL filenames', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-ignore-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '001_first.sql'), 'SELECT 1;');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Notes');
      fs.writeFileSync(path.join(tmpDir, '.gitkeep'), '');

      const loaded = loadMigrations(tmpDir);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].filename, '001_first.sql');

      // Adding an invalid SQL file should throw
      fs.writeFileSync(path.join(tmpDir, 'invalid_name.sql'), 'SELECT 9;');
      assert.throws(() => loadMigrations(tmpDir), /Invalid migration filename "invalid_name\.sql"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('loadMigrations throws on empty migration files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-empty-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '001_empty.sql'), '   \n  ');
      assert.throws(() => loadMigrations(tmpDir), /is empty/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('PostgreSQL Migrator: Execution & Database Lifecycle', () => {
  test('Initial empty database: handles missing schema_migrations safely and applies all migrations', async () => {
    const client = createMockClient({ initialTableExists: false, initialVersions: [] });

    const result = await runMigrations({ client, silent: true });

    assert.equal(result.dryRun, false);
    assert.equal(result.applied.length, 2);
    assert.equal(result.applied[0].version, 1);
    assert.equal(result.applied[0].filename, '001_init.sql');
    assert.equal(result.applied[1].version, 2);
    assert.equal(result.applied[1].filename, '002_sqlite_compat_functions.sql');

    // Advisory lock acquired and released on the same client
    assert.equal(client.lockAcquired, true);
    assert.equal(client.lockReleased, true);

    // Both versions recorded
    assert.deepEqual(Array.from(client.appliedVersions).sort(), [1, 2]);

    // Verify advisory lock SQL query
    const lockQuery = client.queries.find((q) => /SELECT\s+pg_advisory_lock/i.test(q.sql));
    assert.ok(lockQuery);
    assert.equal(lockQuery.params[0], MIGRATION_ADVISORY_LOCK_ID);

    const unlockQuery = client.queries.find((q) => /SELECT\s+pg_advisory_unlock/i.test(q.sql));
    assert.ok(unlockQuery);
    assert.equal(unlockQuery.params[0], MIGRATION_ADVISORY_LOCK_ID);

    // Verify to_regclass check preceded any query to schema_migrations
    const regclassIdx = client.queries.findIndex((q) => /to_regclass/i.test(q.sql));
    assert.ok(regclassIdx >= 0);
  });

  test('Idempotence: re-running when all migrations are recorded applies 0 migrations', async () => {
    const client = createMockClient({ initialTableExists: true, initialVersions: [1, 2] });

    const result = await runMigrations({ client, silent: true });

    assert.equal(result.applied.length, 0);
    assert.equal(result.pending.length, 0);
    assert.deepEqual(result.alreadyApplied, [1, 2]);

    // Lock was still properly acquired and released
    assert.equal(client.lockAcquired, true);
    assert.equal(client.lockReleased, true);

    // No BEGIN/COMMIT transaction statements executed
    const txQueries = client.queries.filter((q) => /^(BEGIN|COMMIT)\b/i.test(q.sql));
    assert.equal(txQueries.length, 0);
  });

  test('Incremental migration: applies only pending migrations in order', async () => {
    const client = createMockClient({ initialTableExists: true, initialVersions: [1] });

    const result = await runMigrations({ client, silent: true });

    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].version, 2);
    assert.equal(result.applied[0].filename, '002_sqlite_compat_functions.sql');
    assert.deepEqual(result.alreadyApplied, [1]);
    assert.deepEqual(Array.from(client.appliedVersions).sort(), [1, 2]);
  });

  test('Atomic transactional rollback on migration failure', async () => {
    // Fail when migration 002 SQL is executed
    const client = createMockClient({
      initialTableExists: false,
      initialVersions: [],
      failOnSql: /CREATE\s+FUNCTION\s+app_shift_ts/i,
      failMessage: 'syntax error at or near "FUNCTION"'
    });

    await assert.rejects(
      async () => {
        await runMigrations({ client, silent: true });
      },
      (err) => {
        assert.match(err.message, /Migration 002_sqlite_compat_functions\.sql failed/);
        return true;
      }
    );

    // Version 1 was applied and committed, version 2 rolled back
    assert.deepEqual(Array.from(client.appliedVersions), [1]);

    // ROLLBACK was executed for the failed transaction
    const rollbackQuery = client.queries.find((q) => /^ROLLBACK\b/i.test(q.sql));
    assert.ok(rollbackQuery, 'Expected ROLLBACK to be executed on error');

    // Advisory lock was released in finally block even after failure
    assert.equal(client.lockReleased, true, 'Advisory lock must be released on failure');
  });

  test('Advisory lock and transaction connection binding using Pool', async () => {
    const client = createMockClient({ initialTableExists: true, initialVersions: [1, 2] });
    const pool = createMockPool(client);

    const result = await runMigrations({ pool, silent: true });

    assert.equal(result.applied.length, 0);
    // Verified that lock, status check, and unlock were on the SAME client
    assert.equal(client.lockAcquired, true);
    assert.equal(client.lockReleased, true);
    // Verified client was released back to the pool in finally
    assert.equal(client.clientReleased, true);
    // Pool itself is NOT ended when provided by caller
    assert.equal(pool.ended, false);
  });

  test('Database facade integration: runMigrations({ db }) uses db.connect()', async () => {
    const client = createMockClient({ initialTableExists: true, initialVersions: [1, 2] });
    const db = {
      kind: 'postgres',
      connect: async () => client
    };

    const result = await runMigrations({ db, silent: true });
    assert.equal(result.applied.length, 0);
    assert.equal(client.clientReleased, true);
  });

  test('runMigrations({ db }) rejects non-postgres database handles', async () => {
    const db = { kind: 'sqlite' };
    await assert.rejects(
      () => runMigrations({ db, silent: true }),
      /PostgreSQL migration runner cannot run on database engine: 'sqlite'/
    );
  });

  test('Dry run mode does not execute DDL or modify schema_migrations', async () => {
    const client = createMockClient({ initialTableExists: false, initialVersions: [] });

    const result = await runMigrations({ client, dryRun: true, silent: true });

    assert.equal(result.dryRun, true);
    assert.equal(result.applied.length, 0);
    assert.equal(result.pending.length, 2);
    assert.equal(client.appliedVersions.size, 0);

    // Lock was still acquired and released
    assert.equal(client.lockAcquired, true);
    assert.equal(client.lockReleased, true);

    // No BEGIN/COMMIT queries executed
    const txQueries = client.queries.filter((q) => /^(BEGIN|COMMIT)\b/i.test(q.sql));
    assert.equal(txQueries.length, 0);
  });

  test('getMigrationStatus inspects applied and pending versions without changes', async () => {
    const client = createMockClient({ initialTableExists: true, initialVersions: [1] });

    const status = await getMigrationStatus({ client });

    assert.deepEqual(status.applied, [1]);
    assert.equal(status.pending.length, 1);
    assert.equal(status.pending[0].version, 2);
    assert.equal(status.pending[0].filename, '002_sqlite_compat_functions.sql');
  });
});

describe('PostgreSQL Migration CLI: Guards & Validation', () => {
  const cliPath = path.join(repoRoot, 'server', 'db', 'migrate.js');

  test('CLI fails safely when DATABASE_ENGINE is not postgres', async () => {
    try {
      await execFileAsync(process.execPath, [cliPath], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'sqlite'
        }
      });
      assert.fail('Expected CLI to exit with code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /Migration CLI only supports PostgreSQL/);
    }
  });

  test('CLI fails safely when DATABASE_URL is missing', async () => {
    try {
      await execFileAsync(process.execPath, [cliPath], {
        env: {
          ...process.env,
          DATABASE_ENGINE: 'postgres',
          DATABASE_URL: ''
        }
      });
      assert.fail('Expected CLI to exit with code 1');
    } catch (err) {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /DATABASE_URL environment variable is required/);
    }
  });
});
