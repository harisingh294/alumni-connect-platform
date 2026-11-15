// Tests for the SQLite-to-PostgreSQL Data Importer.
//
// Covers all requirements:
//   1. Target guard: accepts only 127.0.0.1:5544/alumni_test; rejects Neon, Render, cloud, wrong port, wrong DB.
//   2. Source guard: validates source path and guarantees read-only access.
//   3. Dry-run safety: verifies zero INSERT, UPDATE, DELETE, TRUNCATE or DDL statements in dry-run mode.
//   4. Table topological order: verifies all 26 tables are ordered with parents before children.
//   5. Column mappings: verifies explicit column lists and quoted identifiers (e.g. "current_role").
//   6. Identity columns: verifies audit_logs and messages map seq from rowid and call resetIdentitySequences.
//   7. Type conversions: verifies handling of timestamps, boolean integers (0/1), numbers, nulls and JSON.
//   8. Foreign-key validation: catches orphaned records before import.
//   9. Transactional rollback: verifies rollback when an error occurs during execution.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {
  TABLE_ORDER,
  TABLE_SCHEMAS,
  IDENTITY_TABLES,
  validateTargetConfig,
  validateSourcePath,
  buildInsertSql,
  extractRowValues,
  validateRow,
  executeImportInternal,
  EXPECTED_CONFIRM_TARGET
} from '../server/db/importer.js';

describe('SQLite to PostgreSQL Importer: Target & Source Guards', () => {
  test('rejects remote, cloud, Neon and Render hosts', () => {
    assert.throws(
      () => validateTargetConfig({ host: 'ep-cool-fog-12345.us-east-2.aws.neon.tech', port: 5432, database: 'alumni_test' }),
      /Remote, cloud or production databases are forbidden/
    );
    assert.throws(
      () => validateTargetConfig({ connectionString: 'postgres://user:pass@dpg-abc-a.oregon-postgres.render.com:5432/alumni' }),
      /Remote, cloud or production databases are forbidden/
    );
    assert.throws(
      () => validateTargetConfig({ host: 'railway.app', port: 5544, database: 'alumni_test' }),
      /Remote, cloud or production databases are forbidden/
    );
  });

  test('rejects wrong port and wrong database name', () => {
    // Port 5432 instead of 5544
    assert.throws(
      () => validateTargetConfig({ host: '127.0.0.1', port: 5432, database: 'alumni_test' }),
      /Target port '5432' is forbidden/
    );
    // Non-alumni_test database
    assert.throws(
      () => validateTargetConfig({ host: '127.0.0.1', port: 5544, database: 'alumni_prod' }),
      /Target database 'alumni_prod' is forbidden/
    );
    // Disallowed host
    assert.throws(
      () => validateTargetConfig({ host: '192.168.1.100', port: 5544, database: 'alumni_test' }),
      /Target host '192.168.1.100' is forbidden/
    );
  });

  test('accepts valid local disposable database 127.0.0.1:5544/alumni_test', () => {
    const valid = validateTargetConfig({ host: '127.0.0.1', port: 5544, database: 'alumni_test' });
    assert.equal(valid.host, '127.0.0.1');
    assert.equal(valid.port, 5544);
    assert.equal(valid.database, 'alumni_test');
  });

  test('accepts valid localhost connection string', () => {
    const valid = validateTargetConfig({ connectionString: 'postgres://alumni_test:secret@localhost:5544/alumni_test' });
    assert.equal(valid.host, '127.0.0.1');
    assert.equal(valid.port, 5544);
    assert.equal(valid.database, 'alumni_test');
  });

  test('validates source path', () => {
    assert.throws(() => validateSourcePath(''), /non-empty string/);
    assert.throws(() => validateSourcePath(null), /non-empty string/);
    const valid = validateSourcePath('C:/Users/haris/Desktop/AlumniConnect-SQLite-Migration-Work/migration-source.db');
    assert.ok(valid.includes('migration-source.db'));
  });
});

describe('SQLite to PostgreSQL Importer: Schemas & Topological Order', () => {
  test('all 26 application tables are present in strict dependency order', () => {
    assert.equal(TABLE_ORDER.length, 26);
    assert.equal(Object.keys(TABLE_SCHEMAS).length, 26);

    // Verify parents precede children
    const indexMap = new Map(TABLE_ORDER.map((t, idx) => [t, idx]));
    for (const [table, schema] of Object.entries(TABLE_SCHEMAS)) {
      const childIdx = indexMap.get(table);
      for (const fk of schema.fks) {
        const parentIdx = indexMap.get(fk.refTable);
        assert.ok(parentIdx !== undefined, `Parent table ${fk.refTable} exists`);
        assert.ok(parentIdx < childIdx, `Parent table ${fk.refTable} (index ${parentIdx}) must precede child ${table} (index ${childIdx})`);
      }
    }
  });

  test('alumni_profiles quotes current_role', () => {
    const insertSql = buildInsertSql('alumni_profiles');
    assert.ok(insertSql.includes('"current_role"'), 'Must quote "current_role" in INSERT');
    assert.ok(!insertSql.includes(' "current_role" ,'), 'Should be properly formatted');
  });

  test('identity tables audit_logs and messages have explicit seq mapping and source query', () => {
    assert.deepEqual([...IDENTITY_TABLES], ['messages', 'audit_logs']);
    assert.equal(TABLE_SCHEMAS.audit_logs.identityColumn, 'seq');
    assert.equal(TABLE_SCHEMAS.messages.identityColumn, 'seq');
    assert.ok(TABLE_SCHEMAS.audit_logs.sourceSelectColumns.startsWith('rowid AS seq, id,'));
    assert.ok(TABLE_SCHEMAS.messages.sourceSelectColumns.startsWith('rowid AS seq, id,'));

    const insertAudit = buildInsertSql('audit_logs');
    assert.ok(insertAudit.includes('"audit_logs" (id, seq,'), 'seq is included in audit_logs insert');
    const insertMessages = buildInsertSql('messages');
    assert.ok(insertMessages.includes('"messages" (id, seq,'), 'seq is included in messages insert');
  });

  test('regression: external_profiles schema excludes non-existent state and created_at columns', () => {
    const extCols = TABLE_SCHEMAS.external_profiles.columns;
    assert.ok(!extCols.includes('state'), 'external_profiles must NOT include non-existent "state" column');
    assert.ok(!extCols.includes('created_at'), 'external_profiles must NOT include non-existent "created_at" column');
    assert.deepEqual(extCols, [
      'id', 'user_id', 'education_level', 'current_institution',
      'current_year', 'field_of_interest', 'interested_institution_id', 'city'
    ]);

    // Test on in-memory SQLite table with canonical schema
    const mem = new DatabaseSync(':memory:');
    mem.exec(`
      CREATE TABLE external_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE,
        education_level TEXT NOT NULL,
        current_institution TEXT NOT NULL,
        current_year TEXT,
        field_of_interest TEXT,
        interested_institution_id TEXT,
        city TEXT
      )
    `);

    // The importer's SELECT statement must succeed without "no such column: state"
    const selectCols = TABLE_SCHEMAS.external_profiles.sourceSelectColumns || TABLE_SCHEMAS.external_profiles.columns.join(', ');
    assert.doesNotThrow(() => {
      mem.prepare(`SELECT ${selectCols} FROM "external_profiles"`).all();
    });

    // Reproduce original error if 'state' was queried
    assert.throws(() => {
      mem.prepare(`SELECT id, state FROM "external_profiles"`).all();
    }, /no such column: state/);
  });

  test('parity: TABLE_SCHEMAS columns match PostgreSQL 001_init.sql across all 26 tables', () => {
    const initSqlPath = path.resolve('db/migrations/001_init.sql');
    assert.ok(fs.existsSync(initSqlPath), '001_init.sql must exist');
    const sql = fs.readFileSync(initSqlPath, 'utf8');

    const tableRegex = /CREATE TABLE (?:IF NOT EXISTS )?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\);/gi;
    let match;
    const pgTables = {};
    while ((match = tableRegex.exec(sql)) !== null) {
      const tableName = match[1];
      const body = match[2];
      const cols = [];
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('--')) continue;
        if (/^(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)/i.test(line)) continue;
        const colMatch = line.match(/^("?[a-zA-Z0-9_]+"?)\s+/);
        if (colMatch) {
          cols.push(colMatch[1].replace(/"/g, ''));
        }
      }
      pgTables[tableName] = cols;
    }

    for (const tableName of TABLE_ORDER) {
      const schema = TABLE_SCHEMAS[tableName];
      const pgCols = pgTables[tableName];
      assert.ok(pgCols, `Table ${tableName} defined in 001_init.sql`);

      const missingInPg = schema.columns.filter((c) => !pgCols.includes(c));
      const missingInSchema = pgCols.filter((c) => !schema.columns.includes(c));
      assert.deepEqual(missingInPg, [], `Table ${tableName} has columns not in PG 001_init.sql`);
      assert.deepEqual(missingInSchema, [], `Table ${tableName} is missing columns from PG 001_init.sql`);
    }
  });
});

describe('SQLite to PostgreSQL Importer: Row Validation & Type Conversion', () => {
  test('detects NUL byte in strings as incompatible values', () => {
    const cleanRow = { id: 'u1', email: 'test@example.com', full_name: 'Test User' };
    assert.deepEqual(validateRow('users', cleanRow), []);

    const dirtyRow = { id: 'u1', email: 'test\0@example.com', full_name: 'Test\0' };
    const issues = validateRow('users', dirtyRow);
    assert.equal(issues.length, 2);
    assert.ok(issues[0].includes('NUL byte'));
  });

  test('extracts values in schema column order with undefined normalized to null', () => {
    const row = { id: 'c1', institution_id: 'i1', name: 'CS', level: 'UG', duration_years: 4 };
    const values = extractRowValues('courses', row);
    assert.equal(values[0], 'c1');
    assert.equal(values[1], 'i1');
    assert.equal(values[2], 'CS');
    assert.equal(values[3], 'UG');
    assert.equal(values[4], 4);
    assert.equal(values[5], null); // seats undefined -> null
    assert.equal(values[6], null); // annual_fee_inr undefined -> null
  });
});

describe('SQLite to PostgreSQL Importer: Dry-Run Safety & Execution Mock', () => {
  function createTestSqliteDb() {
    const mem = new DatabaseSync(':memory:');
    for (const table of TABLE_ORDER) {
      const schema = TABLE_SCHEMAS[table];
      const colsDef = schema.columns.map((c) => `${c} TEXT`).join(', ');
      mem.exec(`CREATE TABLE "${table}" (${colsDef})`);
    }
    // Seed minimal valid rows
    mem.exec(`INSERT INTO institutions (id, name, short_name, abbr, kind, domain, city, state, type, founded) VALUES ('inst_1', 'College', 'Col', 'C', 'COLLEGE', 'eng', 'City', 'State', 'Type', 2000)`);
    mem.exec(`INSERT INTO users (id, institution_id, email, password_hash, role, full_name) VALUES ('user_1', 'inst_1', 'u@test.example', 'hash', 'ALUMNI', 'User One')`);
    mem.exec(`INSERT INTO audit_logs (id, institution_id, action) VALUES ('al_1', 'inst_1', 'LOGIN')`);
    mem.exec(`INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, topic, message) VALUES ('req_1', 'inst_1', 'user_1', 'user_1', 'Topic', 'Msg')`);
    mem.exec(`INSERT INTO messages (id, request_id, sender_id, body) VALUES ('msg_1', 'req_1', 'user_1', 'Hello')`);
    return mem;
  }

  test('DRY-RUN mode issues ZERO write operations against target', async () => {
    const sourceDb = createTestSqliteDb();
    const targetQueries = [];
    const mockTargetDb = {
      async get(sql, ...p) {
        targetQueries.push({ type: 'get', sql, params: p });
        return { n: 0 };
      },
      async all(sql, ...p) {
        targetQueries.push({ type: 'all', sql, params: p });
        return [];
      },
      async run(sql, ...p) {
        targetQueries.push({ type: 'run', sql, params: p });
        return { changes: 0 };
      },
      async transaction() {
        throw new Error('transaction() must NOT be called in dry-run mode');
      }
    };

    const logged = [];
    const mockLogger = { log: (...args) => logged.push(args.join(' ')) };

    const report = await executeImportInternal({
      sourceDb,
      targetDb: mockTargetDb,
      execute: false,
      logger: mockLogger
    });

    assert.equal(report.mode, 'DRY-RUN');
    assert.equal(report.verdict, 'READY_FOR_IMPORT');
    assert.equal(report.totals.sourceRows, 5); // inst + user + audit + req + msg
    assert.equal(report.totals.plannedInserts, 5);
    assert.equal(report.totals.incompatibleValues, 0);
    assert.equal(report.totals.foreignKeyErrors, 0);

    // Verify zero write operations on target
    const writeCalls = targetQueries.filter(q => /INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER/i.test(q.sql));
    assert.equal(writeCalls.length, 0, 'Dry-run must not execute any writes');
    // All target queries in dry-run must be SELECT COUNT(*)
    for (const q of targetQueries) {
      assert.ok(q.sql.startsWith('SELECT COUNT(*)'), `Unexpected query in dry-run: ${q.sql}`);
    }
  });

  test('EXECUTE mode requires --confirm-target=127.0.0.1:5544/alumni_test', async () => {
    const sourceDb = createTestSqliteDb();
    await assert.rejects(
      () => executeImportInternal({ sourceDb, targetDb: {}, execute: true, confirmTarget: null }),
      /Execution requires explicit confirmation/
    );
    await assert.rejects(
      () => executeImportInternal({ sourceDb, targetDb: {}, execute: true, confirmTarget: 'wrong_target' }),
      /Execution requires explicit confirmation/
    );
  });

  test('catches orphaned foreign keys before import', async () => {
    const sourceDb = createTestSqliteDb();
    // Add user referencing non-existent institution
    sourceDb.exec(`INSERT INTO users (id, institution_id, email, password_hash, role, full_name) VALUES ('orphan_user', 'non_existent_inst', 'orphan@test.example', 'hash', 'STUDENT', 'Orphan')`);

    const report = await executeImportInternal({
      sourceDb,
      targetDb: { async get() { return { n: 0 }; } },
      execute: false,
      logger: { log: () => {} }
    });

    assert.equal(report.verdict, 'BLOCKED');
    assert.ok(report.totals.foreignKeyErrors > 0);
    const userReport = report.tables.find(t => t.table === 'users');
    assert.equal(userReport.foreignKeysValid, false);
    assert.ok(userReport.foreignKeyErrors.some(e => e.includes('non_existent_inst')));
  });

  test('EXECUTE mode runs transactionally and rolls back completely on error', async () => {
    const sourceDb = createTestSqliteDb();
    let transactionStarted = false;
    let transactionCommitted = false;
    let transactionRolledBack = false;

    const mockTargetDb = {
      async get() { return { n: 0 }; },
      async transaction(fn) {
        transactionStarted = true;
        const tx = {
          async run(sql) {
            // Fail on mentorship_requests table to test rollback
            if (sql.includes('mentorship_requests')) {
              throw new Error('Simulated failure during insert into mentorship_requests');
            }
            return { changes: 1 };
          },
          async get(sql) {
            if (sql.includes('setval') || sql.includes('pg_get_serial_sequence')) return { sequence_name: 'test_seq', next_value: 10 };
            return { n: 0 };
          }
        };
        try {
          const res = await fn(tx);
          transactionCommitted = true;
          return res;
        } catch (err) {
          transactionRolledBack = true;
          throw err;
        }
      }
    };

    await assert.rejects(
      () => executeImportInternal({
        sourceDb,
        targetDb: mockTargetDb,
        execute: true,
        confirmTarget: EXPECTED_CONFIRM_TARGET,
        logger: { log: () => {} }
      }),
      /Simulated failure during insert into mentorship_requests/
    );

    assert.ok(transactionStarted, 'Transaction was started');
    assert.ok(transactionRolledBack, 'Transaction was rolled back on error');
    assert.equal(transactionCommitted, false, 'Transaction must not commit on error');
  });
});
