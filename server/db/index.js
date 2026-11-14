// Async database facade.
//
//   const db = createSqliteDb(openDatabaseSync);   // a handle the CALLER opened
//   const row  = await db.get('SELECT * FROM users WHERE id = ?', id);   // row | undefined
//   const rows = await db.all('SELECT * FROM users WHERE role = ?', 'ALUMNI');
//   const { changes } = await db.run('UPDATE users SET is_active = 0 WHERE id = ?', id);
//   await db.transaction(async (tx) => { await tx.run(...); await tx.run(...); });
//
// SQL is written with `?` placeholders and parameters are passed variadically, mirroring the existing
// `db.prepare(sql).get(a, b)` call style so the later conversion is mostly mechanical.
//
// This module opens nothing and imports nothing from the application. It is NOT USED BY THE
// APPLICATION YET: server/db.js, the routes and the seed still use the synchronous database directly.
import { createSqliteBackend } from './sqlite-backend.js';

export { translatePlaceholders } from './sql.js';
export { classifyDbError, isUniqueViolation, isRetryableDbError, DbLockTimeoutError, TransactionClosedError } from './errors.js';
export { createSqliteBackend } from './sqlite-backend.js';
export { resetIdentitySequences, IdentityResetError } from './identity.js';

// The same parameter rules for every backend. node:sqlite already rejects these, and PostgreSQL
// would silently convert them, so the facade enforces them up front for both.
export function checkParams(params) {
  params.forEach((value, i) => {
    const n = i + 1;
    if (value === undefined) throw new TypeError(`SQL parameter ${n} is undefined`);
    if (typeof value === 'boolean') throw new TypeError(`SQL parameter ${n} is a boolean; use 1 or 0`);
    if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError(`SQL parameter ${n} has an unsupported type`);
    if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
      throw new TypeError(`SQL parameter ${n} is an object; pass a string, number, bigint, Buffer or null`);
    }
  });
  return params;
}

// Engine-internal columns (the PostgreSQL identity column seq on messages and audit_logs) are NOT filtered
// here. This facade never changes a result by column NAME: a column or alias called seq that the application
// selected on purpose is returned exactly as the database produced it. Hiding internal columns is the job of
// each backend, which knows where every result column comes from (see ./internal-columns.js).
export { INTERNAL_COLUMNS, isInternalColumn, stripInternalColumns } from './internal-columns.js';

function variadic(ops) {
  const sql = (s) => {
    if (typeof s !== 'string' || !s.trim()) throw new TypeError('SQL must be a non-empty string');
    return s;
  };
  return {
    async get(s, ...params) { return ops.get(sql(s), checkParams(params)); },
    async all(s, ...params) { return ops.all(sql(s), checkParams(params)); },
    async run(s, ...params) { return ops.run(sql(s), checkParams(params)); },
    async query(s, ...params) { return ops.query(sql(s), checkParams(params)); },
    async exec(s) { return ops.exec(sql(s)); }
  };
}

export function createDb(backend) {
  for (const method of ['get', 'all', 'run', 'query', 'exec', 'transaction', 'close']) {
    if (typeof backend?.[method] !== 'function') throw new TypeError(`database backend is missing ${method}()`);
  }
  // The object handed to a transaction callback: the same API, bound to the open transaction. It stops
  // working when the transaction finishes (the backend rejects with TransactionClosedError).
  const txApi = (ops) => ({
    ...variadic(ops),
    transaction: async (inner) => {
      ops.assertOpen?.(); // a finished transaction's handle cannot start work
      return backend.transaction((o) => inner(txApi(o)));
    }
  });
  return {
    kind: backend.kind,
    ...variadic(backend),
    // Root calls made inside fn join the same transaction too. Throwing (or rejecting) rolls back and
    // rethrows the same error object. A transaction started inside another one joins it (no savepoints).
    transaction: (fn) => backend.transaction((ops) => fn(txApi(ops))),
    diagnostics: () => (typeof backend.diagnostics === 'function' ? backend.diagnostics() : null),
    close: () => backend.close()
  };
}

export const createSqliteDb = (database, options) => createDb(createSqliteBackend(database, options));
