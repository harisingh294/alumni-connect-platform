// Async backend over an ALREADY OPEN node:sqlite DatabaseSync.
//
// This module never opens a database and never imports server/db.js: the caller passes the handle
// in. That keeps it testable on a temporary database and impossible to point at real data by accident.
//
// NOT USED BY THE APPLICATION YET.
//
// Backend contract (array-style parameters; the facade in ./index.js adds the variadic API):
//   get(sql, params)   -> Promise<row | undefined>     (plain object)
//   all(sql, params)   -> Promise<row[]>
//   run(sql, params)   -> Promise<{ changes }>
//   query(sql, params) -> Promise<{ rows, rowCount }>
//   exec(sql)          -> Promise<void>                 (several statements, no parameters)
//   transaction(fn)    -> Promise<result of fn>         (fn receives an ops object with the same methods)
//   diagnostics()      -> { transaction: null | { ageMs, startedAt: string } }
//   close()            -> Promise<void>
//
// TRANSACTIONS. node:sqlite is synchronous, but once callers `await` between statements, other requests
// can run in the gaps. On one shared connection a plain statement from another request would land INSIDE
// someone else's open transaction (and be committed or rolled back with it). So:
//   * only one transaction runs at a time; others wait for it,
//   * a plain statement issued while a transaction is open waits for it to finish. The "is the connection
//     free?" check and the statement itself run in the SAME synchronous step: there is no await between
//     them, so no other caller's transaction can begin in between and swallow the statement,
//   * code running inside a transaction callback (tracked with AsyncLocalStorage) uses the open
//     transaction automatically, so it cannot deadlock by calling the root API,
//   * the transaction object handed to the callback stops working the moment the transaction finishes
//     (it rejects with TransactionClosedError), so a leaked handle can never run statements outside the
//     lock or inside somebody else's transaction,
//   * a context left over from a FINISHED transaction (a timer or callback that escaped it) is not
//     treated as "inside" any transaction. A new transaction() from there starts a real one.
// A nested transaction() inside a transaction joins the outer one (there are no savepoints).
//
// LOCK WAITS AND DEADLOCKS. If code inside a transaction callback calls this backend from a context that
// lost AsyncLocalStorage tracking (for example an event handler created outside the callback) and then
// awaits it, the call waits for the transaction, and the transaction waits for the call. The way out is
// a timeout on the WAITER (lockWaitTimeoutMs, default 30 s): the waiting call rejects with a
// DbLockTimeoutError (code DB_LOCK_TIMEOUT) without running its statement, the transaction callback sees
// that rejection, and a normal rollback then releases the lock. The lock is NEVER released while a
// transaction is still running, and a running transaction is never aborted by a timer. A callback that
// simply never settles holds the lock until it does; every waiter fails with DB_LOCK_TIMEOUT instead of
// hanging, and diagnostics() reports how long the holder has been running. Set lockWaitTimeoutMs to 0
// to wait forever.
//
// WHICH STATEMENTS RETURN ROWS (query() only). StatementSync.columns() answers it exactly but is missing
// from Node releases older than 22.16, and this project supports Node >= 22.13. Without it, the backend
// asks SQLite itself: EXPLAIN <sql> lists the statement's opcodes without running it, and a statement
// returns rows exactly when its program contains a ResultRow opcode. This handles leading comments,
// parentheses, WITH ... UPDATE, RETURNING and PRAGMA with no SQL parsing. Option rowDetection is
// 'auto' (default: columns() when available), 'columns' or 'explain'.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DbLockTimeoutError, TransactionClosedError } from './errors.js';

const MAX_CACHED_STATEMENTS = 500;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30000;

const stackSummary = () => String(new Error().stack || '').split('\n').slice(3, 9).map((l) => l.trim()).join('\n');

export function createSqliteBackend(database, options = {}) {
  if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
    throw new TypeError('createSqliteBackend needs an open node:sqlite DatabaseSync');
  }
  const lockWaitTimeoutMs = options.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const rowDetection = options.rowDetection ?? 'auto';
  if (!['auto', 'columns', 'explain'].includes(rowDetection)) throw new TypeError("rowDetection must be 'auto', 'columns' or 'explain'");

  const statements = new Map();
  const rowKinds = new Map(); // sql -> does it return rows (explain mode)
  const context = new AsyncLocalStorage(); // holds the active transaction handle
  let active = null; // handle of the running transaction

  const prepare = (sql) => {
    let stmt = statements.get(sql);
    if (!stmt) {
      if (statements.size >= MAX_CACHED_STATEMENTS) statements.delete(statements.keys().next().value);
      stmt = database.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };

  const plain = (row) => (row === undefined || row === null ? undefined : { ...row });

  function returnsRows(stmt, sql) {
    if (rowDetection === 'columns' || (rowDetection === 'auto' && typeof stmt.columns === 'function')) {
      return stmt.columns().length > 0;
    }
    let known = rowKinds.get(sql);
    if (known === undefined) {
      // An EXPLAIN statement already returns rows, and EXPLAIN EXPLAIN is not valid.
      known = /^\s*explain\b/i.test(sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, ''))
        || database.prepare(`EXPLAIN ${sql}`).all().some((op) => op.opcode === 'ResultRow');
      rowKinds.set(sql, known);
    }
    return known;
  }

  // Synchronous operations. They run to completion without yielding, so a single statement is atomic
  // with respect to other JavaScript.
  const ops = {
    async get(sql, params = []) { return plain(prepare(sql).get(...params)); },
    async all(sql, params = []) { return prepare(sql).all(...params).map((r) => ({ ...r })); },
    async run(sql, params = []) { return { changes: Number(prepare(sql).run(...params).changes) }; },
    async query(sql, params = []) {
      const stmt = prepare(sql);
      if (returnsRows(stmt, sql)) {
        const rows = stmt.all(...params).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: Number(stmt.run(...params).changes) };
    },
    async exec(sql) { database.exec(sql); }
  };

  // The operations handed to one transaction's callback. They fail once that transaction has finished.
  function transactionOps(handle) {
    const open = (name) => async (...args) => {
      if (handle.finished) throw new TransactionClosedError();
      return ops[name](...args);
    };
    return {
      get: open('get'), all: open('all'), run: open('run'), query: open('query'), exec: open('exec'),
      assertOpen() { if (handle.finished) throw new TransactionClosedError(); }
    };
  }

  // Wait until the given transaction finishes, giving up (WITHOUT touching the lock) at the deadline.
  function waitFor(handle, deadline, what) {
    if (!Number.isFinite(deadline)) return handle.done;
    const remaining = deadline - Date.now();
    const timeoutError = () => new DbLockTimeoutError(
      `Gave up waiting ${lockWaitTimeoutMs} ms for another transaction to finish before ${what}. `
      + 'The transaction still holds the lock and was NOT released or aborted. '
      + 'If this happened inside a transaction callback, the call probably lost its transaction context (for example an event handler created outside the callback).',
      { waitedMs: lockWaitTimeoutMs, holderAgeMs: Date.now() - handle.startedAt, holderStack: handle.startStack }
    );
    if (remaining <= 0) return Promise.reject(timeoutError());
    return new Promise((resolve, reject) => {
      // Deliberately NOT unref'd: while a call is waiting on the lock, the process must not exit silently
      // with that call still pending. The timer is bounded by the wait limit and cleared as soon as the
      // transaction finishes.
      const timer = setTimeout(() => reject(timeoutError()), remaining);
      handle.done.then(() => { clearTimeout(timer); resolve(); });
    });
  }

  const newDeadline = () => (Number.isFinite(lockWaitTimeoutMs) && lockWaitTimeoutMs > 0 ? Date.now() + lockWaitTimeoutMs : Infinity);
  const insideActive = () => active !== null && context.getStore() === active;

  async function transaction(fn) {
    const store = context.getStore();
    if (store && store === active && !store.finished) return fn(store.ops); // nested: join the outer one
    const deadline = newDeadline();
    while (active) await waitFor(active, deadline, 'starting a transaction');

    let release;
    const handle = {
      done: new Promise((resolve) => { release = resolve; }),
      finished: false,
      startedAt: Date.now(),
      startStack: stackSummary()
    };
    handle.ops = transactionOps(handle);
    active = handle;
    try {
      database.exec('BEGIN');
      try {
        const result = await context.run(handle, () => fn(handle.ops));
        database.exec('COMMIT');
        return result;
      } catch (err) {
        try { database.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
        throw err;
      }
    } finally {
      handle.finished = true; // from here on the transaction's own operations reject
      active = null;
      release();
    }
  }

  // Plain statements wait while ANOTHER transaction is open. Code inside the open transaction never waits.
  //
  // The check and the statement must be one synchronous step. An earlier version awaited a helper and then
  // executed: even when nothing was waiting, that await costs a microtask turn, and in that gap another
  // caller's transaction() could run BEGIN, so the statement executed INSIDE that transaction and was lost if
  // it rolled back. ops[name]() runs its statement synchronously when called (its body has no await), so
  // calling it straight after the check keeps the two together. After every wake-up the check is made again
  // (another waiter may have started a transaction first) and, if the lock is taken again, the call waits again.
  const guarded = (name, what) => async (...args) => {
    let deadline;
    for (;;) {
      if (!active || insideActive()) return ops[name](...args);
      deadline ??= newDeadline();
      await waitFor(active, deadline, what);
    }
  };

  return {
    kind: 'sqlite',
    get: guarded('get', 'running a query'),
    all: guarded('all', 'running a query'),
    run: guarded('run', 'running a statement'),
    query: guarded('query', 'running a statement'),
    exec: guarded('exec', 'running statements'),
    transaction,
    diagnostics() {
      return { transaction: active ? { ageMs: Date.now() - active.startedAt, startedAt: active.startStack } : null };
    },
    async close() {
      while (active) await active.done;
      statements.clear();
      rowKinds.clear();
      database.close();
    }
  };
}
