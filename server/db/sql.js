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

// ---------------------------------------------------------------------------------------------
// PostgreSQL SQL Dialect Translator.
// Translates SQLite-specific SQL constructs in application queries into PostgreSQL dialect:
//   1. Quotes reserved identifier "current_role" (unless inside string literal, comment, or already quoted).
//   2. Translates rowid -> seq strictly for verified messages and audit_logs table references.
//      Leaves unrelated tables' rowid untouched.
//   3. Translates datetime('now') and date('now') to UTC statement_timestamp() expressions.
//   4. Translates datetime('now', '<mod>') and date('now', '<mod>') using validated interval
//      or app_shift_ts() (for month/year overflow parity).
//   5. Translates datetime('now', ?) and date('now', ?) into pgNowPlusBound() / pgTodayPlusBound().
//   6. Translates datetime(col, '<mod>') into pgShiftText(col, mod).
//   7. Translates date(col) into pgDatePart(col) (substr(col, 1, 10)).
//   8. Leaves string literals, comments, quoted identifiers, and already-translated SQL intact.
//   9. Throws explicitly on unsupported or malformed SQL expressions.
// ---------------------------------------------------------------------------------------------

function translateDateFunctions(sql) {
  const text = String(sql);
  let out = '';
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];

    if (c === '-' && d === '-') {
      let end = text.indexOf('\n', i);
      end = end === -1 ? text.length : end;
      out += text.slice(i, end);
      i = end;
    } else if (c === '/' && d === '*') {
      const end = skipBlockComment(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === '"') {
      const end = skipQuoted(text, i, '"');
      out += text.slice(i, end);
      i = end;
    } else if (c === "'") {
      const end = skipQuoted(text, i, "'");
      out += text.slice(i, end);
      i = end;
    } else if ((i === 0 || !IDENT_CHAR.test(text[i - 1])) && text.slice(i).search(/^datetime\s*\(/i) === 0) {
      const openParen = text.indexOf('(', i);
      const closeParen = text.indexOf(')', openParen);
      if (closeParen === -1) throw new Error('Unterminated datetime() function call in SQL');

      const argsStr = text.slice(openParen + 1, closeParen).trim();
      const fullCall = text.slice(i, closeParen + 1);

      if (/^'now'$/i.test(argsStr)) {
        out += PG_NOW_TS;
        i = closeParen + 1;
      } else if (/^'now'\s*,\s*\?$/i.test(argsStr)) {
        out += pgNowPlusBound();
        i = closeParen + 1;
      } else if (/^'now'\s*,\s*'([^']+)'$/i.test(argsStr)) {
        const mod = /^'now'\s*,\s*'([^']+)'$/i.exec(argsStr)[1];
        out += pgNowPlus(mod);
        i = closeParen + 1;
      } else if (/^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*,\s*'([^']+)'$/i.test(argsStr)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*,\s*'([^']+)'$/i.exec(argsStr);
        out += pgShiftText(m[1], m[2]);
        i = closeParen + 1;
      } else {
        throw new Error(`Unsupported datetime() expression: ${fullCall}`);
      }
    } else if ((i === 0 || !IDENT_CHAR.test(text[i - 1])) && text.slice(i).search(/^date\s*\(/i) === 0) {
      const openParen = text.indexOf('(', i);
      const closeParen = text.indexOf(')', openParen);
      if (closeParen === -1) throw new Error('Unterminated date() function call in SQL');

      const argsStr = text.slice(openParen + 1, closeParen).trim();
      const fullCall = text.slice(i, closeParen + 1);

      if (/^'now'$/i.test(argsStr)) {
        out += PG_TODAY;
        i = closeParen + 1;
      } else if (/^'now'\s*,\s*\?$/i.test(argsStr)) {
        out += pgTodayPlusBound();
        i = closeParen + 1;
      } else if (/^'now'\s*,\s*'([^']+)'$/i.test(argsStr)) {
        const mod = /^'now'\s*,\s*'([^']+)'$/i.exec(argsStr)[1];
        out += pgTodayPlus(mod);
        i = closeParen + 1;
      } else if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/i.test(argsStr)) {
        out += pgDatePart(argsStr);
        i = closeParen + 1;
      } else {
        throw new Error(`Unsupported date() expression: ${fullCall}`);
      }
    } else if (c === '(') {
      // Check for (julianday(end) - julianday(start)) * 24[.0] (hours calculation)
      const julianHoursMatch = /^\(\s*julianday\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)\s*-\s*julianday\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)\s*\)\s*\*\s*24(?:\.0)?(?![0-9A-Za-z_])/i.exec(text.slice(i));
      if (julianHoursMatch) {
        out += pgHoursBetween(julianHoursMatch[2], julianHoursMatch[1]);
        i += julianHoursMatch[0].length;
      } else {
        // Check for (julianday(end) - julianday(start)) (difference in days)
        const julianDaysMatch = /^\(\s*julianday\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)\s*-\s*julianday\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)\s*\)/i.exec(text.slice(i));
        if (julianDaysMatch) {
          out += `(EXTRACT(EPOCH FROM (${column(julianDaysMatch[1])}::timestamp - ${column(julianDaysMatch[2])}::timestamp)) / 86400.0)`;
          i += julianDaysMatch[0].length;
        } else {
          out += c;
          i++;
        }
      }
    } else if ((i === 0 || !IDENT_CHAR.test(text[i - 1])) && text.slice(i).search(/^strftime\s*\(/i) === 0) {
      const openParen = text.indexOf('(', i);
      const closeParen = text.indexOf(')', openParen);
      if (closeParen === -1) throw new Error('Unterminated strftime() function call in SQL');

      const argsStr = text.slice(openParen + 1, closeParen).trim();
      const fullCall = text.slice(i, closeParen + 1);

      const m = /^'%Y-%m'\s*,\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/i.exec(argsStr);
      if (m) {
        out += pgMonthPart(m[1]);
        i = closeParen + 1;
      } else {
        throw new Error(`Unsupported strftime() expression: ${fullCall}`);
      }
    } else if ((i === 0 || !IDENT_CHAR.test(text[i - 1])) && text.slice(i).search(/^julianday\s*\(/i) === 0) {
      // Unparenthesized julianday(end) - julianday(start)
      const julianDiffMatch = /^julianday\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)\s*-\s*julianday\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)(?![0-9A-Za-z_])/i.exec(text.slice(i));
      if (julianDiffMatch) {
        out += `(EXTRACT(EPOCH FROM (${column(julianDiffMatch[1])}::timestamp - ${column(julianDiffMatch[2])}::timestamp)) / 86400.0)`;
        i += julianDiffMatch[0].length;
      } else {
        throw new Error(`Unsupported julianday() expression: ${text.slice(i, text.indexOf(')', i) + 1 || text.length)}`);
      }
    } else {
      out += c;
      i++;
    }
  }

  return out;
}

// Table extraction keywords to ignore as aliases
const CLAUSE_KEYWORDS = new Set([
  'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'FULL',
  'ON', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT',
  'SET', 'VALUES', 'SELECT', 'USING', 'RETURNING'
]);

const IDENTITY_SET = new Set(['messages', 'audit_logs']);

function stripLiteralsAndComments(sql) {
  const text = String(sql);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    let end = -1;
    if (c === '-' && d === '-') {
      end = text.indexOf('\n', i);
      end = end === -1 ? text.length : end;
    } else if (c === '/' && d === '*') {
      end = skipBlockComment(text, i);
    } else if (c === '"' || c === "'") {
      end = skipQuoted(text, i, c);
    }
    if (end !== -1) {
      out += ' '.repeat(end - i);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function findMatchingParen(sql, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < sql.length) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && d === '*') {
      i = skipBlockComment(sql, i);
    } else if (c === '"' || c === "'") {
      i = skipQuoted(sql, i, c);
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
      i++;
    } else {
      i++;
    }
  }
  throw new Error('Unterminated parenthesis in SQL');
}

function isSubqueryStart(sql, openIdx) {
  let i = openIdx + 1;
  while (i < sql.length) {
    const c = sql[i];
    const d = sql[i + 1];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i);
      end = end === -1 ? sql.length : end;
    } else if (c === '/' && d === '*') {
      i = skipBlockComment(sql, i);
    } else if (c === '(') {
      return isSubqueryStart(sql, i);
    } else {
      const rest = sql.slice(i);
      return /^(?:SELECT|WITH)\b/i.test(rest);
    }
  }
  return false;
}

function extractTablesFromScope(code) {
  const cleanCode = stripLiteralsAndComments(code);
  const tables = new Map();
  const identityTables = new Set();
  const allTables = new Set();

  function addTable(tbl, alias) {
    if (!tbl) return;
    const t = tbl.toLowerCase();
    const a = (alias || tbl).toLowerCase();
    allTables.add(t);
    tables.set(a, t);
    tables.set(t, t);
    if (IDENTITY_SET.has(t)) {
      identityTables.add(t);
    }
  }

  // 1. FROM clause
  const fromMatch = /\bFROM\s+([\s\S]*?)(?=\b(?:WHERE|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|NATURAL|GROUP|ORDER|LIMIT|HAVING|WINDOW|UNION|INTERSECT|EXCEPT|RETURNING|ON|USING)\b|;|$)/i.exec(cleanCode);
  if (fromMatch) {
    const fromList = fromMatch[1].split(',');
    for (const item of fromList) {
      const trimmed = item.trim();
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?$/i.exec(trimmed);
      if (m) {
        let alias = m[2];
        if (alias && CLAUSE_KEYWORDS.has(alias.toUpperCase())) alias = null;
        addTable(m[1], alias);
      }
    }
  }

  // 2. JOIN clauses
  const joinRegex = /\b(?:(?:LEFT|RIGHT|FULL|INNER|CROSS|OUTER|NATURAL)\s+)?JOIN\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  let m;
  while ((m = joinRegex.exec(cleanCode)) !== null) {
    const tbl = m[1];
    let alias = m[2];
    if (alias && CLAUSE_KEYWORDS.has(alias.toUpperCase())) alias = null;
    addTable(tbl, alias);
  }

  // 3. UPDATE clause
  const updateRegex = /\bUPDATE\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi;
  while ((m = updateRegex.exec(cleanCode)) !== null) {
    const tbl = m[1];
    let alias = m[2];
    if (alias && CLAUSE_KEYWORDS.has(alias.toUpperCase())) alias = null;
    addTable(tbl, alias);
  }

  // 4. INTO clause
  const intoRegex = /\bINTO\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  while ((m = intoRegex.exec(cleanCode)) !== null) {
    addTable(m[1], null);
  }

  return { tables, identityTables, allTables };
}

function translateScopeRowid(code, parentScope) {
  const { tables, identityTables, allTables } = extractTablesFromScope(code);

  const scope = {
    tables,
    identityTables,
    allTables,
    parent: parentScope
  };

  function resolveTable(aliasOrName) {
    const key = aliasOrName.toLowerCase();
    if (tables.has(key)) return tables.get(key);
    if (parentScope) return parentScope.resolveTable(key);
    return null;
  }
  scope.resolveTable = resolveTable;

  const transformed = mapSqlCode(code, (sqlCode) => {
    let res = sqlCode;

    // Quote unquoted current_role
    res = res.replace(/\bcurrent_role\b/gi, '"current_role"');

    // 1. Qualified rowid: <alias>.rowid
    res = res.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\.rowid\b/gi, (match, prefix) => {
      const targetTable = resolveTable(prefix);
      if (targetTable && IDENTITY_SET.has(targetTable)) {
        return `${prefix}.seq`;
      }
      return match;
    });

    // 2. Unqualified rowid: rowid not preceded by dot
    const UNQUALIFIED_ROWID = /(?<!\.)\browid\b/i;
    if (UNQUALIFIED_ROWID.test(res)) {
      if (identityTables.size > 1) {
        throw new Error('Ambiguous rowid: query references both "messages" and "audit_logs"; qualify with table or alias');
      }
      if (identityTables.size === 1 && allTables.size > 1) {
        throw new Error('Ambiguous rowid: query joins identity table with other tables; qualify rowid with table or alias');
      }
      if (identityTables.size === 1 && allTables.size === 1) {
        res = res.replace(/(?<!\.)\browid\b/gi, 'seq');
      }
    }

    return res;
  });

  return { transformed, scope };
}

function translateQueryScopes(sql, parentScope = null) {
  let i = 0;
  const segments = [];

  while (i < sql.length) {
    const c = sql[i];
    const d = sql[i + 1];

    if (c === '-' && d === '-') {
      const end = sql.indexOf('\n', i);
      const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end);
      segments.push({ type: 'verbatim', text: chunk });
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && d === '*') {
      const end = skipBlockComment(sql, i);
      segments.push({ type: 'verbatim', text: sql.slice(i, end) });
      i = end;
    } else if (c === '"' || c === "'") {
      const end = skipQuoted(sql, i, c);
      segments.push({ type: 'verbatim', text: sql.slice(i, end) });
      i = end;
    } else if (c === '(' && isSubqueryStart(sql, i)) {
      const endParen = findMatchingParen(sql, i);
      const subquerySql = sql.slice(i + 1, endParen);
      segments.push({ type: 'subquery', text: subquerySql });
      i = endParen + 1;
    } else {
      if (segments.length > 0 && segments[segments.length - 1].type === 'code') {
        segments[segments.length - 1].text += c;
      } else {
        segments.push({ type: 'code', text: c });
      }
      i++;
    }
  }

  let maskedCode = '';
  const subqueries = [];
  for (const seg of segments) {
    if (seg.type === 'subquery') {
      const placeholder = `__SUBQUERY_${subqueries.length}__`;
      subqueries.push(seg.text);
      maskedCode += `(${placeholder})`;
    } else {
      maskedCode += seg.text;
    }
  }

  const setOpRegex = /\b(UNION(?:\s+ALL)?|INTERSECT(?:\s+ALL)?|EXCEPT(?:\s+ALL)?)\b/i;
  if (setOpRegex.test(maskedCode)) {
    const parts = maskedCode.split(setOpRegex);
    let result = '';
    for (let p = 0; p < parts.length; p++) {
      if (p % 2 === 1) {
        result += parts[p];
      } else {
        const branchMasked = parts[p];
        const { transformed, scope } = translateScopeRowid(branchMasked, parentScope);
        const restored = transformed.replace(/__SUBQUERY_(\d+)__/g, (_, idx) => {
          return translateQueryScopes(subqueries[Number(idx)], scope);
        });
        result += restored;
      }
    }
    return result;
  }

  const { transformed, scope } = translateScopeRowid(maskedCode, parentScope);

  return transformed.replace(/__SUBQUERY_(\d+)__/g, (_, idx) => {
    return translateQueryScopes(subqueries[Number(idx)], scope);
  });
}

export function translateSqlForPostgres(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new TypeError('SQL must be a non-empty string');
  }

  // Phase 1: Translate SQLite date/time functions
  const dateTranslated = translateDateFunctions(sql);

  // Phase 2: Scope-aware lexical translation for rowid and current_role
  return translateQueryScopes(dateTranslated);
}
