// Pure SQL text helpers for the SQLite -> PostgreSQL migration.
//
// Nothing here touches a database, the file system or the environment, and nothing imports the
// application's database module. It is safe to load anywhere (the seed CLI, tests, tooling).
//
// NOT USED BY THE APPLICATION YET. These helpers are the foundation for later phases. The
// PostgreSQL expressions below are checked structurally by tests/sql.test.js, and the date
// arithmetic ALGORITHM is checked against SQLite itself by tests/sqlite-compat.test.js. Their behavior
// on a real PostgreSQL has not been verified: that happens in the phase that adds a disposable
// PostgreSQL. See db/README.md for every known difference between the two engines.

// ---------------------------------------------------------------------------------------------
// Scanner: walks SQL text and hands only real code (not string literals, quoted identifiers or
// comments) to a callback. Everything else is copied through untouched. Syntax this translator does
// not support is REJECTED, never passed through, because a silent mistranslation is worse than an error.
// ---------------------------------------------------------------------------------------------

function skipQuoted(sql, start, quote) {
  // sql[start] is the opening quote. A doubled quote inside is an escaped quote.
  let j = start + 1;
  while (j < sql.length) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  throw new Error(`Unterminated ${quote === "'" ? 'string literal' : 'quoted identifier'} in SQL`);
}

function skipBlockComment(sql, start) {
  // PostgreSQL block comments nest (SQLite's do not). Text that SQLite would accept but that opens a
  // nested comment is therefore reported as unterminated, never silently reinterpreted.
  let depth = 0;
  let j = start;
  while (j < sql.length) {
    if (sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; continue; }
    if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; if (depth === 0) return j; continue; }
    j++;
  }
  throw new Error('Unterminated block comment in SQL');
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function mapSqlCode(sql, onCode) {
  const text = String(sql);
  let out = '';
  let code = '';
  const flush = () => { if (code) { out += onCode(code); code = ''; } };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    let end = -1;
    if (c === '`') {
      throw new Error('Unsupported identifier quoting: `backticks` are not PostgreSQL syntax; use "double quotes"');
    } else if (c === '[') {
      throw new Error('Unsupported syntax: [bracket] identifiers (SQLite) and array subscripts are not supported by the SQL translator; use "double quotes"');
    } else if (c === "'") {
      // E'...' strings use backslash escapes, which this scanner does not model.
      const prev = text[i - 1];
      if ((prev === 'E' || prev === 'e') && !(i >= 2 && IDENT_CHAR.test(text[i - 2]))) {
        throw new Error("Unsupported syntax: escape strings (E'...') are not supported by the SQL translator");
      }
      end = skipQuoted(text, i, c);
    } else if (c === '"') {
      end = skipQuoted(text, i, c);
    } else if (c === '-' && d === '-') {
      end = text.indexOf('\n', i);
      end = end === -1 ? text.length : end;
    } else if (c === '/' && d === '*') {
      end = skipBlockComment(text, i);
    }
    if (end !== -1) {
      flush();
      out += text.slice(i, end);
      i = end;
    } else {
      code += c;
      i++;
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Placeholders: SQLite style `?` -> PostgreSQL style `$1, $2, ...`
// Only plain `?` is translated. SQLite's other parameter styles would be silently wrong, so they throw:
//   ?NNN (numbered), :name, @name, $name, and PostgreSQL's own $n / dollar quoting.
// ---------------------------------------------------------------------------------------------

const NUMBERED_QMARK = /\?(?=[0-9])/;
const NAMED_COLON = /(?<![:\w]):[A-Za-z_]/; // :name, but not the :: cast operator
const NAMED_AT = /(?<![\w@])@[A-Za-z_]/; // @name, but not the @> or @@ operators
const DOLLAR = /(?<![A-Za-z0-9_$])\$(?:[0-9]|\$|[A-Za-z_])/; // $1, $name, $$ and $tag$ (not a$b)

export function translatePlaceholders(sql) {
  let count = 0;
  const text = mapSqlCode(sql, (code) => {
    if (NUMBERED_QMARK.test(code)) throw new Error('SQLite numbered parameters (?NNN) are not supported; use plain ? placeholders');
    if (NAMED_COLON.test(code) || NAMED_AT.test(code)) throw new Error('Named parameters (:name, @name) are not supported; use plain ? placeholders');
    if (DOLLAR.test(code)) throw new Error('SQL already uses $n placeholders, $name parameters or dollar quoting; use plain ? placeholders only');
    return code.replace(/\?/g, () => `$${++count}`);
  });
  return { text, count };
}

// ---------------------------------------------------------------------------------------------
// Dates and times. The app stores UTC timestamps as TEXT ('YYYY-MM-DD HH24:MI:SS') and dates as TEXT
// ('YYYY-MM-DD'), and compares them as strings. These expressions produce the same text.
//
// "Now": SQLite evaluates datetime('now') once per STATEMENT. PostgreSQL's now() is fixed for the whole
// TRANSACTION and clock_timestamp() changes inside one statement; statement_timestamp() is the match
// (constant within a statement, advancing between statements of a transaction).
//
// Month and year arithmetic: SQLite normalizes overflow (2025-01-31 + 1 month = 2025-03-03) while a
// plain PostgreSQL interval clamps to month end (2025-02-28). The SQL function app_shift_ts, defined in
// db/migrations/002_sqlite_compat_functions.sql, reproduces SQLite's result. Every expression that adds
// months or years, or that takes its interval from a bound parameter, calls it. Plain interval addition
// is exact for seconds, minutes, hours and days (no time zones are involved: everything is UTC).
// ---------------------------------------------------------------------------------------------

export const PG_TS_FORMAT = 'YYYY-MM-DD HH24:MI:SS';
export const PG_DATE_FORMAT = 'YYYY-MM-DD';
const NOW_UTC = "(statement_timestamp() AT TIME ZONE 'UTC')";
// Equivalent of SQLite datetime('now') and date('now').
export const PG_NOW_TS = `to_char(statement_timestamp() AT TIME ZONE 'UTC', '${PG_TS_FORMAT}')`;
export const PG_TODAY = `to_char(statement_timestamp() AT TIME ZONE 'UTC', '${PG_DATE_FORMAT}')`;
export const PG_SHIFT_FUNCTION = 'app_shift_ts';

// SQLite supports these units (plural or singular) in 'NNN unit' modifiers. It has NO 'weeks', so a
// 'weeks' modifier is rejected here rather than converted (SQLite would return NULL for it).
const MODIFIER_RE = /^([+-]?)(\d{1,5}) (second|minute|hour|day|month|year)s?$/;

export function parseSqliteModifier(modifier) {
  const m = MODIFIER_RE.exec(String(modifier).trim());
  if (!m) throw new Error(`Unsupported date modifier: ${JSON.stringify(String(modifier))}`);
  return { n: (m[1] === '-' ? -1 : 1) * Number(m[2]), unit: m[3] };
}

const intervalLiteral = ({ n, unit }) => `${n} ${unit}${Math.abs(n) === 1 ? '' : 's'}`;

// SQLite date modifiers such as '-30 days' or '+1 year' -> a PostgreSQL interval string.
// Strict on purpose: anything else is rejected rather than passed through.
export const sqliteModifierToInterval = (modifier) => intervalLiteral(parseSqliteModifier(modifier));

// A timestamp expression shifted by a modifier known when the SQL is written.
function shifted(tsExpr, modifier) {
  const parsed = parseSqliteModifier(modifier);
  const interval = `interval '${intervalLiteral(parsed)}'`;
  return parsed.unit === 'month' || parsed.unit === 'year'
    ? `${PG_SHIFT_FUNCTION}(${tsExpr}, ${interval})`
    : `(${tsExpr} + ${interval})`;
}

// datetime('now', '<modifier>') and date('now', '<modifier>') with the modifier fixed in the SQL text.
export const pgNowPlus = (modifier) => `to_char(${shifted(NOW_UTC, modifier)}, '${PG_TS_FORMAT}')`;
export const pgTodayPlus = (modifier) => `to_char(${shifted(NOW_UTC, modifier)}, '${PG_DATE_FORMAT}')`;

// datetime('now', ?) / date('now', ?) where the modifier is a BOUND parameter. They emit a plain `?`, so
// they compose with translatePlaceholders (numbering follows the order of every `?` in the statement).
// The caller binds sqliteModifierToInterval(modifier) as that parameter.
export const pgNowPlusBound = () => `to_char(${PG_SHIFT_FUNCTION}(${NOW_UTC}, (?)::interval), '${PG_TS_FORMAT}')`;
export const pgTodayPlusBound = () => `to_char(${PG_SHIFT_FUNCTION}(${NOW_UTC}, (?)::interval), '${PG_DATE_FORMAT}')`;

// The same, for SQL that is written with hand-numbered $n placeholders. Do NOT pass SQL containing this
// through translatePlaceholders: it rejects $n on purpose. Prefer pgNowPlusBound().
export function pgNowPlusParam(paramIndex) {
  if (!Number.isInteger(paramIndex) || paramIndex < 1) throw new Error('paramIndex must be a positive integer');
  return `to_char(${PG_SHIFT_FUNCTION}(${NOW_UTC}, ($${paramIndex})::interval), '${PG_TS_FORMAT}')`;
}

const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function column(name) {
  if (!COLUMN_RE.test(String(name))) throw new Error(`Not a plain column reference: ${JSON.stringify(String(name))}`);
  return name;
}

// datetime(col, '<modifier>') for a TEXT timestamp column (the seed does this to backdate rows).
export const pgShiftText = (col, modifier) => `to_char(${shifted(`(${column(col)})::timestamp`, modifier)}, '${PG_TS_FORMAT}')`;

// date(col) for text timestamps -> the 'YYYY-MM-DD' prefix. NOTE: SQLite's date() also validates and
// normalizes its input (invalid text gives NULL); substr does not. See db/README.md.
export const pgDatePart = (col) => `substr(${column(col)}, 1, 10)`;
// strftime('%Y-%m', col) -> the 'YYYY-MM' prefix
export const pgMonthPart = (col) => `substr(${column(col)}, 1, 7)`;
// (julianday(end) - julianday(start)) * 24, for text timestamps. The result is NUMERIC, which the pg
// driver returns as a string unless a type parser is registered.
export const pgHoursBetween = (startCol, endCol) =>
  `EXTRACT(EPOCH FROM (${column(endCol)}::timestamp - ${column(startCol)}::timestamp)) / 3600.0`;

// ---------------------------------------------------------------------------------------------
// Reserved words. current_role is a reserved word in PostgreSQL, so it must be double-quoted.
// Only real code is touched: string literals, comments and already-quoted identifiers are not.
// ---------------------------------------------------------------------------------------------

export function quoteReservedWords(sql) {
  return mapSqlCode(sql, (code) => code.replace(/\bcurrent_role\b/gi, '"current_role"'));
}

// ---------------------------------------------------------------------------------------------
// Identity columns. messages and audit_logs have `seq BIGINT GENERATED BY DEFAULT AS IDENTITY`, which
// replaces SQLite's rowid for ordering. After ANY import that inserts explicit seq values the sequence
// must be moved past the largest value, or the next ordinary insert collides. See db/README.md.
//
// Contract of the statements below (execution is done by server/db/identity.js):
//   * the reset must run INSIDE a transaction that also holds a lock on the table (pgLockForResetSql), so
//     no insert can slip in between reading MAX(col) and setval. LOCK TABLE outside a transaction is an
//     error in PostgreSQL, so forgetting the transaction fails loudly instead of racing.
//   * pg_get_serial_sequence() returns NULL when the column exists but has no owned sequence. setval() is
//     STRICT, so setval(NULL, ...) would return NULL and silently do nothing. The statement therefore casts
//     the name to regclass after substituting a name that cannot exist, so a missing sequence is an ERROR
//     (relation "..." does not exist). A missing table or column is already an error in
//     pg_get_serial_sequence itself.
//   * setval is not transactional: if the surrounding transaction rolls back the sequence stays advanced.
//     That only leaves a gap, which is harmless.
// ---------------------------------------------------------------------------------------------

export const IDENTITY_TABLES = Object.freeze(['messages', 'audit_logs']);
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function identityNames(table, col) {
  if (!IDENT_RE.test(String(table)) || !IDENT_RE.test(String(col))) throw new Error('table and column must be plain lowercase identifiers');
  return [table, col];
}

// Name used when no sequence exists. It never resolves, so the regclass cast raises a clear error that names
// the table and column.
export const missingSequenceName = (table, col) => `no_owned_sequence_for_${table}_${col}`;

// Blocks concurrent INSERT/UPDATE/DELETE (but not reads) on the table until the transaction ends.
export function pgLockForResetSql(table) {
  const [t] = identityNames(table, 'seq');
  return `LOCK TABLE ${t} IN SHARE ROW EXCLUSIVE MODE`;
}

// Looks the sequence up without changing anything. NULL means the column has no owned sequence.
export function pgIdentitySequenceNameSql(table, col = 'seq') {
  const [t, c] = identityNames(table, col);
  return `SELECT pg_get_serial_sequence('${t}', '${c}') AS sequence_name`;
}

// Moves the next value to MAX + 1 (1 for an empty table). Fails if there is no sequence. Returns the value
// as `next_value`.
export function pgResetIdentitySql(table, col = 'seq') {
  const [t, c] = identityNames(table, col);
  return `SELECT setval((COALESCE(pg_get_serial_sequence('${t}', '${c}'), '${missingSequenceName(t, c)}'))::regclass, COALESCE((SELECT MAX(${c}) FROM ${t}), 0) + 1, false) AS next_value`;
}

export const pgResetAllIdentitiesSql = () => IDENTITY_TABLES.map((t) => pgResetIdentitySql(t));
