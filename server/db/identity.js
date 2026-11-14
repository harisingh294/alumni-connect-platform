// Runs the identity-sequence reset (statements come from ./sql.js). Pure orchestration over a handle the
// CALLER provides; it opens nothing, imports no driver and is NOT USED BY THE APPLICATION YET.
//
// Usage (PostgreSQL only; the SQLite schema has no identity columns):
//
//   await db.transaction(async (tx) => {
//     ... import rows with explicit seq values using tx ...
//     await resetIdentitySequences(tx);
//   });
//
// Rules:
//   * Pass the handle given to a transaction callback. The helper never starts, commits or rolls back a
//     transaction (it never calls transaction()), so it composes inside the caller's one transaction and the
//     caller keeps full ownership of commit and rollback.
//   * For each table it first takes LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE. That blocks every other
//     session's writes to the table until the caller's transaction ends, so nothing can insert between
//     reading MAX(seq) and setval. Callers that import data do not need to stop the application for
//     correctness, but writers to these tables will WAIT (and may hit lock timeouts) until commit, so run
//     the import in a maintenance window.
//   * Called outside a transaction the LOCK statement fails in PostgreSQL ("can only be used in transaction
//     blocks"), and the error is rethrown here with context. Nothing has been changed at that point.
//   * A missing table, column or owned sequence throws IdentityResetError; it never silently does nothing.
import { IDENTITY_TABLES, pgLockForResetSql, pgIdentitySequenceNameSql, pgResetIdentitySql } from './sql.js';

export class IdentityResetError extends Error {
  constructor(message, { table, column, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'IdentityResetError';
    this.code = 'IDENTITY_RESET_FAILED';
    this.table = table;
    this.column = column;
  }
}

async function step(table, column, what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IdentityResetError) throw err;
    throw new IdentityResetError(`cannot reset the identity sequence of ${table}.${column}: ${what} failed: ${err?.message ?? err}`, { table, column, cause: err });
  }
}

// tx: a handle with get() and run() (the object a transaction callback receives).
// Returns [{ table, column, nextValue }] where nextValue is the next value the sequence will hand out.
export async function resetIdentitySequences(tx, tables = IDENTITY_TABLES, column = 'seq') {
  if (typeof tx?.get !== 'function' || typeof tx?.run !== 'function') throw new TypeError('resetIdentitySequences needs the handle of an open transaction');
  if (!Array.isArray(tables) || tables.length === 0) throw new TypeError('tables must be a non-empty array');
  const results = [];
  for (const table of tables) {
    // Statement builders validate the names (plain lowercase identifiers) before anything runs.
    const lock = pgLockForResetSql(table);
    const lookup = pgIdentitySequenceNameSql(table, column);
    const reset = pgResetIdentitySql(table, column);
    await step(table, column, 'locking the table (is this running inside a transaction?)', () => tx.run(lock));
    const named = await step(table, column, 'looking up the sequence', () => tx.get(lookup));
    if (!named || named.sequence_name == null) {
      throw new IdentityResetError(`${table}.${column} has no owned sequence (pg_get_serial_sequence returned NULL); it is not an identity or serial column, so nothing was reset`, { table, column });
    }
    const row = await step(table, column, 'setval', () => tx.get(reset));
    if (!row || row.next_value == null) {
      throw new IdentityResetError(`setval returned no value for ${table}.${column}; the sequence was not reset`, { table, column });
    }
    results.push({ table, column, nextValue: row.next_value });
  }
  return results;
}
