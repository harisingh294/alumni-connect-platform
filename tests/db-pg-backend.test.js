// Unit tests for the PostgreSQL backend (server/db/pg-backend.js).
// These tests use mocks and fake clients; they do NOT require a PostgreSQL instance,
// Neon connection, network access, or credentials.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPgBackend,
  DEFAULT_POOL_CONFIG,
  parseBigInt,
  parseNumeric,
  resolveSslConfig,
  prepareSql
} from '../server/db/pg-backend.js';
import { createPgDb, TransactionClosedError, classifyDbError, isUniqueViolation, isRetryableDbError } from '../server/db/index.js';

function createMockPool(customQueryHandler = null) {
  const poolQueries = [];
  const clients = [];
  let totalCount = 1;
  let idleCount = 1;
  let waitingCount = 0;
  let ended = false;

  const defaultQueryHandler = async (sql, params) => {
    poolQueries.push({ sql, params });
    if (/^SELECT\s+1/i.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (/^INSERT\b/i.test(sql)) return { rows: [], rowCount: 1 };
    if (/^UPDATE\b/i.test(sql)) return { rows: [], rowCount: 2 };
    if (/^DELETE\b/i.test(sql)) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 0 };
  };

  const queryHandler = customQueryHandler || defaultQueryHandler;

  const pool = {
    totalCount,
    idleCount,
    waitingCount,
    get ended() { return ended; },
    get poolQueries() { return poolQueries; },
    get clients() { return clients; },
    on(event, fn) { /* no-op event listener */ return pool; },
    async query(sql, params = []) {
      poolQueries.push({ sql, params });
      return queryHandler(sql, params);
    },
    async connect() {
      const clientQueries = [];
      let released = false;
      const client = {
        get released() { return released; },
        get clientQueries() { return clientQueries; },
        async query(sql, params = []) {
          if (released) throw new Error('Client has already been released to the pool');
          clientQueries.push({ sql, params });
          return queryHandler(sql, params);
        },
        release() {
          if (released) throw new Error('Client release called multiple times');
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

describe('PostgreSQL Backend: Pool Configuration & SSL', () => {
  test('DEFAULT_POOL_CONFIG has expected safe limits', () => {
    assert.equal(DEFAULT_POOL_CONFIG.max, 10);
    assert.equal(DEFAULT_POOL_CONFIG.idleTimeoutMillis, 30000);
    assert.equal(DEFAULT_POOL_CONFIG.connectionTimeoutMillis, 5000);
  });

  test('resolveSslConfig detects Neon and sslmode=require', () => {
    assert.deepEqual(
      resolveSslConfig('postgres://user:pass@ep-cold-shadow-123.us-east-2.aws.neon.tech/neondb'),
      { rejectUnauthorized: true }
    );
    assert.deepEqual(
      resolveSslConfig('postgres://user:pass@pg.example.com/db?sslmode=require'),
      { rejectUnauthorized: true }
    );
    assert.deepEqual(
      resolveSslConfig('postgres://user:pass@pg.example.com/db?ssl=true'),
      { rejectUnauthorized: true }
    );
    assert.equal(
      resolveSslConfig('postgres://user:pass@localhost:5432/testdb'),
      undefined
    );
    assert.deepEqual(
      resolveSslConfig('postgres://localhost/db', { customCa: 'cert', rejectUnauthorized: true }),
      { customCa: 'cert', rejectUnauthorized: true }
    );
  });
});

describe('PostgreSQL Backend: Parameterized Queries & Preparation', () => {
  test('prepareSql translates ? placeholders to $1, $2, ...', () => {
    assert.equal(prepareSql('SELECT * FROM users WHERE id = ?'), 'SELECT * FROM users WHERE id = $1');
    assert.equal(
      prepareSql('SELECT * FROM users WHERE email = ? AND is_active = ?'),
      'SELECT * FROM users WHERE email = $1 AND is_active = $2'
    );
    assert.equal(prepareSql('SELECT 1'), 'SELECT 1');
    assert.equal(prepareSql('BEGIN'), 'BEGIN');
  });

  test('prepareSql rejects empty SQL or unsupported formats', () => {
    assert.throws(() => prepareSql(''), TypeError);
    assert.throws(() => prepareSql('   '), TypeError);
    assert.throws(() => prepareSql(null), TypeError);
  });
});

describe('PostgreSQL Backend: Result Behavior (get, all, run, query, exec)', () => {
  test('get returns first row or undefined', async () => {
    const mock = createMockPool(async (sql, params) => {
      if (params[0] === 'found') return { rows: [{ id: 'u1', name: 'Alice' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const backend = createPgBackend({ pool: mock });

    const row = await backend.get('SELECT * FROM users WHERE id = ?', ['found']);
    assert.deepEqual(row, { id: 'u1', name: 'Alice' });

    const notFound = await backend.get('SELECT * FROM users WHERE id = ?', ['missing']);
    assert.equal(notFound, undefined);
  });

  test('all returns array of rows or empty array', async () => {
    const mock = createMockPool(async (sql, params) => {
      if (params[0] === 'ALUMNI') return { rows: [{ id: 'a1' }, { id: 'a2' }], rowCount: 2 };
      return { rows: [], rowCount: 0 };
    });
    const backend = createPgBackend({ pool: mock });

    const rows = await backend.all('SELECT id FROM users WHERE role = ?', ['ALUMNI']);
    assert.deepEqual(rows, [{ id: 'a1' }, { id: 'a2' }]);

    const empty = await backend.all('SELECT id FROM users WHERE role = ?', ['NONE']);
    assert.deepEqual(empty, []);
  });

  test('run returns changes mapped from rowCount', async () => {
    const mock = createMockPool(async () => ({ rows: [], rowCount: 4 }));
    const backend = createPgBackend({ pool: mock });

    const res = await backend.run('UPDATE users SET is_active = 0');
    assert.deepEqual(res, { changes: 4 });
  });

  test('query returns { rows, rowCount } and exec runs statement', async () => {
    const mock = createMockPool(async () => ({ rows: [{ n: 1 }], rowCount: 1 }));
    const backend = createPgBackend({ pool: mock });

    const q = await backend.query('SELECT 1 AS n');
    assert.deepEqual(q, { rows: [{ n: 1 }], rowCount: 1 });

    await backend.exec('TRUNCATE table1; TRUNCATE table2;');
    assert.equal(mock.poolQueries[mock.poolQueries.length - 1].sql, 'TRUNCATE table1; TRUNCATE table2;');
  });

  test('facade createPgDb works with variadic parameter API', async () => {
    const mock = createMockPool(async (sql, params) => ({
      rows: [{ id: params[0], role: params[1] }],
      rowCount: 1
    }));
    const db = createPgDb({ pool: mock });

    const row = await db.get('SELECT * FROM users WHERE id = ? AND role = ?', 'u100', 'ADMIN');
    assert.deepEqual(row, { id: 'u100', role: 'ADMIN' });
    assert.equal(mock.poolQueries[0].sql, 'SELECT * FROM users WHERE id = $1 AND role = $2');
    assert.deepEqual(mock.poolQueries[0].params, ['u100', 'ADMIN']);
  });
});

describe('PostgreSQL Backend: Transaction Handling & Client Release', () => {
  test('transaction commits and releases client on success', async () => {
    const mock = createMockPool();
    const backend = createPgBackend({ pool: mock });

    const result = await backend.transaction(async (tx) => {
      await tx.run('INSERT INTO logs (msg) VALUES (?)', ['hello']);
      await tx.run('INSERT INTO logs (msg) VALUES (?)', ['world']);
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(mock.clients.length, 1);
    const client = mock.clients[0];
    assert.equal(client.released, true, 'client must be released after commit');

    const sqls = client.clientQueries.map((q) => q.sql);
    assert.deepEqual(sqls, [
      'BEGIN',
      'INSERT INTO logs (msg) VALUES ($1)',
      'INSERT INTO logs (msg) VALUES ($1)',
      'COMMIT'
    ]);
  });

  test('transaction rolls back and releases client on error', async () => {
    const mock = createMockPool();
    const backend = createPgBackend({ pool: mock });

    const err = new Error('simulated failure');
    await assert.rejects(
      async () => {
        await backend.transaction(async (tx) => {
          await tx.run('INSERT INTO logs (msg) VALUES (?)', ['test']);
          throw err;
        });
      },
      /simulated failure/
    );

    assert.equal(mock.clients.length, 1);
    const client = mock.clients[0];
    assert.equal(client.released, true, 'client must be released after rollback');

    const sqls = client.clientQueries.map((q) => q.sql);
    assert.deepEqual(sqls, [
      'BEGIN',
      'INSERT INTO logs (msg) VALUES ($1)',
      'ROLLBACK'
    ]);
  });

  test('transaction ops reject after transaction finished', async () => {
    const mock = createMockPool();
    const backend = createPgBackend({ pool: mock });

    let escapedOps;
    await backend.transaction(async (tx) => {
      escapedOps = tx;
      await tx.query('SELECT 1');
    });

    await assert.rejects(
      async () => escapedOps.query('SELECT 1'),
      TransactionClosedError
    );
    await assert.rejects(
      async () => escapedOps.run('UPDATE users SET x = 1'),
      TransactionClosedError
    );
  });

  test('nested transactions join the outer transaction', async () => {
    const mock = createMockPool();
    const backend = createPgBackend({ pool: mock });

    await backend.transaction(async (tx) => {
      await tx.run('UPDATE t SET v = 1');
      await backend.transaction(async (inner) => {
        await inner.run('UPDATE t SET v = 2');
      });
      await tx.run('UPDATE t SET v = 3');
    });

    assert.equal(mock.clients.length, 1, 'nested transaction must use the same single client');
    const sqls = mock.clients[0].clientQueries.map((q) => q.sql);
    assert.deepEqual(sqls, [
      'BEGIN',
      'UPDATE t SET v = 1',
      'UPDATE t SET v = 2',
      'UPDATE t SET v = 3',
      'COMMIT'
    ]);
  });
});

describe('PostgreSQL Backend: Safe BIGINT and NUMERIC Parsing', () => {
  test('parseBigInt parses safe numbers as Number', () => {
    assert.equal(parseBigInt('0'), 0);
    assert.equal(parseBigInt('42'), 42);
    assert.equal(parseBigInt('-100'), -100);
    assert.equal(parseBigInt(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
    assert.equal(parseBigInt(String(Number.MIN_SAFE_INTEGER)), Number.MIN_SAFE_INTEGER);
    assert.equal(parseBigInt(null), null);
    assert.equal(parseBigInt(undefined), null);
  });

  test('parseBigInt preserves BigInt when outside safe integer range', () => {
    const beyondMax = '9007199254740992'; // Number.MAX_SAFE_INTEGER + 1
    const beyondMin = '-9007199254740992'; // Number.MIN_SAFE_INTEGER - 1
    const int64Max = '9223372036854775807';

    assert.equal(parseBigInt(beyondMax), 9007199254740992n);
    assert.equal(typeof parseBigInt(beyondMax), 'bigint');
    assert.equal(parseBigInt(beyondMin), -9007199254740992n);
    assert.equal(typeof parseBigInt(beyondMin), 'bigint');
    assert.equal(parseBigInt(int64Max), 9223372036854775807n);
  });

  test('parseNumeric parses safe decimals as Number', () => {
    assert.equal(parseNumeric('0'), 0);
    assert.equal(parseNumeric('123.45'), 123.45);
    assert.equal(parseNumeric('-99.99'), -99.99);
    assert.equal(parseNumeric('100.00'), 100);
    assert.equal(parseNumeric(null), null);
  });

  test('parseNumeric preserves string when precision would be lost', () => {
    const hugeNumeric = '999999999999999999999999999999.99';
    assert.equal(parseNumeric(hugeNumeric), hugeNumeric);
    assert.equal(typeof parseNumeric(hugeNumeric), 'string');

    const highPrecision = '0.123456789012345678901234567890';
    assert.equal(parseNumeric(highPrecision), highPrecision);
    assert.equal(typeof parseNumeric(highPrecision), 'string');
  });
});

describe('PostgreSQL Backend: Connection & Error Classification', () => {
  test('classifyDbError recognizes PostgreSQL constraint and timeout errors', () => {
    const uniqueErr = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'users_email_key' });
    assert.equal(classifyDbError(uniqueErr).kind, 'unique');
    assert.equal(isUniqueViolation(uniqueErr), true);

    const fkErr = Object.assign(new Error('violates foreign key'), { code: '23503', constraint: 'fk_parent' });
    assert.equal(classifyDbError(fkErr).kind, 'foreign_key');

    const timeoutErr = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    assert.equal(classifyDbError(timeoutErr).kind, 'timeout');
    assert.equal(isRetryableDbError(timeoutErr), true);

    const connErr = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    assert.equal(classifyDbError(connErr).kind, 'connection');
    assert.equal(isRetryableDbError(connErr), true);
  });

  test('diagnostics and close work as expected', async () => {
    const mock = createMockPool();
    const backend = createPgBackend({ pool: mock, closeInjectedPool: true });

    const diag = backend.diagnostics();
    assert.equal(diag.kind, 'postgres');
    assert.equal(diag.pool.totalCount, 1);

    await backend.close();
    assert.equal(mock.ended, true);
  });
});
