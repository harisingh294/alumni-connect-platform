// Tests for resetIdentitySequences (server/db/identity.js) and its statements (independent review finding M2).
//
// IMPORTANT: no PostgreSQL is available or used. These tests run the helper against a small in-memory MODEL of
// the PostgreSQL behavior it depends on (LOCK TABLE needs a transaction, pg_get_serial_sequence returns NULL
// for a column without an owned sequence, setval on a missing relation raises 42P01, and so on). The model
// is written from the PostgreSQL documentation and has NOT been checked against a real server, so these tests
// verify the helper's logic, the statement contract and the error behavior, not the SQL's semantics in
// PostgreSQL. That verification belongs to the later phase with a disposable PostgreSQL.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, resetIdentitySequences, IdentityResetError } from '../server/db/index.js';
import { missingSequenceName } from '../server/db/sql.js';

const pgError = (code, message) => Object.assign(new Error(message), { code });

// tables: { name: { columns: {col: {maxValue, sequence}} } }; sequence is a name or null (no owned sequence).
function fakePg(tables) {
  const sequences = {}; // name -> { next }
  for (const t of Object.values(tables)) for (const c of Object.values(t.columns)) if (c.sequence) sequences[c.sequence] ??= { next: 1 };
  const log = [];
  const state = { inTx: false, locked: new Set(), transactionCalls: 0 };
  const table = (name) => { if (!tables[name]) throw pgError('42P01', `relation "${name}" does not exist`); return tables[name]; };
  const column = (t, c) => { const col = table(t).columns[c]; if (!col) throw pgError('42703', `column "${c}" of relation "${t}" does not exist`); return col; };
  const exec = (sql) => {
    log.push(sql);
    let m;
    if ((m = /^LOCK TABLE (\w+) IN SHARE ROW EXCLUSIVE MODE$/.exec(sql))) {
      if (!state.inTx) throw pgError('25P01', 'LOCK TABLE can only be used in transaction blocks');
      table(m[1]); state.locked.add(m[1]); return undefined;
    }
    if ((m = /^SELECT pg_get_serial_sequence\('(\w+)', '(\w+)'\) AS sequence_name$/.exec(sql))) return { sequence_name: column(m[1], m[2]).sequence };
    if ((m = /^SELECT setval\(\(COALESCE\(pg_get_serial_sequence\('(\w+)', '(\w+)'\), '(\w+)'\)\)::regclass, COALESCE\(\(SELECT MAX\(\2\) FROM \1\), 0\) \+ 1, false\) AS next_value$/.exec(sql))) {
      const col = column(m[1], m[2]);
      if (!state.locked.has(m[1])) state.unlockedSetval = true;
      const seqName = col.sequence ?? m[3];
      const seq = sequences[seqName];
      if (!seq) throw pgError('42P01', `relation "${seqName}" does not exist`); // the regclass cast
      seq.next = (col.maxValue ?? 0) + 1;
      return { next_value: seq.next };
    }
    throw new Error(`fake PostgreSQL does not model: ${sql}`);
  };
  const ops = {
    get: async (sql) => exec(sql),
    all: async (sql) => { const r = exec(sql); return r ? [r] : []; },
    query: async (sql) => { const r = exec(sql); return { rows: r ? [r] : [], rowCount: r ? 1 : 0 }; },
    run: async (sql) => { exec(sql); return { changes: 0 }; },
    exec: async (sql) => { exec(sql); }
  };
  const backend = {
    kind: 'fake-pg', ...ops, close: async () => {},
    transaction: async (fn) => {
      state.transactionCalls += 1;
      if (state.inTx) return fn(ops); // joins
      state.inTx = true; state.locked = new Set();
      try { return await fn(ops); } finally { state.inTx = false; state.locked = new Set(); }
    }
  };
  return { db: createDb(backend), log, state, sequences };
}

const identityTables = (over = {}) => ({
  messages: { columns: { seq: { maxValue: 0, sequence: 'messages_seq_seq' } } },
  audit_logs: { columns: { seq: { maxValue: 0, sequence: 'audit_logs_seq_seq' } } },
  ...over
});

describe('resetIdentitySequences: correct behavior', () => {
  test('empty tables: the next value is 1', async () => {
    const { db, sequences } = fakePg(identityTables());
    const res = await db.transaction((tx) => resetIdentitySequences(tx));
    assert.deepEqual(res, [{ table: 'messages', column: 'seq', nextValue: 1 }, { table: 'audit_logs', column: 'seq', nextValue: 1 }]);
    assert.equal(sequences.messages_seq_seq.next, 1);
  });

  test('tables with explicitly imported ids: the next value is MAX + 1 (gaps are fine)', async () => {
    const { db, sequences } = fakePg(identityTables({
      messages: { columns: { seq: { maxValue: 41, sequence: 'messages_seq_seq' } } },
      audit_logs: { columns: { seq: { maxValue: 5000000000, sequence: 'audit_logs_seq_seq' } } }
    }));
    const res = await db.transaction((tx) => resetIdentitySequences(tx, ['messages']));
    assert.deepEqual(res, [{ table: 'messages', column: 'seq', nextValue: 42 }]);
    assert.equal(sequences.messages_seq_seq.next, 42);
    assert.equal(sequences.audit_logs_seq_seq.next, 1, 'tables that were not named are untouched');
  });

  test('is idempotent: running it again changes nothing', async () => {
    const { db } = fakePg(identityTables({ messages: { columns: { seq: { maxValue: 7, sequence: 'messages_seq_seq' } } } }));
    const a = await db.transaction((tx) => resetIdentitySequences(tx, ['messages']));
    const b = await db.transaction((tx) => resetIdentitySequences(tx, ['messages']));
    assert.deepEqual(a, b);
  });

  test('works for any identity or serial column that owns a sequence, not only seq', async () => {
    const { db } = fakePg({ widgets: { columns: { n: { maxValue: 99, sequence: 'widgets_n_seq' } } } });
    assert.deepEqual(await db.transaction((tx) => resetIdentitySequences(tx, ['widgets'], 'n')), [{ table: 'widgets', column: 'n', nextValue: 100 }]);
  });
});

describe('resetIdentitySequences: fails loudly', () => {
  test('a column without an owned sequence throws instead of silently doing nothing, and setval never runs', async () => {
    const { db, log } = fakePg(identityTables({ audit_logs: { columns: { seq: { maxValue: 5, sequence: null } } } }));
    await assert.rejects(db.transaction((tx) => resetIdentitySequences(tx, ['audit_logs'])), (e) => {
      assert.ok(e instanceof IdentityResetError);
      assert.equal(e.code, 'IDENTITY_RESET_FAILED');
      assert.equal(e.table, 'audit_logs');
      assert.equal(e.column, 'seq');
      assert.match(e.message, /audit_logs\.seq has no owned sequence/);
      return true;
    });
    assert.equal(log.some((s) => s.startsWith('SELECT setval')), false);
  });

  test('even if the lookup were skipped, the setval statement itself errors on a missing sequence (regclass cast)', async () => {
    const { db } = fakePg(identityTables({ messages: { columns: { seq: { maxValue: 5, sequence: null } } } }));
    const { pgResetIdentitySql } = await import('../server/db/sql.js');
    await assert.rejects(db.transaction((tx) => tx.get(pgResetIdentitySql('messages'))), (e) => e.code === '42P01' && e.message.includes(missingSequenceName('messages', 'seq')));
  });

  test('a missing table, a missing column and a wrong name are errors that name the table and column', async () => {
    const { db } = fakePg(identityTables());
    for (const [tables, column, code] of [[['nope'], 'seq', '42P01'], [['messages'], 'missing_col', '42703']]) {
      await assert.rejects(db.transaction((tx) => resetIdentitySequences(tx, tables, column)), (e) => {
        assert.ok(e instanceof IdentityResetError);
        assert.equal(e.cause.code, code);
        assert.equal(e.table, tables[0]);
        assert.match(e.message, new RegExp(`${tables[0]}\\.${column}`));
        return true;
      });
    }
    for (const bad of ['Messages', "messages'--", 'public.messages', '']) {
      await assert.rejects(db.transaction((tx) => resetIdentitySequences(tx, [bad])), /plain lowercase identifiers/, bad);
    }
  });

  test('a failure on a later table stops the run; earlier tables are reported only via the thrown error, and the transaction can roll back', async () => {
    const { db, state } = fakePg(identityTables({ audit_logs: { columns: { seq: { maxValue: 1, sequence: null } } } }));
    await assert.rejects(db.transaction((tx) => resetIdentitySequences(tx)), IdentityResetError);
    assert.equal(state.inTx, false, 'the failure propagated out of the caller transaction, which ended');
  });

  test('called outside a transaction it fails at the lock, before anything else is attempted', async () => {
    const { db, log } = fakePg(identityTables());
    await assert.rejects(resetIdentitySequences(db), (e) => {
      assert.ok(e instanceof IdentityResetError);
      assert.equal(e.cause.code, '25P01');
      assert.match(e.message, /inside a transaction/);
      return true;
    });
    assert.deepEqual(log, ['LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE'], 'no lookup or setval was issued');
  });

  test('rejects a handle that is not a database handle, and an empty table list', async () => {
    await assert.rejects(resetIdentitySequences(null), TypeError);
    await assert.rejects(resetIdentitySequences({}), TypeError);
    const { db } = fakePg(identityTables());
    await assert.rejects(db.transaction((tx) => resetIdentitySequences(tx, [])), TypeError);
  });
});

describe('resetIdentitySequences: locking and transaction ownership', () => {
  test('every table is locked first, and setval runs only while that table is locked', async () => {
    const { db, log, state } = fakePg(identityTables());
    await db.transaction((tx) => resetIdentitySequences(tx));
    assert.deepEqual(log, [
      'LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE',
      "SELECT pg_get_serial_sequence('messages', 'seq') AS sequence_name",
      log[2],
      'LOCK TABLE audit_logs IN SHARE ROW EXCLUSIVE MODE',
      "SELECT pg_get_serial_sequence('audit_logs', 'seq') AS sequence_name",
      log[5]
    ]);
    assert.match(log[2], /^SELECT setval\(/);
    assert.match(log[5], /^SELECT setval\(/);
    assert.equal(state.unlockedSetval, undefined, 'setval never ran on an unlocked table');
  });

  test('it never starts, joins, commits or rolls back a transaction: the caller owns exactly one', async () => {
    const { db, state } = fakePg(identityTables());
    await db.transaction(async (tx) => {
      assert.equal(state.transactionCalls, 1);
      await resetIdentitySequences(tx);
      assert.equal(state.transactionCalls, 1, 'the helper did not call transaction()');
      assert.equal(state.inTx, true, 'the transaction is still open after the helper returns');
    });
    assert.equal(state.inTx, false, 'closed only by the caller');
  });

  test('inside a nested caller transaction it joins what is already open and stays composable with other work', async () => {
    const { db, log, state } = fakePg(identityTables());
    await db.transaction(async (tx) => {
      await tx.run('LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE'); // the caller may already hold the lock
      await tx.transaction((inner) => resetIdentitySequences(inner, ['messages']));
      assert.equal(state.inTx, true);
    });
    assert.ok(log.filter((s) => s.startsWith('LOCK TABLE messages')).length >= 2, 'taking the same lock again is harmless');
  });

  test('a rollback after the reset is the caller\'s: the helper leaves the error untouched and does not swallow it', async () => {
    const { db } = fakePg(identityTables());
    const boom = new Error('import failed after the reset');
    await assert.rejects(db.transaction(async (tx) => { await resetIdentitySequences(tx); throw boom; }), (e) => e === boom);
  });
});
