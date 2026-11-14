// Data preflight for the SQLite -> PostgreSQL migration.
//
// SQLite is dynamically typed: a column declared INTEGER can hold text, a real number or a value outside
// PostgreSQL's 32-bit range, a TEXT column can hold NUL characters or bytes that are not valid UTF-8, a
// TEXT PRIMARY KEY can be NULL, and CHECK constraints are not re-validated for rows that were written with
// them switched off. PostgreSQL rejects (or silently changes) all of these at import time. These read-only
// checks find such rows BEFORE any import, so a bad value is fixed or understood first.
//
// READ-ONLY, FAIL CLOSED. runPreflight() accepts ONLY a handle made by openSnapshotForPreflight() (for the real
// database, which runs in WAL mode) or openReadOnlyForPreflight() (a standalone rollback-journal file). Both
// open the file with node:sqlite's readOnly option, prove on a throwaway canary path that the option is really
// honored by this runtime (a writable open would create the canary file), turn on PRAGMA query_only and read it
// back, and return a wrapper that will only prepare a fixed set of SELECT and PRAGMA statements. If any of that
// cannot be guaranteed they throw. There is no fallback to a writable connection, no way to inject an opener,
// and a handle made any other way (including a plain DatabaseSync) is refused.
//
// WAL. The application's database is in WAL mode, where committed data can live in the -wal file. The real
// database is therefore never opened directly: openSnapshotForPreflight() first copies main file + WAL into a
// private temporary directory with server/db/snapshot.js (which only reads the source and refuses an
// inconsistent copy) and inspects that copy. openReadOnlyForPreflight() refuses a WAL-mode file, and any file
// with -wal, -shm or -journal files next to it.
//
// Every result says what KIND of finding it is:
//   severity 'blocker'      the migration must not proceed while status is 'found'
//   severity 'warning'      needs a human decision; not necessarily wrong
//   severity 'unverifiable' this check could not be performed reliably (status is 'unverifiable', bad is null)
//
// USAGE (always close the handle; the snapshot is a full copy of the data in a temporary directory):
//
//   const handle = openSnapshotForPreflight('/path/to/alumni_platform.db');
//   try {
//     const results = runPreflight(handle);
//     const summary = summarizePreflight(results);   // outcome: 'blocked' | 'needs_review' | 'clear'
//   } finally {
//     handle.close();                                 // never throws; returns { cleaned, directory, ... }
//   }
//
// or let withSnapshotForPreflight(path, options, (handle) => ...) do the try/finally. As a backstop the module also
// removes the snapshot directories it created, and only those, when the process exits normally.
//
// This module never touches the application's database. NOT USED BY THE APPLICATION. See db/README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SnapshotError, parseMainHeader, takeSnapshot } from './snapshot.js';
import { isTestProcess } from '../dblocation.js';

// Columns that are BIGINT in PostgreSQL: money, and values written from user input with no upper bound.
// Must match db/migrations/001_init.sql (tests/ddl-parity.test.js enforces it).
export const WIDE_INTEGER_COLUMNS = Object.freeze([
  'institutions.founded', 'courses.seats', 'courses.annual_fee_inr', 'placement_stats.students_eligible',
  'placement_stats.students_placed', 'roster_records.graduation_year', 'alumni_profiles.graduation_year',
  'subscriptions.amount_inr', 'institution_invoices.amount_inr', 'internships.stipend_inr_month',
  'mentorship_programs.mentee_capacity', 'events.capacity'
]);

// INTEGER columns that hold 0 or 1.
export const FLAG_COLUMNS = Object.freeze([
  'institutions.public_profile', 'institutions.platform_verified', 'institutions.is_sandbox',
  'users.is_active', 'users.is_sandbox', 'alumni_profiles.is_open_to_mentoring', 'alumni_profiles.open_to_external',
  'career_steps.is_current', 'subscriptions.auto_renew', 'institution_subscriptions.cancel_at_period_end',
  'mentorship_requests.is_external', 'announcements.pinned'
]);

// INTEGER (32-bit) columns whose values the app generates or range-checks. Checked against the int4 range.
export const INT4_COLUMNS = Object.freeze([
  'institutions.hue', 'alumni_profiles.stale_months', 'career_steps.year', 'career_steps.display_order',
  'student_profiles.graduation_year', 'placement_stats.year', 'internships.duration_weeks'
]);

// Largest integer JavaScript Numbers represent exactly. The app reads integers as Numbers.
export const MAX_SAFE = 9007199254740991;

// Strict: letters, digits and underscore, not starting with a digit. Uppercase is valid in SQLite. Every
// identifier is emitted double-quoted, and the pattern excludes quotes, spaces, dots and semicolons, so a
// name can never break out of its quotes.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ident = (name) => {
  // typeof matters: String(null) is "null", which would otherwise pass as an identifier
  if (typeof name !== 'string' || !IDENT_RE.test(name)) throw new Error(`Unsupported identifier in preflight: ${JSON.stringify(String(name))}`);
  return name;
};
const q = (name) => `"${ident(name)}"`;
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

const SPACE_TS = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]*'";
const ISO_TS = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]*'";
const DATE_ONLY = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
// Columns that hold timestamps or dates, by NAME (starts_at, created_at, ends_on, ...). A name rule can miss a
// differently named timestamp column; that is a documented limitation.
export const isTimestampColumnName = (name) => /(_at|_on|_date)$/.test(name) || /^(date|timestamp)$/.test(name);

// Extracts the expression of every CHECK(...) in a CREATE TABLE statement (column and table level). Respects
// string literals, quoted identifiers and comments. Returns null if the text cannot be parsed reliably.
export function extractCheckExpressions(createSql) {
  if (typeof createSql !== 'string') return [];
  const out = [];
  const n = createSql.length;
  const skipQuoted = (i, quote) => { // createSql[i] is the opening quote; returns the index after the closing one
    const close = quote === '[' ? ']' : quote;
    let j = i + 1;
    while (j < n) {
      if (createSql[j] === close) {
        if (quote !== '[' && createSql[j + 1] === close) { j += 2; continue; }
        return j + 1;
      }
      j += 1;
    }
    return -1;
  };
  let i = 0;
  while (i < n) {
    const c = createSql[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') { i = skipQuoted(i, c); if (i < 0) return null; continue; }
    if (c === '-' && createSql[i + 1] === '-') { const e = createSql.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c === '/' && createSql[i + 1] === '*') { const e = createSql.indexOf('*/', i + 2); if (e < 0) return null; i = e + 2; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(createSql[j])) j += 1;
      if (createSql.slice(i, j).toUpperCase() === 'CHECK') {
        let k = j;
        while (k < n && /\s/.test(createSql[k])) k += 1;
        if (createSql[k] !== '(') return null;
        let depth = 0;
        let m = k;
        for (; m < n; m += 1) {
          const d = createSql[m];
          if (d === "'" || d === '"' || d === '`' || d === '[') { m = skipQuoted(m, d) - 1; if (m < 0) return null; continue; }
          if (d === '-' && createSql[m + 1] === '-') { const e = createSql.indexOf('\n', m); if (e < 0) return null; m = e; continue; }
          if (d === '/' && createSql[m + 1] === '*') { const e = createSql.indexOf('*/', m + 2); if (e < 0) return null; m = e + 1; continue; }
          if (d === '(') depth += 1;
          else if (d === ')') { depth -= 1; if (depth === 0) break; }
        }
        if (depth !== 0) return null;
        out.push(createSql.slice(k + 1, m).trim());
        i = m + 1;
        continue;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

// Rows of PRAGMA foreign_key_list that share an `id` are the columns of ONE (possibly composite) foreign key,
// ordered by `seq`. Rows without an id (hand-built input) are each their own key.
function foreignKeyGroups(rows) {
  const groups = new Map();
  rows.forEach((r, i) => {
    const key = r.id === undefined ? `solo:${i}` : `id:${r.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, seq: r.seq ?? 0, order: i });
  });
  return [...groups.values()].map((g) => g.sort((a, b) => a.seq - b.seq || a.order - b.order));
}

// tables: [{ name, sql?, primaryKey?: [column names in key order], columns: [{ name, type, pk? }],
//            fks: [{ id?, seq?, from, table, to }] }]
// A foreign key whose `to` is null (REFERENCES parent) is resolved to the parent's primary key; if that cannot be
// done unambiguously the check is reported as unverifiable.
// Returns [{ id, description, severity, kind, sql, ... }]. kind: 'count' (sql returns `bad`), 'check'
// (a CHECK expression; may be unverifiable), 'utf8' (bytes validated in JS), 'static' (decided from names),
// 'unverifiable' (cannot be checked; carries `reason`).
export function buildPreflightQueries(tables) {
  const wide = new Set(WIDE_INTEGER_COLUMNS);
  const flags = new Set(FLAG_COLUMNS);
  const queries = [];
  const add = (id, description, sql, extra = {}) => queries.push({ id, description, severity: 'blocker', kind: 'count', sql, ...extra });
  const unverifiable = (id, description, reason) => queries.push({ id, description, severity: 'unverifiable', kind: 'unverifiable', sql: null, reason });

  const tablesByLower = new Map(tables.map((t) => [String(t.name).toLowerCase(), t]));
  const seen = new Map();
  for (const t of tables) {
    const name = ident(t.name);
    const key = name.toLowerCase();
    if (seen.has(key) && seen.get(key) !== name) {
      queries.push({ id: `${name}:name-collision`, description: `table names ${seen.get(key)} and ${name} differ only by case; PostgreSQL would fold them into one`, severity: 'blocker', kind: 'static', sql: null, bad: 1 });
    }
    seen.set(key, name);
  }

  for (const t of tables) {
    const table = ident(t.name);
    const T = q(table);
    if (/[A-Z]/.test(table)) {
      queries.push({ id: `${table}:uppercase-name`, description: 'table name has uppercase letters; the PostgreSQL schema uses lowercase unquoted names, so it must be created lowercase (or always quoted)', severity: 'warning', kind: 'static', sql: null, bad: 1 });
    }
    const columnsByLower = new Map();
    for (const c of t.columns) {
      const col = ident(c.name);
      const C = q(col);
      const key = `${table}.${col}`;
      if (columnsByLower.has(col.toLowerCase()) && columnsByLower.get(col.toLowerCase()) !== col) {
        queries.push({ id: `${key}:name-collision`, description: `column names ${columnsByLower.get(col.toLowerCase())} and ${col} differ only by case`, severity: 'blocker', kind: 'static', sql: null, bad: 1 });
      }
      columnsByLower.set(col.toLowerCase(), col);
      if (/[A-Z]/.test(col)) {
        queries.push({ id: `${key}:uppercase-name`, description: 'column name has uppercase letters; PostgreSQL folds unquoted names to lowercase', severity: 'warning', kind: 'static', sql: null, bad: 1 });
      }
      const present = `${C} IS NOT NULL`;
      const type = String(c.type).toUpperCase();
      if (c.pk) {
        add(`${key}:pk-null`, 'primary key column must not be NULL (SQLite allows NULL in a TEXT PRIMARY KEY; PostgreSQL does not)', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${C} IS NULL`);
      }
      if (type === 'INTEGER') {
        if (flags.has(key)) {
          add(`${key}:flag`, 'must be the integer 0 or 1', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND (typeof(${C}) <> 'integer' OR ${C} NOT IN (0, 1))`);
        } else if (wide.has(key)) {
          add(`${key}:bigint`, 'must be a whole number (PostgreSQL BIGINT)', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND typeof(${C}) <> 'integer'`);
          add(`${key}:safe-integer`, `must be within +/-(2^53 - 1) = +/-${MAX_SAFE}; the application reads integers as JavaScript Numbers, which lose precision beyond that`, `SELECT COUNT(*) AS bad FROM ${T} WHERE typeof(${C}) = 'integer' AND (${C} > ${MAX_SAFE} OR ${C} < -${MAX_SAFE})`);
        } else {
          add(`${key}:int4`, 'must be a whole number inside the 32-bit range (PostgreSQL INTEGER)', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND (typeof(${C}) <> 'integer' OR ${C} < ${INT4_MIN} OR ${C} > ${INT4_MAX})`);
        }
      } else if (type === 'REAL') {
        add(`${key}:double`, 'must be a number (PostgreSQL DOUBLE PRECISION)', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND typeof(${C}) NOT IN ('real', 'integer')`);
      } else if (type === 'TEXT') {
        add(`${key}:text`, 'must be text without NUL characters (PostgreSQL TEXT cannot hold them)', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND (typeof(${C}) <> 'text' OR instr(CAST(${C} AS BLOB), x'00') > 0)`,
          { sqlNotUtf8: `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND typeof(${C}) <> 'text'` });
        queries.push({ id: `${key}:utf8`, description: 'text must be valid UTF-8 (PostgreSQL rejects invalid byte sequences; a lossy decode would silently insert U+FFFD)', severity: 'blocker', kind: 'utf8', sql: `SELECT CAST(${C} AS BLOB) AS v FROM ${T} WHERE typeof(${C}) = 'text'` });
        add(`${key}:replacement-char`, 'contains the Unicode replacement character U+FFFD, a sign that the text was already decoded lossily; review the rows', `SELECT COUNT(*) AS bad FROM ${T} WHERE typeof(${C}) = 'text' AND instr(${C}, char(65533)) > 0`, { severity: 'warning' });
        if (col.endsWith('_json')) {
          add(`${key}:json`, 'must be valid JSON (the app calls JSON.parse on it)', `SELECT COUNT(*) AS bad FROM ${T} WHERE ${present} AND json_valid(${C}) = 0`);
        }
        if (isTimestampColumnName(col)) {
          add(`${key}:timestamp-format`, "timestamps must use one format. Rows NOT in the most common of: 'YYYY-MM-DD HH:MM:SS' (SQLite), 'YYYY-MM-DDTHH:MM...' (ISO), 'YYYY-MM-DD'; unrecognized values always count",
            `SELECT COUNT(${C}) - CAST(MAX(TOTAL(${C} GLOB ${SPACE_TS}), TOTAL(${C} GLOB ${ISO_TS}), TOTAL(${C} GLOB ${DATE_ONLY})) AS INTEGER) AS bad FROM ${T}`, { severity: 'warning' });
        }
      } else {
        unverifiable(`${key}:type`, `column is declared as ${JSON.stringify(String(c.type))}, which the preflight has no check for`, 'only INTEGER, REAL and TEXT columns are classified');
      }
    }
    for (const group of foreignKeyGroups(t.fks || [])) {
      const parentName = ident(group[0].table);
      const from = group.map((r) => ident(r.from));
      const label = `${table}.${from.length === 1 ? from[0] : `(${from.join(',')})`}->${parentName}`;
      const parent = tablesByLower.get(parentName.toLowerCase());
      if (!parent) { unverifiable(`${label}:orphans`, 'foreign key must reference an existing row', `the referenced table ${parentName} is not in the schema`); continue; }
      let to;
      if (group.every((r) => r.to == null)) {
        // REFERENCES parent (no column list): SQLite means the parent's PRIMARY KEY, in key order.
        const pk = parent.primaryKey ?? parent.columns.filter((c) => c.pk).map((c) => c.name);
        if (pk.length === 0) { unverifiable(`${label}.(implicit):orphans`, 'foreign key must reference an existing row', `it names no parent column and ${parent.name} has no declared primary key`); continue; }
        if (pk.length !== from.length) { unverifiable(`${label}.(implicit):orphans`, 'foreign key must reference an existing row', `it names no parent column; ${parent.name} has a ${pk.length}-column primary key but the foreign key has ${from.length} column(s)`); continue; }
        to = pk.map(ident);
      } else if (group.some((r) => r.to == null)) {
        unverifiable(`${label}:orphans`, 'foreign key must reference an existing row', 'only some referenced columns are named');
        continue;
      } else {
        to = group.map((r) => ident(r.to));
        const known = new Set(parent.columns.map((c) => c.name.toLowerCase()));
        const missing = to.filter((c) => !known.has(c.toLowerCase()));
        if (missing.length) { unverifiable(`${label}.${to.join(',')}:orphans`, 'foreign key must reference an existing row', `${parent.name} has no column ${missing.join(', ')}`); continue; }
      }
      const P = q(parent.name);
      add(`${label}.${to.length === 1 ? to[0] : `(${to.join(',')})`}:orphans`, 'must reference an existing row (PostgreSQL always enforces foreign keys)',
        `SELECT COUNT(*) AS bad FROM ${T} AS c LEFT JOIN ${P} AS p ON ${from.map((f, i) => `c.${q(f)} = p.${q(to[i])}`).join(' AND ')} WHERE ${from.map((f) => `c.${q(f)} IS NOT NULL`).join(' AND ')} AND p.${q(to[0])} IS NULL`);
    }
    if (typeof t.sql === 'string') {
      const checks = extractCheckExpressions(t.sql);
      if (checks === null) {
        unverifiable(`${table}:check`, 'CHECK constraints of this table', 'the CREATE TABLE statement could not be parsed reliably');
      } else {
        checks.forEach((expr, i) => {
          // A CHECK fails only when its expression is false; NULL passes. NOT (NULL) is NULL, so NULL rows are not counted.
          add(`${table}:check:${i + 1}`, `existing rows must satisfy CHECK(${expr.replace(/\s+/g, ' ').slice(0, 120)})`, `SELECT COUNT(*) AS bad FROM ${T} WHERE NOT (\n${expr}\n)`, { kind: 'check' });
        });
      }
    }
  }
  return queries;
}

// Reads the schema from an open SQLite handle (SELECT and PRAGMA table_info / foreign_key_list only).
export function introspectSqlite(database) {
  return database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name, sql }) => {
    const info = database.prepare(`PRAGMA table_info(${q(name)})`).all();
    return {
      name,
      sql,
      columns: info.map((c) => ({ name: c.name, type: c.type, pk: c.pk > 0 })),
      primaryKey: info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
      fks: database.prepare(`PRAGMA foreign_key_list(${q(name)})`).all().map((f) => ({ id: f.id, seq: f.seq, from: f.from, table: f.table, to: f.to }))
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Read-only handle
// ---------------------------------------------------------------------------------------------

export class PreflightReadOnlyError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PreflightReadOnlyError';
    this.code = 'PREFLIGHT_NOT_READ_ONLY';
  }
}

// The only statements the wrapper will prepare.
const ALLOWED_SQL = [
  /^\s*SELECT\b[^;]*;?\s*$/i,
  /^\s*PRAGMA\s+table_info\("[A-Za-z_][A-Za-z0-9_]*"\)\s*;?\s*$/i,
  /^\s*PRAGMA\s+foreign_key_list\("[A-Za-z_][A-Za-z0-9_]*"\)\s*;?\s*$/i,
  /^\s*PRAGMA\s+(?:encoding|query_only)\s*;?\s*$/i
];
const READ_ONLY_HANDLES = new WeakSet();
const defaultOpen = (p, o) => new DatabaseSync(p, o);
// The exported test seams below may only be used by a test process (the repository's own marker: NODE_TEST_CONTEXT,
// a *.test.js entry point or --test). They grant no read-only capability either way; this keeps production code from
// changing cleanup behavior or running an arbitrary opener against a real path.
function assertTestProcess(name) {
  if (!isTestProcess()) throw new PreflightReadOnlyError(`${name} is a test seam and may only be called from a test process`);
}
const refuseOpen = (why, cause) => new PreflightReadOnlyError(`preflight refuses to run: ${why}`, cause ? { cause } : undefined);

// Opens filePath read-only and proves it. `open` is a PRIVATE parameter: the exported functions below always pass
// node:sqlite, so no caller can supply an opener and receive the read-only capability. Returns the raw handle.
function openVerified(filePath, open) {
  // Canary: a read-only open of a path that does not exist must FAIL with SQLITE_CANTOPEN. If this runtime
  // ignored the option the open would succeed and create the file. The canary lives in a fresh temporary
  // directory, never next to data, and is completed BEFORE the target file is opened.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-canary-'));
  try {
    const canary = path.join(dir, 'canary.db');
    let failure = null;
    try {
      const probe = open(canary, { readOnly: true });
      try { probe.close(); } catch { /* ignore */ }
    } catch (err) {
      failure = err;
    }
    if (!failure || fs.existsSync(canary)) throw refuseOpen('this Node.js did not honor the readOnly option (a canary database was created); upgrade Node.js (>= 22.13)');
    if (!(failure.errcode === 14 || /unable to open/i.test(String(failure.message)))) {
      throw refuseOpen(`the readOnly canary failed for an unexpected reason, so read-only support could not be proven: ${failure.message ?? failure}`, failure);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  let raw;
  try {
    raw = open(filePath, { readOnly: true });
  } catch (err) {
    throw refuseOpen(`cannot open ${filePath} read-only: ${err?.message ?? err}`, err);
  }
  try {
    raw.exec('PRAGMA query_only = ON');
    const flag = raw.prepare('PRAGMA query_only').get();
    if (Number(flag?.query_only) !== 1) throw refuseOpen('PRAGMA query_only could not be enabled');
  } catch (err) {
    try { raw.close(); } catch { /* ignore */ }
    throw err instanceof PreflightReadOnlyError ? err : refuseOpen(`cannot enable query_only: ${err?.message ?? err}`, err);
  }
  return raw;
}

// Snapshot directories created by THIS process, by exact path. Only these are ever removed, by close() or at exit.
const LIVE_SNAPSHOTS = new Map(); // directory -> () => void (closes the database held in it)
const CLEANUP_FAILURES = new Map(); // directory -> error message, for directories that could not be removed
const SNAPSHOT_DIR_PREFIX = 'preflight-snapshot-';
let removeDirectory = (dir) => fs.rmSync(dir, { recursive: true, force: true });
let exitHookInstalled = false;

function guardedRemove(dir) {
  // Never delete anything that is not a directory this module created.
  if (!LIVE_SNAPSHOTS.has(dir) && !CLEANUP_FAILURES.has(dir)) throw new Error(`refusing to delete ${dir}: not a snapshot directory created by this process`);
  if (!path.basename(dir).startsWith(SNAPSHOT_DIR_PREFIX)) throw new Error(`refusing to delete ${dir}: unexpected name`);
  removeDirectory(dir);
  if (fs.existsSync(dir)) throw new Error(`${dir} still exists after removal`);
}

// Removes a snapshot directory without ever throwing. Returns { cleaned, directory, error? }. A failure is NOT
// reported as success: the directory stays registered (the exit hook and retrySnapshotCleanup() try again), and a
// process warning is emitted.
function cleanupSnapshotDirectory(dir) {
  try {
    guardedRemove(dir);
    LIVE_SNAPSHOTS.delete(dir);
    CLEANUP_FAILURES.delete(dir);
    return { cleaned: true, directory: dir };
  } catch (err) {
    const message = String(err?.message ?? err);
    CLEANUP_FAILURES.set(dir, message);
    LIVE_SNAPSHOTS.delete(dir);
    try {
      process.emitWarning(`the preflight snapshot directory ${dir} could NOT be removed (${message}); it contains a copy of the database and must be deleted manually`, { type: 'PreflightSnapshotCleanupWarning', code: 'PREFLIGHT_SNAPSHOT_CLEANUP_FAILED' });
    } catch { /* a warning must never throw */ }
    return { cleaned: false, directory: dir, error: message };
  }
}

function registerSnapshotDirectory(dir, closeDatabase) {
  LIVE_SNAPSHOTS.set(dir, closeDatabase);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [dir2, close] of [...LIVE_SNAPSHOTS]) {
      try { close(); } catch { /* best effort */ }
      try { guardedRemove(dir2); } catch { /* best effort: nothing may throw during exit */ }
    }
    for (const dir2 of [...CLEANUP_FAILURES.keys()]) {
      try { guardedRemove(dir2); } catch { /* best effort */ }
    }
  });
}

// Directories this process created and could not remove: [{ directory, error }].
export const snapshotCleanupFailures = () => [...CLEANUP_FAILURES].map(([directory, error]) => ({ directory, error }));
// Tries again to remove directories that earlier failed. Returns how many could not be removed.
export function retrySnapshotCleanup() {
  for (const dir of [...CLEANUP_FAILURES.keys()]) {
    try { guardedRemove(dir); CLEANUP_FAILURES.delete(dir); } catch (err) { CLEANUP_FAILURES.set(dir, String(err?.message ?? err)); }
  }
  return CLEANUP_FAILURES.size;
}
// TEST SEAM: replaces how a directory is deleted (to simulate a failing delete). Returns a function that restores it.
// It affects deletion only; it cannot create a handle or weaken any read-only proof.
export function setSnapshotRemoverForTests(fn) {
  assertTestProcess('setSnapshotRemoverForTests');
  const previous = removeDirectory;
  removeDirectory = fn;
  return () => { removeDirectory = previous; };
}

function makeHandle(raw, { snapshot = null, directory = null } = {}) {
  let closed = null;
  const handle = Object.freeze({
    snapshot,
    prepare(sql) {
      if (typeof sql !== 'string' || !ALLOWED_SQL.some((re) => re.test(sql))) throw new PreflightReadOnlyError(`the read-only preflight handle refuses to prepare: ${String(sql).slice(0, 80)}`);
      return raw.prepare(sql);
    },
    // Never throws. Returns { cleaned, directory } (+ error / closeError when something went wrong); closing twice
    // returns the first result. For a snapshot, cleaned: false means the directory STILL EXISTS.
    close() {
      if (closed) return closed;
      let closeError;
      try { raw.close(); } catch (err) { closeError = String(err?.message ?? err); }
      const result = directory ? cleanupSnapshotDirectory(directory) : { cleaned: true, directory: null };
      if (closeError) {
        result.closeError = closeError;
        try { process.emitWarning(`closing the preflight database failed: ${closeError}`, { type: 'PreflightCloseWarning' }); } catch { /* ignore */ }
      }
      closed = Object.freeze(result);
      return closed;
    }
  });
  READ_ONLY_HANDLES.add(handle);
  return handle;
}

function readHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try { const b = Buffer.alloc(100); return b.subarray(0, fs.readSync(fd, b, 0, 100, 0)); } finally { fs.closeSync(fd); }
}

// Opens a standalone ROLLBACK-JOURNAL database file read-only. It refuses a WAL-mode file (its committed data may
// be in a -wal file that this function cannot vouch for) and any file with -wal, -shm or -journal files next to
// it: use openSnapshotForPreflight() for the real database. filePath should be a copy; nothing is ever written.
export function openReadOnlyForPreflight(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath === ':memory:' || filePath.startsWith('file:')) {
    throw refuseOpen('a path to a database file is required (in-memory databases and URIs cannot be guaranteed read-only)');
  }
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) throw refuseOpen(`${filePath} is not an existing regular file (it must exist; read-only mode never creates one)`);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (fs.existsSync(filePath + suffix)) throw refuseOpen(`${filePath + suffix} exists: the database may have committed or uncommitted data outside the main file. Use openSnapshotForPreflight() on the original location`);
  }
  let info;
  try { info = parseMainHeader(readHeader(filePath)); } catch (err) { throw refuseOpen(err instanceof SnapshotError ? err.message.replace(/^snapshot refused: /, '') : String(err?.message ?? err), err); }
  if (info.journalMode !== 'rollback') {
    throw refuseOpen('this database is in WAL mode, so its committed data may be in a -wal file; copying only the main file can lose data. Use openSnapshotForPreflight() on the original location');
  }
  return makeHandle(openVerified(filePath, defaultOpen));
}

// Direct read-only proof for a DISPOSABLE snapshot: with the soft query_only guard switched off, a write must be
// rejected by the connection itself as read-only. The write is inside a transaction that is always rolled back, so
// even a writable connection would leave nothing behind; and the connection only ever points at the snapshot copy,
// never at a source file. query_only is switched back on and read back.
function proveReadOnlyByWriting(raw) {
  const isReadOnlyError = (err) => err && ((Number(err.errcode) & 0xff) === 8 || /readonly database/i.test(String(err.message)));
  let verdict = 'written';
  let unexpected = null;
  raw.exec('PRAGMA query_only = OFF');
  try {
    // The probe only means something if the soft guard is really off: otherwise a writable connection would
    // also "reject" the write, and the connection itself would never have been tested.
    if (Number(raw.prepare('PRAGMA query_only').get()?.query_only) !== 0) throw refuseOpen('PRAGMA query_only could not be switched off, so the write probe would not test the connection itself');
    try {
      raw.exec('BEGIN IMMEDIATE');
      raw.exec('CREATE TABLE "__preflight_write_probe__" (x)');
    } catch (err) {
      if (isReadOnlyError(err)) verdict = 'readonly'; else { verdict = 'unexpected'; unexpected = err; }
    } finally {
      try { raw.exec('ROLLBACK'); } catch { /* no transaction was open */ }
    }
  } finally {
    raw.exec('PRAGMA query_only = ON');
  }
  if (Number(raw.prepare('PRAGMA query_only').get()?.query_only) !== 1) throw refuseOpen('PRAGMA query_only could not be re-enabled after the write probe');
  if (verdict === 'written') throw refuseOpen('the snapshot connection accepted a write: it is NOT read-only, so no handle is issued');
  if (verdict === 'unexpected') throw refuseOpen(`the write probe failed for a reason other than read-only (${unexpected?.message ?? unexpected}); read-only mode could not be proven`, unexpected);
}

function openSnapshotInternal(sourcePath, { cleanShutdownConfirmed = false } = {}, open = defaultOpen) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), SNAPSHOT_DIR_PREFIX));
  let raw = null;
  registerSnapshotDirectory(dir, () => { try { raw?.close(); } catch { /* ignore */ } });
  try {
    const snapshot = takeSnapshot(sourcePath, dir, { cleanShutdownConfirmed });
    raw = openVerified(path.join(dir, 'snapshot.db'), open);
    // Backstops on the opened copy: SQLite's own structural check, and proof that the committed WAL frames
    // were applied (the page count a reader sees must equal the last commit record's database size).
    let verdict;
    let pages;
    try {
      verdict = raw.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
      pages = Number(raw.prepare('PRAGMA page_count').get().page_count);
    } catch (err) {
      throw refuseOpen(`the snapshot could not be verified (${err?.message ?? err}): it is inconsistent`, err);
    }
    if (verdict.length !== 1 || verdict[0] !== 'ok') throw refuseOpen(`the snapshot failed SQLite's integrity_check (${verdict.slice(0, 3).join('; ').slice(0, 300)}): it is inconsistent`);
    if (snapshot.expectedPageCount != null && pages !== snapshot.expectedPageCount) {
      throw refuseOpen(`the snapshot has ${pages} pages but the last committed WAL frame says ${snapshot.expectedPageCount}: the WAL was not applied consistently`);
    }
    proveReadOnlyByWriting(raw);
    return makeHandle(raw, { snapshot, directory: dir });
  } catch (err) {
    try { raw?.close(); } catch { /* ignore */ }
    cleanupSnapshotDirectory(dir); // never throws; a failure is reported as a warning and stays registered
    throw err;
  }
}

// Takes a consistent snapshot of sourcePath (main file + WAL, see server/db/snapshot.js) in a private temporary
// directory and opens THAT copy read-only. The source is only read with plain file reads, never opened with SQLite,
// never checkpointed and never written. The copy is verified byte for byte, parsed from the copied bytes, and
// proven read-only by a rejected write before any handle is issued.
//
// Required source state: every process that uses the database is stopped, and the adjacent -wal belongs to this
// exact main file (see db/README.md). The caller MUST close the handle:
//
//   const handle = openSnapshotForPreflight(path);
//   try { ...runPreflight(handle)... } finally { handle.close(); }
//
// handle.snapshot describes what was copied, and runPreflight() reports the facts that qualify the result.
export function openSnapshotForPreflight(sourcePath, { cleanShutdownConfirmed = false } = {}) {
  return openSnapshotInternal(sourcePath, { cleanShutdownConfirmed });
}

// Runs fn(handle) and always closes the handle afterwards (also when fn throws or returns a rejected promise).
export function withSnapshotForPreflight(sourcePath, options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  const handle = openSnapshotForPreflight(sourcePath, options);
  let result;
  try {
    result = fn(handle);
  } catch (err) {
    handle.close();
    throw err;
  }
  if (result && typeof result.then === 'function') return result.finally(() => { handle.close(); });
  handle.close();
  return result;
}

// TEST SEAM. Runs the same canary and query_only proof as the real openers against an arbitrary opener, but
// returns only a verdict: never a handle, never the read-only capability. Production code cannot use it to
// obtain a handle that runPreflight() would accept.
// TEST SEAM for the snapshot path: runs the whole snapshot open (copy, verification, canary, integrity, write
// probe) with an arbitrary opener and returns only a verdict. Any handle that was created is closed and discarded
// here, never returned, so this cannot be used to obtain a read-only capability from a lying opener.
export function verifySnapshotOpenerForTests(sourcePath, open, options = {}) {
  assertTestProcess('verifySnapshotOpenerForTests');
  const handle = openSnapshotInternal(sourcePath, options, open);
  handle.close();
  return true;
}

export function verifyReadOnlyOpenerForTests(filePath, open) {
  assertTestProcess('verifyReadOnlyOpenerForTests');
  const raw = openVerified(filePath, open);
  try { raw.close(); } catch { /* ignore */ }
  return true;
}

export const isPreflightReadOnlyHandle = (h) => READ_ONLY_HANDLES.has(h);

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

function countInvalidUtf8(statement) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bad = 0;
  const rows = typeof statement.iterate === 'function' ? statement.iterate() : statement.all();
  for (const { v } of rows) {
    try { decoder.decode(v); } catch { bad += 1; }
  }
  return bad;
}

// Turns the facts about HOW the snapshot was taken into results, so a snapshot that is weaker than a clean one can
// never produce an unqualified `clear`. ids start with `snapshot:`.
function snapshotFindings(snapshot) {
  if (!snapshot) return [];
  const out = [];
  const warn = (id, description, bad) => out.push({ id, description, severity: 'warning', status: 'found', bad });
  if (snapshot.assumedCleanShutdown) {
    warn('snapshot:assumed-clean-shutdown', 'there was NO -wal file, so this snapshot ASSUMES the database was shut down cleanly (cleanShutdownConfirmed). A main file taken without its WAL looks identical: rows committed only in a missing WAL are absent from every check below', 1);
  }
  if (snapshot.shmPresentInSource) {
    warn('snapshot:source-shm-present', 'the source had a -shm file: a process may still have the database open, or it crashed. The snapshot is only a consistent point in time if nothing wrote during the copy and the application is really stopped', 1);
  }
  const wal = snapshot.wal;
  if (wal && (wal.damagedFrames > 0 || wal.unverifiedTrailingFrames > 0 || wal.partialTailBytes > 0 || wal.uncommittedValidFrames > 0)) {
    const parts = [];
    if (wal.damagedFrames > 0) parts.push(`${wal.damagedFrames} damaged frame(s) that belong to the current WAL generation`);
    if (wal.unverifiedTrailingFrames > 0) parts.push(`${wal.unverifiedTrailingFrames} trailing frame(s) that could not be verified as intact leftovers of an older WAL generation (zero-filled, corrupted or unchained)`);
    if (wal.partialTailBytes > 0) parts.push(`a partial trailing frame (${wal.partialTailBytes} bytes)`);
    if (wal.uncommittedValidFrames > 0) parts.push(`${wal.uncommittedValidFrames} valid frame(s) without a commit record`);
    warn('snapshot:wal-tail-ignored', `SQLite ignores the end of the WAL (${parts.join(', ')}), so the last transaction(s) written there may NOT be in this snapshot and none of the checks below can see them. Review the source before trusting a result`, wal.damagedFrames + wal.unverifiedTrailingFrames + (wal.partialTailBytes > 0 ? 1 : 0) + wal.uncommittedValidFrames);
  }
  if (snapshot.copyVerified) {
    out.push({ id: 'snapshot:copy-verified', description: `the copied main file (${snapshot.mainBytes} bytes) and WAL (${snapshot.walBytes} bytes) match the source bytes that were read (size and SHA-256 re-read from the copy)`, severity: 'blocker', status: 'ok', bad: 0 });
  }
  return out;
}

// Runs every check. database MUST come from openSnapshotForPreflight() or openReadOnlyForPreflight(). Returns
//   [{ id, description, severity, status: 'ok' | 'found' | 'unverifiable', bad, reason? }]
// bad is the number of offending rows (null when unverifiable).
export function runPreflight(database) {
  if (!isPreflightReadOnlyHandle(database)) {
    throw new PreflightReadOnlyError('preflight refuses to run: it needs a handle from openReadOnlyForPreflight(), which guarantees read-only access');
  }
  const tables = introspectSqlite(database);
  const queries = buildPreflightQueries(tables);
  const utf8Ok = String(database.prepare('PRAGMA encoding').get()?.encoding).toUpperCase() === 'UTF-8';
  const results = [...snapshotFindings(database.snapshot)];
  if (tables.length === 0) {
    // Nothing to migrate is never "clear": either this is the wrong file, or committed data was lost (for a
    // snapshot, typically a main file copied without its WAL).
    results.push({ id: 'database:no-tables', description: 'the database must contain tables; there is nothing to migrate. If this is a snapshot of a live WAL-mode database, committed data may be missing (a main file taken without its WAL, or a WAL that does not belong to it)', severity: 'blocker', status: 'found', bad: 1 });
  }
  if (!utf8Ok) {
    results.push({ id: 'database:encoding', description: 'database text encoding must be UTF-8 for the byte-level text checks', severity: 'unverifiable', status: 'unverifiable', bad: null, reason: `PRAGMA encoding is ${database.prepare('PRAGMA encoding').get()?.encoding}; UTF-8 validation and NUL detection were skipped` });
  }
  for (const query of queries) {
    const base = { id: query.id, description: query.description, severity: query.severity };
    if (query.kind === 'unverifiable') { results.push({ ...base, status: 'unverifiable', bad: null, reason: query.reason }); continue; }
    if (query.kind === 'static') { results.push({ ...base, status: 'found', bad: query.bad }); continue; }
    if (query.kind === 'utf8') {
      if (!utf8Ok) continue;
      const bad = countInvalidUtf8(database.prepare(query.sql));
      results.push({ ...base, status: bad === 0 ? 'ok' : 'found', bad });
      continue;
    }
    if (query.kind === 'check') {
      try {
        const bad = Number(database.prepare(query.sql).get().bad);
        results.push({ ...base, status: bad === 0 ? 'ok' : 'found', bad });
      } catch (err) {
        results.push({ ...base, severity: 'unverifiable', status: 'unverifiable', bad: null, reason: `the CHECK expression could not be evaluated: ${err?.message ?? err}` });
      }
      continue;
    }
    // In a UTF-16 database the bytes of every character contain 0x00, so the NUL scan would flag everything:
    // only the type check is run there (the encoding result above says NUL detection was skipped).
    const bad = Number(database.prepare(!utf8Ok && query.sqlNotUtf8 ? query.sqlNotUtf8 : query.sql).get().bad);
    results.push({ ...base, status: bad === 0 ? 'ok' : 'found', bad });
  }
  return results;
}

// Groups results: blockers stop the migration, warnings need a human decision, unverifiable checks could not
// be performed. outcome: 'blocked' (any blocker), 'needs_review' (warnings or unverifiable checks), 'clear'.
export function summarizePreflight(results) {
  const blockers = results.filter((r) => r.status === 'found' && r.severity === 'blocker');
  const warnings = results.filter((r) => r.status === 'found' && r.severity === 'warning');
  const unverifiable = results.filter((r) => r.status === 'unverifiable');
  const outcome = blockers.length ? 'blocked' : warnings.length || unverifiable.length ? 'needs_review' : 'clear';
  return { outcome, blockers, warnings, unverifiable, passed: results.filter((r) => r.status === 'ok').length, snapshotFindings: results.filter((r) => r.id.startsWith('snapshot:')) };
}
