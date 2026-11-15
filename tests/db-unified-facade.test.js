// Contract and parity tests for the Unified Database Facade (server/db/index.js).
// Validates identical API signatures, return shapes, transaction semantics, error
// behavior, parameter validation, and explicit engine selection across both
// SQLite (using disposable temp file) and PostgreSQL (using mock pool).
// No real PostgreSQL server, Neon instance, or network access is required.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createUnifiedDb,
  createDatabase,
  resolveDatabaseEngine,
  createSqliteDb,
  createPgDb,
  TransactionClosedError
} from '../server/db/index.js';

function createMockPgPool(customHandler = null) {
  const poolQueries = [];
  const clients = [];
  let totalCount = 1;
  let idleCount = 1;
  let waitingCount = 0;
  let ended = false;

  const defaultHandler = async (sql, params) => {
    if (/^SELECT\s+1\b/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/^SELECT\s+\*\s+FROM\s+item/i.test(sql)) {
      if (params && params[0] === 'a') return { rows: [{ id: 'a', name: 'alpha', qty: 3 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT\b/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/^UPDATE\b/i.test(sql)) return { rows: [], rowCount: 2 };
    if (/^DELETE\b/i.test(sql)) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 0 };
  };

  const handler = customHandler || defaultHandler;

  const pool = {
    totalCount,
    idleCount,
    waitingCount,
    get ended() { return ended; },
    get poolQueries() { return poolQueries; },
    get clients() { return clients; },
    on() { return pool; },
    async query(sql, params = []) {
      poolQueries.push({ sql, params });
      return handler(sql, params);
    },
    async connect() {
      const clientQueries = [];
      let released = false;
      const client = {
        get released() { return released; },
        get clientQueries() { return clientQueries; },
        async query(sql, params = []) {
          if (released) throw new Error('Client released');
          clientQueries.push({ sql, params });
          return handler(sql, params);
        },
        release() {
          if (released) throw new Error('Client double release');
          released = true;
        }
      };
      clients.push(client);
      return client;
    },
    async end() {
      ended = true;
    }
  };

  return pool;
}

const SQLITE_SCHEMA = `
  CREATE TABLE item (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 0
  );
`;

async function withTempSqliteDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alumni-unified-sqlite-'));
  const database = new DatabaseSync(path.join(dir, 'test.db'));
  database.exec(SQLITE_SCHEMA);
  const db = createUnifiedDb({ engine: 'sqlite', database });
  try {
    return await fn(db, database);
  } finally {
    try { database.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Unified Facade: Explicit Backend Selection', () => {
  test('disallows silent fallback to postgres merely because DATABASE_URL is set', () => {
    const fakeEnv = { DATABASE_URL: 'postgres://user:pass@localhost/db' };
    assert.throws(
      () => resolveDatabaseEngine({}, fakeEnv),
      /Database engine must be explicitly configured as 'sqlite' or 'postgres'/
    );
    assert.throws(
      () => createUnifiedDb({}, fakeEnv),
      /Database engine must be explicitly configured as 'sqlite' or 'postgres'/
    );
  });

  test('accepts explicit config { engine: "sqlite" } and { engine: "postgres" }', () => {
    assert.equal(resolveDatabaseEngine({ engine: 'sqlite' }), 'sqlite');
    assert.equal(resolveDatabaseEngine({ engine: 'postgres' }), 'postgres');
    assert.equal(resolveDatabaseEngine({ engine: 'postgresql' }), 'postgres');
    assert.equal(resolveDatabaseEngine({ driver: 'sqlite' }), 'sqlite');
  });

  test('accepts explicit DATABASE_ENGINE in environment', () => {
    assert.equal(resolveDatabaseEngine({}, { DATABASE_ENGINE: 'postgres' }), 'postgres');
    assert.equal(resolveDatabaseEngine({}, { DB_ENGINE: 'sqlite' }), 'sqlite');
  });

  test('rejects unsupported database engines safely', () => {
    assert.throws(() => resolveDatabaseEngine({ engine: 'mysql' }), /Unsupported database engine: 'mysql'/);
    assert.throws(() => resolveDatabaseEngine({ engine: 'oracle' }), /Unsupported database engine: 'oracle'/);
  });

  test('fails safely if required connection parameters are missing', () => {
    assert.throws(
      () => createUnifiedDb({ engine: 'sqlite' }),
      /SQLite engine selected, but no 'database' instance was provided/
    );
    assert.throws(
      () => createUnifiedDb({ engine: 'postgres' }, {}),
      /PostgreSQL engine selected, but no 'connectionString', 'pool', or DATABASE_URL was provided/
    );
  });

  test('createDatabase is an alias for createUnifiedDb', () => {
    assert.equal(createDatabase, createUnifiedDb);
  });
});

describe('Unified Facade: Parity of Method Signatures and Return Shapes', () => {
  test('both backends expose the identical surface and method signatures', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      const mockPool = createMockPgPool();
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

      const requiredMethods = ['get', 'all', 'run', 'query', 'exec', 'transaction', 'diagnostics', 'close'];
      for (const m of requiredMethods) {
        assert.equal(typeof sqliteDb[m], 'function', `sqliteDb missing ${m}`);
        assert.equal(typeof pgDb[m], 'function', `pgDb missing ${m}`);
      }

      assert.equal(sqliteDb.kind, 'sqlite');
      assert.equal(pgDb.kind, 'postgres');
    });
  });

  test('get, all, run, query, exec return identical shapes across both engines', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      // Seed SQLite
      await sqliteDb.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', 'a', 'alpha', 3);

      const mockPool = createMockPgPool(async (sql, params) => {
        if (/SELECT \* FROM item WHERE id =/i.test(sql)) {
          if (params && params[0] === 'a') return { rows: [{ id: 'a', name: 'alpha', qty: 3 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
        if (/SELECT \* FROM item ORDER BY id/i.test(sql)) {
          return { rows: [{ id: 'a', name: 'alpha', qty: 3 }], rowCount: 1 };
        }
        if (/UPDATE item/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/SELECT 1/i.test(sql)) {
          return { rows: [{ n: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

      // 1. get()
      const rowSqlite = await sqliteDb.get('SELECT * FROM item WHERE id = ?', 'a');
      const rowPg = await pgDb.get('SELECT * FROM item WHERE id = ?', 'a');
      assert.deepEqual(rowSqlite, { id: 'a', name: 'alpha', qty: 3 });
      assert.deepEqual(rowPg, { id: 'a', name: 'alpha', qty: 3 });
      assert.equal(Object.getPrototypeOf(rowSqlite), Object.prototype);
      assert.equal(Object.getPrototypeOf(rowPg), Object.prototype);

      const emptySqlite = await sqliteDb.get('SELECT * FROM item WHERE id = ?', 'missing');
      const emptyPg = await pgDb.get('SELECT * FROM item WHERE id = ?', 'missing');
      assert.equal(emptySqlite, undefined);
      assert.equal(emptyPg, undefined);

      // 2. all()
      const allSqlite = await sqliteDb.all('SELECT * FROM item ORDER BY id');
      const allPg = await pgDb.all('SELECT * FROM item ORDER BY id');
      assert.deepEqual(allSqlite, [{ id: 'a', name: 'alpha', qty: 3 }]);
      assert.deepEqual(allPg, [{ id: 'a', name: 'alpha', qty: 3 }]);

      // 3. run()
      const runSqlite = await sqliteDb.run('UPDATE item SET qty = ? WHERE id = ?', 5, 'a');
      const runPg = await pgDb.run('UPDATE item SET qty = ? WHERE id = ?', 5, 'a');
      assert.deepEqual(runSqlite, { changes: 1 });
      assert.deepEqual(runPg, { changes: 1 });

      // 4. query()
      const qSqlite = await sqliteDb.query('SELECT 1 AS n');
      const qPg = await pgDb.query('SELECT 1 AS n');
      assert.deepEqual(qSqlite, { rows: [{ n: 1 }], rowCount: 1 });
      assert.deepEqual(qPg, { rows: [{ n: 1 }], rowCount: 1 });
    });
  });
});

describe('Unified Facade: Parameter Validation Consistency', () => {
  test('both backends reject undefined, boolean, and non-buffer objects up front', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      const mockPool = createMockPgPool();
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

      for (const db of [sqliteDb, pgDb]) {
        await assert.rejects(
          () => db.get('SELECT * FROM item WHERE id = ?', undefined),
          /SQL parameter 1 is undefined/
        );
        await assert.rejects(
          () => db.get('SELECT * FROM item WHERE id = ?', true),
          /SQL parameter 1 is a boolean; use 1 or 0/
        );
        await assert.rejects(
          () => db.get('SELECT * FROM item WHERE id = ?', { bad: 'object' }),
          /SQL parameter 1 is an object/
        );
      }
    });
  });
});

describe('Unified Facade: Transaction Semantics & Parity', () => {
  test('transaction callbacks receive the identical API on both backends', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      const mockPool = createMockPgPool();
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

      const checkTxApi = async (db) => {
        return db.transaction(async (tx) => {
          for (const m of ['get', 'all', 'run', 'query', 'exec', 'transaction', 'assertOpen']) {
            assert.equal(typeof tx[m], 'function', `tx missing ${m}`);
          }
          return 'ok';
        });
      };

      assert.equal(await checkTxApi(sqliteDb), 'ok');
      assert.equal(await checkTxApi(pgDb), 'ok');
    });
  });

  test('transaction commit and rollback parity', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      const mockPool = createMockPgPool();
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

      // Commit
      const resSqlite = await sqliteDb.transaction(async (tx) => {
        await tx.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', 'c1', 'comm1', 1);
        return 'committed-sqlite';
      });
      const resPg = await pgDb.transaction(async (tx) => {
        await tx.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', 'c2', 'comm2', 2);
        return 'committed-pg';
      });
      assert.equal(resSqlite, 'committed-sqlite');
      assert.equal(resPg, 'committed-pg');

      // Verify SQLite kept the row
      const savedRow = await sqliteDb.get('SELECT * FROM item WHERE id = ?', 'c1');
      assert.equal(savedRow.id, 'c1');

      // Rollback
      const fail = new Error('deliberate abort');
      await assert.rejects(() => sqliteDb.transaction(async (tx) => {
        await tx.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', 'r1', 'roll1', 1);
        throw fail;
      }), /deliberate abort/);

      await assert.rejects(() => pgDb.transaction(async (tx) => {
        await tx.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', 'r2', 'roll2', 2);
        throw fail;
      }), /deliberate abort/);

      // Verify SQLite rolled back the write
      const rolledRow = await sqliteDb.get('SELECT * FROM item WHERE id = ?', 'r1');
      assert.equal(rolledRow, undefined);
    });
  });

  test('tx operations reject after transaction has finished on both backends', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      const mockPool = createMockPgPool();
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

      let leakedSqliteTx;
      await sqliteDb.transaction(async (tx) => { leakedSqliteTx = tx; });
      await assert.rejects(() => leakedSqliteTx.run('SELECT 1'), TransactionClosedError);

      let leakedPgTx;
      await pgDb.transaction(async (tx) => { leakedPgTx = tx; });
      await assert.rejects(() => leakedPgTx.run('SELECT 1'), TransactionClosedError);
    });
  });
});

describe('Unified Facade: Internal Column Filtering', () => {
  test('PostgreSQL strips internal seq column but preserves user-defined alias named seq', async () => {
    const mockPool = createMockPgPool(async () => {
      return {
        rows: [{ id: 'm1', body: 'hello', seq: 100 }],
        rowCount: 1,
        fields: [
          { name: 'id', table: 'messages', column: 'id' },
          { name: 'body', table: 'messages', column: 'body' },
          { name: 'seq', table: 'messages', column: 'seq' } // internal identity column
        ]
      };
    });
    const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool });

    // When every occurrence of seq is messages.seq, it is stripped
    const row = await pgDb.get('SELECT * FROM messages WHERE id = ?', 'm1');
    assert.deepEqual(row, { id: 'm1', body: 'hello' });
    assert.equal('seq' in row, false);

    // When seq is an alias (table is null), it is preserved
    const mockPoolWithAlias = createMockPgPool(async () => {
      return {
        rows: [{ id: 'm1', body: 'hello', seq: 1 }],
        rowCount: 1,
        fields: [
          { name: 'id', table: 'messages', column: 'id' },
          { name: 'body', table: 'messages', column: 'body' },
          { name: 'seq', table: null, column: null } // computed alias
        ]
      };
    });
    const pgDbAlias = createUnifiedDb({ engine: 'postgres', pool: mockPoolWithAlias });
    const rowAlias = await pgDbAlias.get('SELECT id, body, 1 AS seq FROM messages');
    assert.deepEqual(rowAlias, { id: 'm1', body: 'hello', seq: 1 });
  });
});

describe('Unified Facade: Resource Management & Diagnostics', () => {
  test('close is idempotent and diagnostics reports kind and status', async () => {
    await withTempSqliteDb(async (sqliteDb) => {
      const mockPool = createMockPgPool();
      const pgDb = createUnifiedDb({ engine: 'postgres', pool: mockPool, closeInjectedPool: true });

      assert.equal(sqliteDb.diagnostics().transaction, null);
      assert.equal(pgDb.diagnostics().kind, 'postgres');

      await pgDb.close();
      await pgDb.close(); // idempotent
      assert.equal(mockPool.ended, true);
    });
  });
});
