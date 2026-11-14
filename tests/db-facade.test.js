// Contract tests for the async database facade (server/db/index.js) over the SQLite backend.
// Every database here is a throwaway file in a fresh directory under the OS temp folder. This file
// never imports server/db.js, so it can never open the application's database.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDb, createSqliteDb, createSqliteBackend, checkParams, classifyDbError, TransactionClosedError } from '../server/db/index.js';
import * as facadeModule from '../server/db/index.js';

const SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE parent (id TEXT PRIMARY KEY);
  CREATE TABLE item (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES parent(id),
    name TEXT NOT NULL UNIQUE,
    qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
    note TEXT
  );
`;

// Opens a temporary database, runs fn(db), and always closes and removes it.
async function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alumni-connect-facadetest-'));
  const database = new DatabaseSync(path.join(dir, 'facade.db'));
  database.exec(SCHEMA);
  const db = createSqliteDb(database);
  try {
    return await fn(db, database);
  } finally {
    try { database.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const insertItem = (db, id, name = id, qty = 0) => db.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', id, name, qty);
const countItems = async (db) => (await db.get('SELECT COUNT(*) AS n FROM item')).n;

describe('reads and writes', () => {
  test('get returns undefined for no row, otherwise a plain object', async () => {
    await withDb(async (db) => {
      assert.equal(await db.get('SELECT * FROM item WHERE id = ?', 'nope'), undefined);
      await insertItem(db, 'a', 'alpha', 3);
      const row = await db.get('SELECT * FROM item WHERE id = ?', 'a');
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.deepEqual(row, { id: 'a', parent_id: null, name: 'alpha', qty: 3, note: null });
    });
  });

  test('all returns an array of plain objects, empty when nothing matches', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await db.all('SELECT * FROM item'), []);
      await insertItem(db, 'a');
      await insertItem(db, 'b');
      const rows = await db.all('SELECT id FROM item ORDER BY id');
      assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }]);
      assert.ok(rows.every((r) => Object.getPrototypeOf(r) === Object.prototype));
    });
  });

  test('run reports the number of rows changed', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await insertItem(db, 'a'), { changes: 1 });
      await insertItem(db, 'b');
      assert.deepEqual(await db.run('UPDATE item SET qty = 5'), { changes: 2 });
      assert.deepEqual(await db.run('UPDATE item SET qty = 1 WHERE id = ?', 'none'), { changes: 0 });
      assert.deepEqual(await db.run('DELETE FROM item WHERE id = ?', 'a'), { changes: 1 });
    });
  });

  test('query returns { rows, rowCount } for reads, writes and RETURNING', async () => {
    await withDb(async (db) => {
      assert.deepEqual(await db.query('SELECT * FROM item'), { rows: [], rowCount: 0 });
      assert.deepEqual(await db.query('INSERT INTO item (id, name) VALUES (?, ?)', 'a', 'alpha'), { rows: [], rowCount: 1 });
      assert.deepEqual(await db.query('SELECT id FROM item'), { rows: [{ id: 'a' }], rowCount: 1 });
      const returning = await db.query('UPDATE item SET qty = 9 WHERE id = ? RETURNING id, qty', 'a');
      assert.deepEqual(returning, { rows: [{ id: 'a', qty: 9 }], rowCount: 1 });
    });
  });

  test('exec runs several statements', async () => {
    await withDb(async (db) => {
      await db.exec("INSERT INTO item (id, name) VALUES ('x', 'ex'); INSERT INTO item (id, name) VALUES ('y', 'why');");
      assert.equal(await countItems(db), 2);
    });
  });

  test('null parameters work, and repeated statements (cached) keep working after a schema change', async () => {
    await withDb(async (db) => {
      await db.run('INSERT INTO item (id, name, note) VALUES (?, ?, ?)', 'a', 'alpha', null);
      for (let i = 0; i < 3; i++) assert.equal((await db.get('SELECT note FROM item WHERE id = ?', 'a')).note, null);
      await db.exec('DROP TABLE item; CREATE TABLE item (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, note TEXT, extra TEXT);');
      assert.equal(await db.get('SELECT note FROM item WHERE id = ?', 'a'), undefined);
      await db.run('INSERT INTO item (id, name, extra) VALUES (?, ?, ?)', 'b', 'beta', 'x');
      assert.equal((await db.get('SELECT extra FROM item WHERE id = ?', 'b')).extra, 'x');
    });
  });
});

describe('parameter rules', () => {
  test('undefined, booleans, objects and functions are rejected before any SQL runs', async () => {
    await withDb(async (db) => {
      for (const bad of [undefined, true, false, {}, [], () => 1, Symbol('x')]) {
        await assert.rejects(db.run('INSERT INTO item (id, name) VALUES (?, ?)', 'a', bad), TypeError);
      }
      assert.equal(await countItems(db), 0);
      await assert.rejects(db.get('', 1), /non-empty string/);
      await assert.rejects(db.get(42), /non-empty string/);
    });
  });

  test('checkParams accepts strings, numbers, bigints, buffers and null', () => {
    assert.deepEqual(checkParams(['a', 1, 2n, Buffer.from('x'), null, 1.5]).length, 6);
    assert.throws(() => checkParams(['a', undefined]), /parameter 2 is undefined/);
    assert.throws(() => checkParams([true]), /parameter 1 is a boolean/);
  });
});

describe('transactions', () => {
  test('commit keeps the changes and returns the callback result', async () => {
    await withDb(async (db) => {
      const result = await db.transaction(async (tx) => {
        await insertItem(tx, 'a');
        await insertItem(tx, 'b');
        return 'done';
      });
      assert.equal(result, 'done');
      assert.equal(await countItems(db), 2);
    });
  });

  test('an error rolls everything back and the same error object is rethrown', async () => {
    await withDb(async (db) => {
      const boom = new Error('boom');
      await assert.rejects(db.transaction(async (tx) => { await insertItem(tx, 'a'); throw boom; }), (err) => err === boom);
      assert.equal(await countItems(db), 0);
      // A database error inside the transaction also rolls back the earlier statement.
      await assert.rejects(db.transaction(async (tx) => {
        await insertItem(tx, 'a', 'same');
        await insertItem(tx, 'b', 'same');
      }), (err) => classifyDbError(err).kind === 'unique');
      assert.equal(await countItems(db), 0);
      // A synchronous throw before any await is handled too, and the database is still usable.
      await assert.rejects(db.transaction(() => { throw new Error('early'); }), /early/);
      await insertItem(db, 'ok');
      assert.equal(await countItems(db), 1);
    });
  });

  test('root calls made inside the callback join the transaction (and do not deadlock)', async () => {
    await withDb(async (db) => {
      await assert.rejects(db.transaction(async () => {
        await insertItem(db, 'a'); // root facade, not the tx argument
        assert.equal(await countItems(db), 1);
        throw new Error('undo');
      }), /undo/);
      assert.equal(await countItems(db), 0);
    });
  });

  test('a nested transaction joins the outer one', async () => {
    await withDb(async (db) => {
      await assert.rejects(db.transaction(async (tx) => {
        await insertItem(tx, 'outer');
        await tx.transaction(async (inner) => { await insertItem(inner, 'inner'); });
        throw new Error('outer fails');
      }), /outer fails/);
      assert.equal(await countItems(db), 0, 'the inner work was rolled back with the outer transaction');
    });
  });

  test('transactions run one at a time, in order', async () => {
    await withDb(async (db) => {
      const log = [];
      const t1 = db.transaction(async (tx) => {
        log.push('t1 start');
        await insertItem(tx, 't1');
        await sleep(40);
        log.push('t1 end');
      });
      const t2 = db.transaction(async (tx) => {
        log.push('t2 start');
        await insertItem(tx, 't2');
        log.push('t2 end');
      });
      await Promise.all([t1, t2]);
      assert.deepEqual(log, ['t1 start', 't1 end', 't2 start', 't2 end']);
      assert.equal(await countItems(db), 2);
    });
  });

  test('a plain statement issued mid-transaction waits, so it is neither seen as uncommitted nor rolled back', async () => {
    await withDb(async (db) => {
      const tx = db.transaction(async (t) => {
        await insertItem(t, 'in-tx');
        await sleep(60);
        throw new Error('rollback');
      }).catch(() => 'rolled back');
      await sleep(10);
      // Issued while the transaction is open:
      const read = db.get('SELECT id FROM item WHERE id = ?', 'in-tx'); // must not see the uncommitted row
      const write = insertItem(db, 'plain'); // must survive the other transaction's rollback
      assert.equal(await tx, 'rolled back');
      assert.equal(await read, undefined);
      await write;
      assert.deepEqual((await db.all('SELECT id FROM item')).map((r) => r.id), ['plain']);
    });
  });

  test('a failed BEGIN does not leave the backend stuck', async () => {
    await withDb(async (db, database) => {
      database.exec('BEGIN'); // something outside the facade already holds a transaction on the connection
      await assert.rejects(db.transaction(async () => 1), /transaction/i);
      database.exec('ROLLBACK');
      assert.equal(await db.transaction(async () => 'recovered'), 'recovered');
    });
  });
});

describe('errors and lifecycle', () => {
  test('constraint failures classify the same way through the facade', async () => {
    await withDb(async (db) => {
      await insertItem(db, 'a', 'alpha');
      const kind = async (promise) => { try { await promise; } catch (err) { return classifyDbError(err).kind; } return 'no error'; };
      assert.equal(await kind(insertItem(db, 'a', 'other')), 'unique');
      assert.equal(await kind(insertItem(db, 'b', 'alpha')), 'unique');
      assert.equal(await kind(db.run('INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', 'c', 'gamma', -1)), 'check');
      assert.equal(await kind(db.run('INSERT INTO item (id, name) VALUES (?, ?)', 'd', null)), 'not_null');
      assert.equal(await kind(db.run('INSERT INTO item (id, parent_id, name) VALUES (?, ?, ?)', 'e', 'missing-parent', 'eps')), 'foreign_key');
      assert.equal(await kind(db.get('SELEC 1')), 'other');
    });
  });

  test('close closes the connection, and later calls fail', async () => {
    await withDb(async (db) => {
      await insertItem(db, 'a');
      await db.close();
      await assert.rejects(db.get('SELECT 1'));
    });
  });

  test('the facade exposes exactly the documented surface, and rejects a malformed backend', async () => {
    await withDb(async (db) => {
      assert.equal(db.kind, 'sqlite');
      assert.deepEqual(Object.keys(db).sort(), ['all', 'close', 'diagnostics', 'exec', 'get', 'kind', 'query', 'run', 'transaction']);
    });
    assert.throws(() => createDb({}), /missing get\(\)/);
    assert.throws(() => createSqliteBackend(null), /open node:sqlite DatabaseSync/);
    assert.throws(() => createSqliteBackend({}), /open node:sqlite DatabaseSync/);
  });
});

// ---------------------------------------------------------------------------------------------
// Corrective follow-up tests (independent review findings M4, M5, M6, M7, M9)
// ---------------------------------------------------------------------------------------------

// Like withDb, but lets a test choose backend options or wrap the raw handle.
async function withDbOptions(options, fn, wrap = (database) => database) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alumni-connect-facadetest-'));
  const database = new DatabaseSync(path.join(dir, 'facade.db'));
  database.exec(SCHEMA);
  const db = createSqliteDb(wrap(database), options);
  try {
    return await fn(db, database);
  } finally {
    try { database.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('stale transaction contexts and finished transaction handles (M4, M5)', () => {
  test('a callback that escapes a finished transaction does not count as being inside it: transaction() starts a real one', async () => {
    await withDb(async (db) => {
      let escaped;
      await db.transaction(async (tx) => {
        await insertItem(tx, 'in');
        // Created inside the callback, so it carries the transaction's context, but runs after it ended.
        escaped = sleep(20).then(() => db.transaction(async (inner) => {
          await insertItem(inner, 'late');
          throw new Error('undo late');
        }));
      });
      await assert.rejects(escaped, /undo late/);
      assert.deepEqual((await db.all('SELECT id FROM item ORDER BY id')).map((r) => r.id), ['in'], 'the late write was rolled back, so it ran in a real transaction');
    });
  });

  test('plain statements from a stale context behave like any plain statement (autocommit, not part of the old transaction)', async () => {
    await withDb(async (db) => {
      let escaped;
      await db.transaction(async () => {
        escaped = sleep(15).then(() => insertItem(db, 'stale-plain'));
      });
      await escaped;
      assert.equal(await countItems(db), 1);
    });
  });

  test('a transaction handle stops working when its transaction finishes, and runs nothing', async () => {
    await withDb(async (db) => {
      let leaked;
      await db.transaction(async (tx) => { leaked = tx; await insertItem(tx, 'inside'); });
      for (const call of [() => leaked.run('INSERT INTO item (id, name) VALUES (?, ?)', 'after', 'after'), () => leaked.get('SELECT 1'), () => leaked.all('SELECT 1'),
        () => leaked.query('SELECT 1'), () => leaked.exec('SELECT 1'), () => leaked.transaction(async () => 1)]) {
        await assert.rejects(call(), (err) => err instanceof TransactionClosedError && err.code === 'DB_TRANSACTION_CLOSED');
      }
      assert.deepEqual((await db.all('SELECT id FROM item')).map((r) => r.id), ['inside']);
    });
  });

  test('a leaked handle cannot slip statements into a DIFFERENT transaction that is open at the time', async () => {
    await withDb(async (db) => {
      let leaked;
      await db.transaction(async (tx) => { leaked = tx; });
      let intruder;
      await assert.rejects(db.transaction(async (second) => {
        await insertItem(second, 'second');
        intruder = leaked.run('INSERT INTO item (id, name) VALUES (?, ?)', 'intruder', 'intruder');
        await assert.rejects(intruder, TransactionClosedError);
        throw new Error('roll back the second transaction');
      }), /roll back/);
      assert.equal(await countItems(db), 0, 'nothing from either transaction survived, and nothing leaked in');
    });
  });

  test('a handle also closes after a rollback', async () => {
    await withDb(async (db) => {
      let leaked;
      await assert.rejects(db.transaction(async (tx) => { leaked = tx; throw new Error('fail'); }), /fail/);
      await assert.rejects(leaked.run('INSERT INTO item (id, name) VALUES (?, ?)', 'x', 'x'), TransactionClosedError);
    });
  });

  test('an open transaction, a nested one and the handle keep working while the transaction runs', async () => {
    await withDb(async (db) => {
      await db.transaction(async (tx) => {
        await insertItem(tx, 'a');
        await tx.transaction(async (inner) => { await insertItem(inner, 'b'); });
        await insertItem(tx, 'c');
        assert.equal(await countItems(tx), 3);
      });
      assert.equal(await countItems(db), 3);
    });
  });
});

describe('lock waits and context loss (M6)', () => {
  test('a waiter that gives up gets DB_LOCK_TIMEOUT, never runs its statement, and never releases the lock', async () => {
    await withDbOptions({ lockWaitTimeoutMs: 40 }, async (db) => {
      assert.equal(db.diagnostics().transaction, null);
      const holder = db.transaction(async (tx) => {
        await insertItem(tx, 'holder');
        await sleep(200); // far longer than the waiter is willing to wait
        await insertItem(tx, 'holder2');
      });
      await sleep(10);
      const diag = db.diagnostics().transaction;
      assert.ok(diag && diag.ageMs >= 0 && typeof diag.startedAt === 'string', 'diagnostics report the running transaction');

      const waiter = insertItem(db, 'waiter'); // plain statement
      const secondTx = db.transaction(async (tx) => { await insertItem(tx, 'second'); }); // another transaction
      for (const pending of [waiter, secondTx]) {
        await assert.rejects(pending, (err) => {
          assert.equal(err.code, 'DB_LOCK_TIMEOUT');
          assert.equal(err.name, 'DbLockTimeoutError');
          assert.equal(classifyDbError(err).kind, 'timeout');
          assert.equal(typeof err.holderAgeMs, 'number');
          assert.match(String(err.holderStack), /\S/);
          assert.match(err.message, /NOT released or aborted/);
          return true;
        });
      }
      // The holder was untouched by the waiters' timeouts: it is still running and commits normally.
      assert.notEqual(db.diagnostics().transaction, null, 'the lock was still held after the waiters gave up');
      await holder;
      assert.deepEqual((await db.all('SELECT id FROM item ORDER BY id')).map((r) => r.id), ['holder', 'holder2']);
      assert.equal(db.diagnostics().transaction, null);
    });
  });

  test('code that lost its transaction context deadlocks only until the waiter times out, then the transaction rolls back and the lock is released', async () => {
    await withDbOptions({ lockWaitTimeoutMs: 80 }, async (db) => {
      // Registered OUTSIDE any transaction, so it carries no transaction context when it runs.
      const lostContext = sleep(15).then(() => db.get('SELECT COUNT(*) AS n FROM item'));
      await assert.rejects(db.transaction(async (tx) => {
        await insertItem(tx, 'doomed');
        await lostContext; // the transaction waits for the call, the call waits for the transaction
      }), (err) => err.code === 'DB_LOCK_TIMEOUT');
      assert.equal(await countItems(db), 0, 'the transaction rolled back');
      assert.equal(db.diagnostics().transaction, null, 'and released the lock');
      assert.equal(await db.transaction(async (tx) => { await insertItem(tx, 'after'); return 'usable'; }), 'usable');
    });
  });

  test('with the timeout disabled (0) a waiter simply waits for as long as the transaction runs', async () => {
    await withDbOptions({ lockWaitTimeoutMs: 0 }, async (db) => {
      const holder = db.transaction(async (tx) => { await insertItem(tx, 'a'); await sleep(60); });
      await sleep(5);
      await insertItem(db, 'b'); // waits ~55 ms, no error
      await holder;
      assert.equal(await countItems(db), 2);
    });
  });

  test('the default wait limit is 30 seconds, and invalid options are rejected', async () => {
    await withDb(async (db) => assert.equal(db.diagnostics().transaction, null));
    assert.throws(() => createSqliteBackend(new DatabaseSync(':memory:'), { rowDetection: 'guess' }), /rowDetection/);
  });

  test('a transaction that is waiting for its turn can also give up', async () => {
    await withDbOptions({ lockWaitTimeoutMs: 30 }, async (db) => {
      const holder = db.transaction(async () => { await sleep(120); });
      await sleep(5);
      await assert.rejects(db.transaction(async () => 1), (err) => err.code === 'DB_LOCK_TIMEOUT' && /starting a transaction/.test(err.message));
      await holder;
    });
  });
});

describe('deciding whether a statement returns rows, without StatementSync.columns() (M7)', () => {
  // A handle whose statements have no columns(), exactly like Node releases older than 22.16.
  const withoutColumns = (database) => ({
    prepare: (sql) => {
      const stmt = database.prepare(sql);
      return new Proxy(stmt, { get: (target, prop) => (prop === 'columns' ? undefined : (typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop])) });
    },
    exec: (sql) => database.exec(sql),
    close: () => database.close()
  });

  const BATTERY = [
    ['SELECT * FROM item ORDER BY id', []],
    ['-- a leading comment\nSELECT 1 AS x', []],
    ['/* block */ SELECT 2 AS y', []],
    ['  \n\tSELECT * FROM (SELECT 3 AS z)', []],
    ['WITH x AS (SELECT 1 AS a) SELECT * FROM x', []],
    ['SELECT 1 AS n;', []],
    ['VALUES (1), (2)', []],
    ['INSERT INTO item (id, name, qty) VALUES (?, ?, ?)', ['q1', 'q-one', 4]],
    ['INSERT INTO item (id, name) VALUES (?, ?) RETURNING id, name', ['q2', 'q-two']],
    ['WITH s AS (SELECT ? AS wanted) UPDATE item SET qty = 9 WHERE id IN (SELECT wanted FROM s)', ['q1']],
    ['UPDATE item SET note = ? WHERE id = ? RETURNING id, note', ['hello', 'q2']],
    ['UPDATE item SET qty = qty + 1', []],
    ['DELETE FROM item WHERE id = ? RETURNING id', ['q2']],
    ['PRAGMA table_info(item)', []],
    ['PRAGMA foreign_keys', []],
    ['PRAGMA foreign_keys = ON', []],
    ['EXPLAIN SELECT 1', []],
    ['CREATE TABLE tmp_t (a)', []],
    ['DROP TABLE tmp_t', []],
    ['DELETE FROM item WHERE id = ?', ['q1']]
  ];

  test('asking SQLite (EXPLAIN) gives the same answers as columns() for statements of every shape', async () => {
    await withDbOptions({ rowDetection: 'columns' }, async (reference) => {
      await withDbOptions({ rowDetection: 'explain' }, async (viaExplain) => {
        await withDbOptions({}, async (legacy) => {
          for (const [sql, params] of BATTERY) {
            const expected = await reference.query(sql, ...params);
            assert.deepEqual(await viaExplain.query(sql, ...params), expected, `explain mode: ${JSON.stringify(sql)}`);
            assert.deepEqual(await legacy.query(sql, ...params), expected, `columns() missing: ${JSON.stringify(sql)}`);
          }
        }, withoutColumns);
      });
    });
  });

  test('the shapes that the old text matching got wrong are right', async () => {
    await withDbOptions({}, async (db) => {
      assert.deepEqual((await db.query('-- note\nSELECT 1 AS x')).rows, [{ x: 1 }]);
      assert.deepEqual((await db.query('/* c */ SELECT 2 AS y')).rows, [{ y: 2 }]);
      assert.deepEqual((await db.query('  \n\tSELECT * FROM (SELECT 3 AS z)')).rows, [{ z: 3 }]);
      await insertItem(db, 'a');
      assert.deepEqual(await db.query("WITH s AS (SELECT 'a' AS w) UPDATE item SET qty = 5 WHERE id IN (SELECT w FROM s)"), { rows: [], rowCount: 1 }, 'WITH ... UPDATE is a write that changed one row');
    }, withoutColumns);
  });

  test('detection never runs the statement itself', async () => {
    await withDbOptions({}, async (db) => {
      // If EXPLAIN-based detection executed the INSERT, the real run would then hit the UNIQUE constraint.
      assert.deepEqual(await db.query('INSERT INTO item (id, name) VALUES (?, ?)', 'only', 'once'), { rows: [], rowCount: 1 });
      assert.equal(await countItems(db), 1);
      await assert.rejects(db.query('INSERT INTO item (id, name) VALUES (?, ?)', 'only', 'twice'), (err) => classifyDbError(err).kind === 'unique');
      assert.equal(await countItems(db), 1);
    }, withoutColumns);
  });

  test('invalid SQL fails the same way in both modes (an error, not a wrong shape)', async () => {
    await withDbOptions({}, async (db) => {
      await assert.rejects(db.query('SELEC 1'), (err) => classifyDbError(err).kind === 'other' && /syntax error/.test(err.message));
      await assert.rejects(db.query('SELECT * FROM no_such_table'), /no such table/);
    }, withoutColumns);
  });
});

describe('the facade never filters result columns by name (review finding M1)', () => {
  // A table that really has a column called seq, plus queries that produce an alias called seq.
  async function withSeqDb(fn) {
    return withDb(async (db, database) => {
      database.exec("CREATE TABLE seqtest (id TEXT PRIMARY KEY, seq INTEGER, body TEXT); INSERT INTO seqtest VALUES ('a', 2, 'x'), ('b', 1, 'y');");
      return fn(db);
    });
  }

  test('an explicitly selected seq column is returned exactly as the database produced it', async () => {
    await withSeqDb(async (db) => {
      assert.deepEqual(await db.get('SELECT seq FROM seqtest WHERE id = ?', 'a'), { seq: 2 });
      assert.deepEqual(await db.all('SELECT id, seq FROM seqtest ORDER BY seq'), [{ id: 'b', seq: 1 }, { id: 'a', seq: 2 }]);
      assert.deepEqual((await db.query('SELECT seq, body FROM seqtest ORDER BY seq DESC')).rows, [{ seq: 2, body: 'x' }, { seq: 1, body: 'y' }]);
      assert.deepEqual(await db.get('SELECT * FROM seqtest WHERE id = ?', 'a'), { id: 'a', seq: 2, body: 'x' }, 'SELECT * keeps it too');
    });
  });

  test('a computed alias named seq is preserved', async () => {
    await withSeqDb(async (db) => {
      assert.deepEqual(await db.get('SELECT COUNT(*) AS seq FROM seqtest'), { seq: 2 });
      assert.deepEqual(await db.all('SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS seq FROM seqtest ORDER BY id'), [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }]);
      assert.deepEqual((await db.query('SELECT 41 + 1 AS seq')).rows, [{ seq: 42 }]);
      assert.deepEqual(await db.get('SELECT 7 AS seq'), { seq: 7 });
    });
  });

  test('inside a transaction and for RETURNING, results are not modified either', async () => {
    await withSeqDb(async (db) => {
      await db.transaction(async (tx) => {
        assert.deepEqual(await tx.all('SELECT * FROM seqtest ORDER BY id'), [{ id: 'a', seq: 2, body: 'x' }, { id: 'b', seq: 1, body: 'y' }]);
        assert.deepEqual((await tx.query('UPDATE seqtest SET body = ? WHERE id = ? RETURNING *', 'z', 'a')).rows, [{ id: 'a', seq: 2, body: 'z' }]);
        assert.deepEqual(await tx.get('SELECT ROW_NUMBER() OVER (ORDER BY id) AS seq FROM seqtest'), { seq: 1 });
      });
    });
  });

  test('ordinary results are untouched and empty results stay empty', async () => {
    await withDb(async (db) => {
      await insertItem(db, 'a', 'alpha', 3);
      assert.deepEqual(await db.get('SELECT * FROM item WHERE id = ?', 'a'), { id: 'a', parent_id: null, name: 'alpha', qty: 3, note: null });
      assert.equal(await db.get('SELECT * FROM item WHERE id = ?', 'none'), undefined);
      assert.deepEqual(await db.all('SELECT * FROM item WHERE id = ?', 'none'), []);
      assert.deepEqual(await db.query('SELECT * FROM item WHERE id = ?', 'none'), { rows: [], rowCount: 0 });
    });
  });

  test('the old name-based hiding is gone: no HIDDEN_RESULT_COLUMNS export, and a facade over any backend passes rows through as they are', async () => {
    assert.equal('HIDDEN_RESULT_COLUMNS' in facadeModule, false);
    const row = { id: 'r1', seq: 5 };
    const rows = [{ id: 'r1', seq: 5 }, { id: 'r2', seq: 6 }];
    const ops = {
      get: async () => row, all: async () => rows, run: async () => ({ changes: 0 }), query: async () => ({ rows, rowCount: 2 }), exec: async () => {}
    };
    const db = createDb({ kind: 'stub', ...ops, transaction: (fn) => fn(ops), close: async () => {} });
    assert.equal(await db.get('SELECT 1'), row, 'the very same row object, not a modified copy');
    assert.equal(await db.all('SELECT 1'), rows);
    assert.equal((await db.query('SELECT 1')).rows, rows);
    assert.deepEqual(row, { id: 'r1', seq: 5 }, 'and it still has its seq');
  });
});
