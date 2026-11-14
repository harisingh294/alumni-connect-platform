// Columns that exist only as database bookkeeping and must never reach application code.
//
// Why this exists. The PostgreSQL schema (db/migrations/001_init.sql) gives messages and audit_logs an
// identity column named seq. It replaces SQLite's rowid as the tie-breaker when rows share a timestamp
// (ORDER BY created_at, seq). The SQLite schema has no such column. A query written as SELECT * on those two
// tables, such as the institution data export (server/routes/admin_institution.js, audit_logs), would
// therefore start returning an extra field on PostgreSQL.
//
// What this module does NOT do: it never removes a result column because of its NAME. An earlier version of
// the facade deleted every property called seq from every result, which would have silently dropped a column
// or alias that the application selected on purpose. Hiding is decided by where a result column COMES FROM:
// only a column that the database reports as the identity column of one of the tables below is ever hidden.
//
// How a backend uses it. The PostgreSQL backend (a later phase) knows, for every result column, which table
// and column it originates from (the pg driver reports each field's table OID and column number, which the
// backend maps to names through the catalog). It passes that to stripInternalColumns(). A column that is an
// expression (COUNT(*) AS seq, ROW_NUMBER() ... AS seq) or comes from any other table has no matching
// source, so it is never touched. The SQLite backend needs nothing: its schema has no internal columns.
//
// Pure: no database access, no side effects.

export const INTERNAL_COLUMNS = Object.freeze([
  Object.freeze({ table: 'messages', column: 'seq' }),
  Object.freeze({ table: 'audit_logs', column: 'seq' })
]);

const INTERNAL_KEYS = new Set(INTERNAL_COLUMNS.map((c) => `${c.table}.${c.column}`));

// Is table.column one of the internal columns? Names are bare table and column names, no schema prefix.
export const isInternalColumn = (table, column) => INTERNAL_KEYS.has(`${table}.${column}`);

// fields describes each RESULT column by where it comes from:
//   [{ name, table, column }]   table and column are null (or undefined) for expressions and aliases.
// Returns the result column names that may be removed: those whose EVERY occurrence in the result is an
// internal column. If an unrelated column or alias shares the name (SELECT *, 1 AS seq ...), the name is kept,
// because a row object cannot tell the two apart and silently dropping real data is worse than keeping the
// internal value.
export function internalResultNames(fields) {
  const onlyInternal = new Map();
  for (const f of fields) {
    const internal = f.table != null && f.column != null && isInternalColumn(f.table, f.column);
    onlyInternal.set(f.name, (onlyInternal.get(f.name) ?? true) && internal);
  }
  return [...onlyInternal].filter(([, all]) => all).map(([name]) => name);
}

// Returns rows without the internal columns, never mutating the input. When there is nothing to hide the
// SAME rows array is returned untouched.
export function stripInternalColumns(rows, fields) {
  const names = internalResultNames(fields);
  if (names.length === 0) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const name of names) delete copy[name];
    return copy;
  });
}
