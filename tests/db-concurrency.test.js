// Concurrency tests for server/db/sqlite-backend.js (independent review finding H1).
//
// The bug: a plain statement awaited a helper before executing. That await costs a microtask turn even when
// nothing is waiting, and in that gap another caller's transaction() could run BEGIN, so the plain statement
// executed INSIDE that transaction and was silently lost if it rolled back.
//
// Every test here uses a RECORDING STUB instead of a database: it logs each statement the backend sends and
// runs no SQL. No SQLite database, file, PostgreSQL or Neon is involved. The stub makes the exact order of
// BEGIN, COMMIT, ROLLBACK and statements observable, which is what this bug is about.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSqliteBackend } from '../server/db/sqlite-backend.js';

// ---------- the recording stub ----------

function recordingStub() {
  const log = [];
  const statement = (sql) => ({
    run: () => { log.push(sql); return { changes: 1 }; },
    get: () => { log.push(sql); return undefined; },
    all: () => { log.push(sql); return []; },
    columns: () => [] // lets query() use the columns() path; this stub never returns rows
  });
  return { log, database: { prepare: statement, exec: (sql) => { log.push(sql); } } };
}

const tick = () => Promise.resolve();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

// Splits a log into transaction windows (BEGIN ... COMMIT|ROLLBACK) and the statements outside any window.
// Fails on any malformed sequence: nested BEGIN, COMMIT without BEGIN, or a window left open.
function analyse(log) {
  const windows = [];
  const outside = [];
  let open = null;
  for (const entry of log) {
    if (entry === 'BEGIN') {
      assert.equal(open, null, 'BEGIN while another transaction is still open');
      open = { statements: [] };
    } else if (entry === 'COMMIT' || entry === 'ROLLBACK') {
      assert.notEqual(open, null, `${entry} with no open transaction`);
      open.end = entry;
      windows.push(open);
      open = null;
    } else if (open) {
      open.statements.push(entry);
    } else {
      outside.push(entry);
    }
  }
  assert.equal(open, null, 'a transaction was left open');
  return { windows, outside };
}

const actorOf = (entry) => entry.split(':')[0];

// The invariant behind H1. `plain` actors are ids starting with P, transactions start with T.
// 1. No plain statement is ever inside a transaction window.
// 2. Each window holds the statements of exactly one transaction actor, and all of that actor's statements.
// 3. Every statement of every actor was executed exactly once.
function assertIsolated(log, expected) {
  const { windows, outside } = analyse(log);
  for (const entry of outside) assert.match(actorOf(entry), /^P/, `a transaction statement ran outside its transaction: ${entry}`);
  for (const w of windows) {
    assert.ok(w.statements.length > 0, 'an empty transaction window');
    const owners = new Set(w.statements.map(actorOf));
    assert.equal(owners.size, 1, `statements of different callers share one transaction: ${[...w.statements]}`);
    assert.match([...owners][0], /^T/, `a plain statement ran inside a transaction: ${w.statements}`);
  }
  const counts = new Map();
  for (const entry of log) if (entry !== 'BEGIN' && entry !== 'COMMIT' && entry !== 'ROLLBACK') counts.set(entry, (counts.get(entry) || 0) + 1);
  for (const [entry, n] of counts) assert.equal(n, 1, `${entry} ran ${n} times`);
  assert.deepEqual([...counts.keys()].sort(), [...expected].sort(), 'every statement ran exactly once and none were lost');
  return { windows, outside };
}

// ---------- deterministic ordering 1: plain statement first, transaction immediately afterwards ----------

describe('H1 ordering 1: a plain statement issued first, a transaction issued immediately afterwards', () => {
  test('the plain statement runs BEFORE the transaction begins (it used to run inside it)', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    const plain = backend.run('P:first', []);
    const transaction = backend.transaction(async (ops) => { await ops.run('T:1', []); });
    await Promise.all([plain, transaction]);
    assert.deepEqual(log, ['P:first', 'BEGIN', 'T:1', 'COMMIT']);
  });

  test('the same for every kind of plain call: run, get, all, query and exec', async () => {
    for (const method of ['run', 'get', 'all', 'query', 'exec']) {
      const { log, database } = recordingStub();
      const backend = createSqliteBackend(database, { rowDetection: 'columns' });
      const plain = method === 'exec' ? backend.exec('P:call') : backend[method]('P:call', []);
      const transaction = backend.transaction(async (ops) => { await ops.run('T:1', []); });
      await Promise.all([plain, transaction]);
      assert.deepEqual(log, ['P:call', 'BEGIN', 'T:1', 'COMMIT'], method);
    }
  });

  test('a rollback of the transaction can no longer take the earlier plain statement with it', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    const plain = backend.run('P:first', []);
    const failing = backend.transaction(async (ops) => { await ops.run('T:1', []); throw new Error('roll back'); });
    await assert.rejects(failing, /roll back/);
    await plain;
    assert.deepEqual(log, ['P:first', 'BEGIN', 'T:1', 'ROLLBACK']);
    assert.deepEqual(analyse(log).outside, ['P:first'], 'the plain write sits outside the rolled-back window');
  });

  test('several plain statements issued before a transaction all run before it', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    const plains = [backend.run('P1:a', []), backend.get('P2:b', []), backend.all('P3:c', [])];
    const transaction = backend.transaction(async (ops) => { await ops.run('T:1', []); });
    await Promise.all([...plains, transaction]);
    assert.deepEqual(log, ['P1:a', 'P2:b', 'P3:c', 'BEGIN', 'T:1', 'COMMIT']);
  });

  test('a plain statement issued while the connection is free runs immediately, before any await', () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    backend.run('P:now', []); // deliberately not awaited
    assert.deepEqual(log, ['P:now'], 'the statement was executed synchronously by the call itself');
  });
});

// ---------- deterministic ordering 2: a plain statement and another transaction both wait behind a holder ----------

describe('H1 ordering 2: a plain statement waits behind one transaction while another transaction also waits', () => {
  async function scenario({ plainFirst, holderRollsBack = false }) {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    const hold = gate();
    const holder = backend.transaction(async (ops) => {
      await ops.run('T0:1', []);
      await hold.opened;
      await ops.run('T0:2', []);
      if (holderRollsBack) throw new Error('holder rolls back');
    });
    await tick();
    assert.deepEqual(log, ['BEGIN', 'T0:1'], 'the holder is running and holds the lock');

    let plain;
    let waiting;
    if (plainFirst) {
      plain = backend.run('P:waiter', []);
      waiting = backend.transaction(async (ops) => { await ops.run('T2:1', []); });
    } else {
      waiting = backend.transaction(async (ops) => { await ops.run('T2:1', []); });
      plain = backend.run('P:waiter', []);
    }
    await tick();
    assert.deepEqual(log, ['BEGIN', 'T0:1'], 'neither waiter ran while the holder held the lock');

    hold.open();
    const settled = await Promise.allSettled([holder, plain, waiting]);
    return { log, settled };
  }

  test('plain statement registered first: it runs outside both transactions', async () => {
    const { log, settled } = await scenario({ plainFirst: true });
    assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    assertIsolated(log, ['T0:1', 'T0:2', 'P:waiter', 'T2:1']);
    assert.deepEqual(log, ['BEGIN', 'T0:1', 'T0:2', 'COMMIT', 'P:waiter', 'BEGIN', 'T2:1', 'COMMIT']);
  });

  test('transaction registered first: the plain statement still never lands inside it', async () => {
    const { log, settled } = await scenario({ plainFirst: false });
    assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled', 'fulfilled']);
    assertIsolated(log, ['T0:1', 'T0:2', 'P:waiter', 'T2:1']);
    assert.deepEqual(log, ['BEGIN', 'T0:1', 'T0:2', 'COMMIT', 'BEGIN', 'T2:1', 'COMMIT', 'P:waiter']);
  });

  test('when the holder rolls back, the waiting plain statement is not rolled back with it', async () => {
    for (const plainFirst of [true, false]) {
      const { log, settled } = await scenario({ plainFirst, holderRollsBack: true });
      assert.equal(settled[0].status, 'rejected');
      assert.equal(settled[1].status, 'fulfilled');
      assert.equal(settled[2].status, 'fulfilled');
      const { windows, outside } = assertIsolated(log, ['T0:1', 'T0:2', 'P:waiter', 'T2:1']);
      assert.equal(windows[0].end, 'ROLLBACK');
      assert.ok(outside.includes('P:waiter'));
    }
  });

  test('two plain statements and two transactions waiting behind one holder: nothing crosses a window', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    const hold = gate();
    const holder = backend.transaction(async (ops) => { await ops.run('T0:1', []); await hold.opened; });
    await tick();
    const waiters = [
      backend.run('P1:a', []),
      backend.transaction(async (ops) => { await ops.run('T1:1', []); await ops.run('T1:2', []); }),
      backend.get('P2:b', []),
      backend.transaction(async (ops) => { await ops.run('T2:1', []); })
    ];
    hold.open();
    await Promise.all([holder, ...waiters]);
    const { windows } = assertIsolated(log, ['T0:1', 'P1:a', 'T1:1', 'T1:2', 'P2:b', 'T2:1']);
    assert.equal(windows.length, 3);
  });
});

// ---------- the invariant, systematically and randomly ----------

describe('H1 invariant: no unrelated plain statement runs between another transaction\'s BEGIN and COMMIT/ROLLBACK', () => {
  const delay = async (ticks) => { for (let i = 0; i < ticks; i++) await tick(); };

  test('systematic: every combination of 0-3 microtask start offsets for one plain statement and two transactions', async () => {
    let combinations = 0;
    for (const failFirst of [false, true]) {
      for (let dp = 0; dp <= 3; dp++) {
        for (let d1 = 0; d1 <= 3; d1++) {
          for (let d2 = 0; d2 <= 3; d2++) {
            const { log, database } = recordingStub();
            const backend = createSqliteBackend(database);
            const plain = (async () => { await delay(dp); await backend.run('P:one', []); })();
            const t1 = (async () => {
              await delay(d1);
              await backend.transaction(async (ops) => { await ops.run('T1:a', []); await tick(); await ops.run('T1:b', []); if (failFirst) throw new Error('t1 fails'); }).catch(() => {});
            })();
            const t2 = (async () => {
              await delay(d2);
              await backend.transaction(async (ops) => { await ops.run('T2:a', []); await backend.run('T2:root', []); });
            })();
            await Promise.all([plain, t1, t2]);
            const label = `plain+${dp} t1+${d1} t2+${d2} fail=${failFirst}`;
            try {
              const { windows } = assertIsolated(log, ['P:one', 'T1:a', 'T1:b', 'T2:a', 'T2:root']);
              assert.equal(windows.length, 2);
              const t1Window = windows.find((w) => w.statements.some((s) => s.startsWith('T1')));
              assert.equal(t1Window.end, failFirst ? 'ROLLBACK' : 'COMMIT');
            } catch (err) {
              err.message = `${label}: ${err.message}\nlog: ${JSON.stringify(log)}`;
              throw err;
            }
            combinations++;
          }
        }
      }
    }
    assert.equal(combinations, 128);
  });

  // A small deterministic generator (mulberry32). Seeded, so a failing seed is reproducible.
  const generator = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pause = async (rnd) => {
    const k = Math.floor(rnd() * 7);
    if (k < 3) await delay(k);
    else if (k === 3) await new Promise((resolve) => setImmediate(resolve));
    else if (k === 4) await sleep(0);
    else if (k === 5) await sleep(1);
    else await delay(5);
  };

  test('randomized: 300 seeded runs of 4-9 callers with random timing, rollbacks and nested root calls', async () => {
    let transactions = 0;
    let plains = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = generator(seed);
      const { log, database } = recordingStub();
      const backend = createSqliteBackend(database, { lockWaitTimeoutMs: 0 }); // no timeouts: the invariant must hold by itself
      const callers = 4 + Math.floor(rnd() * 6);
      const expected = [];
      const rollbackOwners = new Set();
      const jobs = [];
      for (let i = 0; i < callers; i++) {
        if (rnd() < 0.45) {
          const id = `P${i}`;
          const method = ['run', 'get', 'all', 'exec'][Math.floor(rnd() * 4)];
          expected.push(`${id}:x`);
          plains++;
          jobs.push((async () => { await pause(rnd); await (method === 'exec' ? backend.exec(`${id}:x`) : backend[method](`${id}:x`, [])); })());
        } else {
          const id = `T${i}`;
          const statements = 1 + Math.floor(rnd() * 3);
          const rollsBack = rnd() < 0.3;
          if (rollsBack) rollbackOwners.add(id);
          for (let n = 0; n < statements; n++) expected.push(`${id}:s${n}`);
          expected.push(`${id}:root`);
          transactions++;
          jobs.push((async () => {
            await pause(rnd);
            await backend.transaction(async (ops) => {
              for (let n = 0; n < statements; n++) { await pause(rnd); await ops.run(`${id}:s${n}`, []); }
              await backend.run(`${id}:root`, []); // a root call from inside the callback joins the transaction
              await pause(rnd);
              if (rollsBack) throw new Error(`${id} rolls back`);
            }).catch((err) => { if (!rollbackOwners.has(id)) throw err; });
          })());
        }
      }
      await Promise.all(jobs);
      try {
        const { windows } = assertIsolated(log, expected);
        for (const w of windows) assert.equal(w.end, rollbackOwners.has(actorOf(w.statements[0])) ? 'ROLLBACK' : 'COMMIT');
        assert.equal(windows.length, [...new Set(expected.filter((e) => e.startsWith('T')).map(actorOf))].length, 'one window per transaction');
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}\nlog: ${JSON.stringify(log)}`;
        throw err;
      }
    }
    assert.ok(transactions > 500 && plains > 500, `the generated workload was substantial (${transactions} transactions, ${plains} plain statements)`);
  });
});

// ---------- the fix must not disturb the timeout behavior ----------

describe('H1 fix keeps the timeout behavior', () => {
  test('a waiting plain statement still gives up with DB_LOCK_TIMEOUT, never runs, and the holder is untouched', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database, { lockWaitTimeoutMs: 40 });
    const hold = gate();
    const holder = backend.transaction(async (ops) => { await ops.run('T0:1', []); await hold.opened; await ops.run('T0:2', []); });
    await tick();
    await assert.rejects(backend.run('P:gives-up', []), (err) => err.code === 'DB_LOCK_TIMEOUT');
    assert.ok(backend.diagnostics().transaction, 'the lock was NOT released by the timeout');
    hold.open();
    await holder;
    assert.deepEqual(log, ['BEGIN', 'T0:1', 'T0:2', 'COMMIT'], 'the statement that gave up never ran');
  });

  test('the deadline spans re-waits: a call woken by one transaction that finds another running still times out on schedule', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database, { lockWaitTimeoutMs: 60 });
    const hold1 = gate();
    const hold2 = gate();
    const first = backend.transaction(async (ops) => { await ops.run('T1:1', []); await hold1.opened; });
    await tick();
    const second = backend.transaction(async (ops) => { await ops.run('T2:1', []); await hold2.opened; }); // queued ahead of the plain call
    await tick();
    const started = Date.now();
    const plain = backend.run('P:late', []).then(() => 'ran', (err) => err.code);
    await sleep(15);
    hold1.open(); // first finishes, second takes the lock, the plain call wakes and must wait again
    await first;
    const outcome = await plain; // gives up at ~60 ms after it started waiting, not 60 ms after the re-wait
    assert.equal(outcome, 'DB_LOCK_TIMEOUT');
    assert.ok(Date.now() - started < 200, 'the original deadline was kept');
    hold2.open();
    await second;
    assert.deepEqual(log, ['BEGIN', 'T1:1', 'COMMIT', 'BEGIN', 'T2:1', 'COMMIT'], 'the timed-out statement never ran');
  });

  test('a waiter woken after the lock became free runs at once, and a root call inside a callback joins its transaction without waiting', async () => {
    const { log, database } = recordingStub();
    const backend = createSqliteBackend(database);
    const hold = gate();
    const holder = backend.transaction(async (ops) => { await ops.run('T0:1', []); await hold.opened; });
    await tick();
    const plain = backend.run('P:waiter', []);
    hold.open();
    await Promise.all([holder, plain]);
    assert.deepEqual(log, ['BEGIN', 'T0:1', 'COMMIT', 'P:waiter']);
    await backend.transaction(async () => { await backend.run('T9:inside', []); }); // root facade call inside the callback
    assert.deepEqual(analyse(log).windows.at(-1).statements, ['T9:inside']);
  });
});
