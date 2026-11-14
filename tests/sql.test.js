// Unit tests for server/db/sql.js and server/db/errors.js. Pure text and object logic: no database,
// no files, no network. (The PostgreSQL expressions are checked structurally here; their behavior on a
// real PostgreSQL is verified in the phase that adds the PostgreSQL backend.)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  translatePlaceholders, mapSqlCode, sqliteModifierToInterval, pgNowPlus, pgNowPlusParam, pgTodayPlus,
  pgDatePart, pgMonthPart, pgHoursBetween, quoteReservedWords, PG_NOW_TS, PG_TODAY,
  pgNowPlusBound, pgTodayPlusBound, pgShiftText, parseSqliteModifier, pgResetIdentitySql, pgResetAllIdentitiesSql, IDENTITY_TABLES, pgLockForResetSql, pgIdentitySequenceNameSql, missingSequenceName
} from '../server/db/sql.js';
import { classifyDbError, isUniqueViolation, isRetryableDbError, DbLockTimeoutError, TransactionClosedError } from '../server/db/errors.js';

describe('translatePlaceholders', () => {
  test('numbers each ? in order', () => {
    assert.deepEqual(translatePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), { text: 'SELECT * FROM t WHERE a = $1 AND b = $2', count: 2 });
    assert.deepEqual(translatePlaceholders('SELECT 1'), { text: 'SELECT 1', count: 0 });
    const many = translatePlaceholders(`INSERT INTO t VALUES (${Array(12).fill('?').join(', ')})`);
    assert.equal(many.count, 12);
    assert.ok(many.text.endsWith('$10, $11, $12)'));
  });

  test('leaves ? inside string literals, quoted identifiers and comments alone', () => {
    assert.equal(translatePlaceholders("SELECT '?' , ? FROM t").text, "SELECT '?' , $1 FROM t");
    assert.equal(translatePlaceholders("SELECT 'it''s ?' , ?").text, "SELECT 'it''s ?' , $1");
    assert.equal(translatePlaceholders('SELECT "col?" , ? FROM t').text, 'SELECT "col?" , $1 FROM t');
    assert.equal(translatePlaceholders('SELECT ? -- really?\n, ?').text, 'SELECT $1 -- really?\n, $2');
    assert.equal(translatePlaceholders('SELECT /* ? /* nested ? */ ? */ ?').text, 'SELECT /* ? /* nested ? */ ? */ $1');
    assert.equal(translatePlaceholders("SELECT 'a' || '?' || ?").count, 1);
  });

  test('handles the dynamic IN (?, ?, ...) lists the app builds', () => {
    const marks = ['a', 'b', 'c'].map(() => '?').join(',');
    assert.deepEqual(translatePlaceholders(`SELECT * FROM t WHERE role = ? AND email IN (${marks})`), { text: 'SELECT * FROM t WHERE role = $1 AND email IN ($2,$3,$4)', count: 4 });
  });

  test('refuses text it cannot translate safely', () => {
    assert.throws(() => translatePlaceholders("SELECT 'unterminated"), /Unterminated string literal/);
    assert.throws(() => translatePlaceholders('SELECT "unterminated'), /Unterminated quoted identifier/);
    assert.throws(() => translatePlaceholders('SELECT /* open'), /Unterminated block comment/);
    assert.throws(() => translatePlaceholders('SELECT $1, ?'), /\$n placeholders/);
    assert.throws(() => translatePlaceholders('SELECT $$body$$'), /dollar quoting/);
    assert.throws(() => translatePlaceholders('SELECT $tag$body$tag$'), /dollar quoting/);
  });

  test('mapSqlCode passes only real code to the callback', () => {
    const seen = [];
    const out = mapSqlCode("a 'b' c \"d\" e -- f\n g /* h */ i", (code) => { seen.push(code); return code.toUpperCase(); });
    assert.equal(out, "A 'b' C \"d\" E -- f\n G /* h */ I");
    assert.deepEqual(seen, ['a ', ' c ', ' e ', '\n g ', ' i']);
  });
});

describe('date and time expressions', () => {
  test('the "now" expressions produce the stored TEXT formats in UTC', () => {
    assert.equal(PG_NOW_TS, "to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
    assert.equal(PG_TODAY, "to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
    // SQLite's 'now' is per statement: neither the transaction-wide now() nor the ever-changing clock_timestamp().
    for (const sql of [PG_NOW_TS, PG_TODAY]) assert.doesNotMatch(sql, /\bnow\(\)|clock_timestamp/);
  });

  test('SQLite modifiers convert to PostgreSQL intervals', () => {
    const cases = { '-30 days': '-30 days', '+1 year': '1 year', '+1 month': '1 month', '-10 minutes': '-10 minutes', '+1 day': '1 day',
      '-1 hour': '-1 hour', '+345 days': '345 days', '-21 days': '-21 days', '7 days': '7 days', ' +2 seconds ': '2 seconds', '-1 days': '-1 day', '+0 days': '0 days' };
    for (const [input, expected] of Object.entries(cases)) assert.equal(sqliteModifierToInterval(input), expected, input);
  });

  test('anything that is not a plain modifier is rejected', () => {
    for (const bad of ['', 'start of month', 'days', '+1.5 days', "1 day'; DROP TABLE users; --", '1 fortnight', '--1 day', '+1 day +2 days', '999999 days', null, undefined]) {
      assert.throws(() => sqliteModifierToInterval(bad), /Unsupported date modifier/, String(bad));
    }
  });

  test('builders embed only validated pieces', () => {
    assert.equal(pgNowPlus('-30 days'), "to_char(((statement_timestamp() AT TIME ZONE 'UTC') + interval '-30 days'), 'YYYY-MM-DD HH24:MI:SS')");
    assert.equal(pgTodayPlus('-6 days'), "to_char(((statement_timestamp() AT TIME ZONE 'UTC') + interval '-6 days'), 'YYYY-MM-DD')");
    assert.equal(pgNowPlusParam(2), "to_char(app_shift_ts((statement_timestamp() AT TIME ZONE 'UTC'), ($2)::interval), 'YYYY-MM-DD HH24:MI:SS')");
    assert.throws(() => pgNowPlus("1 day'; --"), /Unsupported date modifier/);
    assert.throws(() => pgNowPlusParam(0), /positive integer/);
    assert.throws(() => pgNowPlusParam('1; DROP'), /positive integer/);
  });

  test('column helpers accept plain references only', () => {
    assert.equal(pgDatePart('created_at'), 'substr(created_at, 1, 10)');
    assert.equal(pgDatePart('r.created_at'), 'substr(r.created_at, 1, 10)');
    assert.equal(pgMonthPart('m.created_at'), 'substr(m.created_at, 1, 7)');
    assert.equal(pgHoursBetween('created_at', 'responded_at'), 'EXTRACT(EPOCH FROM (responded_at::timestamp - created_at::timestamp)) / 3600.0');
    for (const bad of ['created_at) --', 'a b', '', '1col', 'a.b.c', "x'y"]) {
      assert.throws(() => pgDatePart(bad), /Not a plain column reference/, bad);
    }
  });
});

describe('quoteReservedWords', () => {
  test('quotes current_role in code, qualified or not', () => {
    assert.equal(quoteReservedWords('SELECT ap.current_role FROM alumni_profiles ap'), 'SELECT ap."current_role" FROM alumni_profiles ap');
    assert.equal(quoteReservedWords('INSERT INTO alumni_profiles (id, current_company, current_role, industry) VALUES (?, ?, ?, ?)'),
      'INSERT INTO alumni_profiles (id, current_company, "current_role", industry) VALUES (?, ?, ?, ?)');
    assert.equal(quoteReservedWords('LOWER(ap.current_role) LIKE ?'), 'LOWER(ap."current_role") LIKE ?');
    assert.equal(quoteReservedWords('SELECT CURRENT_ROLE'), 'SELECT "current_role"');
  });

  test('leaves strings, comments, quoted identifiers and look-alike names alone', () => {
    assert.equal(quoteReservedWords("SELECT 'current_role' FROM t"), "SELECT 'current_role' FROM t");
    assert.equal(quoteReservedWords('SELECT "current_role" FROM t'), 'SELECT "current_role" FROM t');
    assert.equal(quoteReservedWords('SELECT a -- current_role\n FROM t'), 'SELECT a -- current_role\n FROM t');
    assert.equal(quoteReservedWords('SELECT current_company, current_roles, my_current_role FROM t'), 'SELECT current_company, current_roles, my_current_role FROM t');
  });

  test('is idempotent', () => {
    const once = quoteReservedWords('SELECT ap.current_role');
    assert.equal(quoteReservedWords(once), once);
  });
});

describe('classifyDbError', () => {
  const sqlite = (errcode, message) => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'constraint failed' });
  const pg = (code, extra = {}) => Object.assign(new Error('pg error'), { code, ...extra });

  test('SQLite constraint errors (as node:sqlite reports them)', () => {
    assert.deepEqual(classifyDbError(sqlite(2067, 'UNIQUE constraint failed: users.email')), { kind: 'unique', driver: 'sqlite', constraint: 'users.email' });
    assert.equal(classifyDbError(sqlite(1555, 'UNIQUE constraint failed: users.id')).kind, 'unique');
    assert.equal(classifyDbError(sqlite(1299, 'NOT NULL constraint failed: users.email')).kind, 'not_null');
    assert.equal(classifyDbError(sqlite(275, 'CHECK constraint failed: c')).kind, 'check');
    assert.equal(classifyDbError(sqlite(787, 'FOREIGN KEY constraint failed')).kind, 'foreign_key');
    assert.equal(classifyDbError(sqlite(19, 'constraint failed')).kind, 'constraint');
    assert.equal(classifyDbError(sqlite(1, 'near "SELEC": syntax error')).kind, 'other');
  });

  test('PostgreSQL errors by SQLSTATE', () => {
    assert.deepEqual(classifyDbError(pg('23505', { constraint: 'users_email_key' })), { kind: 'unique', driver: 'pg', constraint: 'users_email_key' });
    assert.equal(classifyDbError(pg('23503')).kind, 'foreign_key');
    assert.equal(classifyDbError(pg('23502')).kind, 'not_null');
    assert.equal(classifyDbError(pg('23514')).kind, 'check');
    assert.equal(classifyDbError(pg('23000')).kind, 'constraint');
    assert.equal(classifyDbError(pg('40001')).kind, 'retryable');
    assert.equal(classifyDbError(pg('40P01')).kind, 'retryable');
    assert.equal(classifyDbError(pg('08006')).kind, 'connection');
    assert.equal(classifyDbError(pg('57P01')).kind, 'connection');
    assert.equal(classifyDbError(pg('42601')).kind, 'other');
  });

  test('falls back to message text, and never throws on odd input', () => {
    assert.equal(classifyDbError(new Error('UNIQUE constraint failed: a.b')).kind, 'unique');
    assert.equal(classifyDbError(new Error('boom')).kind, 'other');
    for (const odd of [null, undefined, 'text', 42, {}]) assert.equal(classifyDbError(odd).kind, 'other');
    assert.equal(isUniqueViolation(pg('23505')), true);
    assert.equal(isUniqueViolation(pg('23503')), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Corrective follow-up tests (independent review findings H1, M1, M2/M3, M8, M10)
// ---------------------------------------------------------------------------------------------

describe('translatePlaceholders rejects syntax it cannot translate (H1)', () => {
  test('SQLite numbered parameters ?NNN are rejected, never rewritten to something else', () => {
    for (const sql of ['SELECT ?1', 'SELECT ?1, ?2, ?1', 'SELECT ? , ?12', 'INSERT INTO t VALUES (?1)']) {
      assert.throws(() => translatePlaceholders(sql), /numbered parameters \(\?NNN\)/, sql);
    }
  });

  test('named parameters :name and @name are rejected (previously they passed through silently)', () => {
    for (const sql of ['SELECT :a', 'SELECT @b WHERE x = ?', 'WHERE a = :id AND b = ?', 'SELECT :_x']) {
      assert.throws(() => translatePlaceholders(sql), /Named parameters/, sql);
    }
    assert.throws(() => translatePlaceholders('SELECT $name'), /\$name parameters/);
  });

  test('legitimate PostgreSQL syntax that merely resembles those styles is still accepted', () => {
    assert.equal(translatePlaceholders('SELECT ?::text, x::int FROM t').text, 'SELECT $1::text, x::int FROM t');
    assert.equal(translatePlaceholders('SELECT a @> b, @ x, c <@ d WHERE y = ?').count, 1);
    assert.equal(translatePlaceholders('SELECT a$b, c$ FROM t WHERE z = ?').text, 'SELECT a$b, c$ FROM t WHERE z = $1');
    assert.equal(translatePlaceholders("SELECT '10:30', ':name', '@x', '?1' , ?").text, "SELECT '10:30', ':name', '@x', '?1' , $1");
    assert.equal(translatePlaceholders('SELECT ? -- :name ?1 @x\n, ?').text, 'SELECT $1 -- :name ?1 @x\n, $2');
  });

  test('backtick and bracket identifiers are rejected, not mistranslated', () => {
    assert.throws(() => translatePlaceholders('SELECT `a?b`, ?'), /backticks/);
    assert.throws(() => translatePlaceholders('SELECT [a?b], ?'), /bracket/);
    assert.throws(() => translatePlaceholders('SELECT arr[1] FROM t'), /bracket/);
    assert.throws(() => quoteReservedWords('SELECT `current_role`'), /backticks/);
    // inside a string or a comment they are just text
    assert.equal(translatePlaceholders("SELECT '`[', ? /* ` [ */").text, "SELECT '`[', $1 /* ` [ */");
  });

  test('E-strings and other text the scanner cannot model are rejected with a clear message', () => {
    assert.throws(() => translatePlaceholders("SELECT E'it\\'s ?', ?"), /escape strings/);
    assert.throws(() => translatePlaceholders("SELECT e'x'"), /escape strings/);
    // an identifier ending in e followed by a string is NOT an E-string
    assert.equal(translatePlaceholders("SELECT name'x'").text, "SELECT name'x'");
    assert.equal(translatePlaceholders("SELECT code='?' AND x = ?").text, "SELECT code='?' AND x = $1");
  });

  test('block comments follow PostgreSQL nesting; text SQLite accepts but PostgreSQL would not close is rejected', () => {
    assert.throws(() => translatePlaceholders('SELECT /* a /* b */ ?'), /Unterminated block comment/);
  });
});

describe('interval helpers compose with placeholder translation (M1)', () => {
  test('the bound-modifier helpers emit a plain ? that translatePlaceholders numbers in statement order', () => {
    const sql = `UPDATE institution_subscriptions SET plan_id = ?, current_period_start = ${PG_NOW_TS}, current_period_end = ${pgNowPlusBound()} WHERE institution_id = ?`;
    const { text, count } = translatePlaceholders(sql);
    assert.equal(count, 3);
    assert.ok(text.includes('plan_id = $1'));
    assert.ok(text.includes("app_shift_ts((statement_timestamp() AT TIME ZONE 'UTC'), ($2)::interval)"), text);
    assert.ok(text.endsWith('WHERE institution_id = $3'));
    // the bound value is the converted modifier
    assert.equal(sqliteModifierToInterval('+1 year'), '1 year');
  });

  test('two bound dates in one statement get two parameters, in order', () => {
    const sql = `INSERT INTO invoices (id, period_start, period_end, ref) VALUES (?, ${PG_NOW_TS}, ${pgNowPlusBound()}, ?)`;
    const { text, count } = translatePlaceholders(sql);
    assert.equal(count, 3);
    assert.ok(/VALUES \(\$1, .*\(\$2\)::interval.*, \$3\)$/.test(text), text);
    const today = translatePlaceholders(`SELECT ${pgTodayPlusBound()}, ?`);
    assert.equal(today.count, 2);
    assert.match(today.text, /\(\$1\)::interval/);
    assert.match(today.text, /'YYYY-MM-DD'\), \$2$/);
  });

  test('the hand-numbered helper still cannot go through the translator (it would be ambiguous)', () => {
    assert.throws(() => translatePlaceholders(`SELECT ${pgNowPlusParam(1)}`), /\$n placeholders/);
  });

  test('literal modifiers and text-column shifts compose too', () => {
    const { text, count } = translatePlaceholders(`SELECT ${pgNowPlus('+1 month')}, ${pgShiftText('created_at', '-30 days')} FROM t WHERE a = ?`);
    assert.equal(count, 1);
    assert.match(text, /app_shift_ts\(\(statement_timestamp\(\) AT TIME ZONE 'UTC'\), interval '1 month'\)/);
    assert.match(text, /\(\(created_at\)::timestamp \+ interval '-30 days'\)/);
  });
});

describe('SQLite-compatible date arithmetic in SQL text (M2, M3)', () => {
  test('month and year modifiers go through app_shift_ts; seconds to days use plain interval addition', () => {
    assert.match(pgNowPlus('+1 month'), /^to_char\(app_shift_ts\(\(statement_timestamp\(\) AT TIME ZONE 'UTC'\), interval '1 month'\), 'YYYY-MM-DD HH24:MI:SS'\)$/);
    assert.match(pgNowPlus('+1 year'), /interval '1 year'/);
    assert.match(pgNowPlus('-3 months'), /app_shift_ts\(.*interval '-3 months'/);
    assert.match(pgTodayPlus('+2 years'), /app_shift_ts\(.*interval '2 years'.*'YYYY-MM-DD'\)$/);
    for (const [mod, unit] of [['-10 minutes', 'minutes'], ['-1 hour', 'hour'], ['+5 seconds', 'seconds'], ['-30 days', 'days']]) {
      const sql = pgNowPlus(mod);
      assert.doesNotMatch(sql, /app_shift_ts/, `${mod} needs no helper`);
      assert.match(sql, new RegExp(`interval '-?\\d+ ${unit}'`));
    }
  });

  test('weeks are not a SQLite modifier, so they are rejected; only SQLite\'s own units are accepted', () => {
    for (const bad of ['+2 weeks', '1 week', '-1 weeks']) assert.throws(() => sqliteModifierToInterval(bad), /Unsupported date modifier/, bad);
    assert.deepEqual(parseSqliteModifier('-3 months'), { n: -3, unit: 'month' });
    assert.deepEqual(parseSqliteModifier('+1 year'), { n: 1, unit: 'year' });
  });
});

describe('classifyDbError: network and timeout failures (M8)', () => {
  const coded = (code, message = 'x') => Object.assign(new Error(message), { code });

  test('socket and DNS errors are connection errors, regardless of how many letters the code has', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']) {
      assert.deepEqual(classifyDbError(coded(code)), { kind: 'connection', driver: 'node', constraint: null }, code);
      assert.equal(isRetryableDbError(coded(code)), true, code);
    }
  });

  test('timeouts are timeouts: OS, pg client, statement, lock and idle-in-transaction', () => {
    for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT']) assert.equal(classifyDbError(coded(code)).kind, 'timeout', code);
    for (const sqlstate of ['57014', '25P03', '55P03']) assert.deepEqual(classifyDbError(coded(sqlstate)), { kind: 'timeout', driver: 'pg', constraint: null }, sqlstate);
    for (const message of ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout', 'Query read timeout', 'canceling statement due to statement timeout', 'canceling statement due to lock timeout']) {
      assert.equal(classifyDbError(new Error(message)).kind, 'timeout', message);
    }
    assert.equal(isRetryableDbError(coded('57014')), true);
  });

  test('pg client errors that carry no code are recognized by their message', () => {
    for (const message of ['Connection terminated unexpectedly', 'Connection terminated', 'Connection ended unexpectedly', 'terminating connection due to administrator command',
      'Client has encountered a connection error and is not queryable', 'Client was closed and is not queryable', 'server closed the connection unexpectedly']) {
      assert.equal(classifyDbError(new Error(message)).kind, 'connection', message);
    }
  });

  test('errno-shaped codes are never mistaken for PostgreSQL SQLSTATE', () => {
    for (const code of ['EPERM', 'EBUSY', 'EROFS', 'EXDEV', 'EBADF']) assert.deepEqual(classifyDbError(coded(code)), { kind: 'other', driver: 'node', constraint: null }, code);
    assert.equal(classifyDbError(coded('23505')).driver, 'pg');
    assert.equal(classifyDbError(coded('XX000')).driver, 'pg');
  });

  test('other PostgreSQL connection-level states, authentication and TLS problems', () => {
    for (const sqlstate of ['08001', '08003', '08006', '53300', '57P01', '57P02', '57P03']) assert.equal(classifyDbError(coded(sqlstate)).kind, 'connection', sqlstate);
    for (const sqlstate of ['28000', '28P01']) assert.equal(classifyDbError(coded(sqlstate)).kind, 'auth', sqlstate);
    for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED']) {
      assert.equal(classifyDbError(coded(code)).kind, 'tls', code);
      assert.equal(isRetryableDbError(coded(code)), false, `${code} is not retryable`);
    }
    for (const sqlstate of ['28P01', '23505', '23503', '42601']) assert.equal(isRetryableDbError(coded(sqlstate)), false, sqlstate);
    assert.equal(isRetryableDbError(coded('40001')), true);
  });

  test('wrapped and aggregate errors are classified by their cause', () => {
    assert.equal(classifyDbError(new Error('query failed', { cause: coded('ECONNRESET') })).kind, 'connection');
    const aggregate = Object.assign(new Error('multiple failures'), { errors: [coded('ECONNREFUSED'), coded('ECONNREFUSED')] });
    assert.equal(classifyDbError(aggregate).kind, 'connection');
    const loop = new Error('loop'); loop.cause = loop;
    assert.equal(classifyDbError(loop).kind, 'other');
  });

  test("the facade's own errors classify as timeout and as non-database errors", () => {
    const lock = new DbLockTimeoutError('gave up');
    assert.equal(lock.code, 'DB_LOCK_TIMEOUT');
    assert.deepEqual(classifyDbError(lock), { kind: 'timeout', driver: 'facade', constraint: null });
    assert.equal(isRetryableDbError(lock), true);
    assert.deepEqual(classifyDbError(new TransactionClosedError()), { kind: 'other', driver: 'facade', constraint: null });
    assert.equal(isRetryableDbError(new TransactionClosedError()), false);
  });
});

describe('identity sequence reset statements (M10, M2)', () => {
  test('statement shapes: lock, lookup and a setval that casts to regclass', () => {
    assert.deepEqual([...IDENTITY_TABLES], ['messages', 'audit_logs']);
    assert.equal(pgLockForResetSql('messages'), 'LOCK TABLE messages IN SHARE ROW EXCLUSIVE MODE');
    assert.equal(pgIdentitySequenceNameSql('audit_logs'), "SELECT pg_get_serial_sequence('audit_logs', 'seq') AS sequence_name");
    const all = pgResetAllIdentitiesSql();
    assert.equal(all.length, 2);
    assert.equal(all[0], "SELECT setval((COALESCE(pg_get_serial_sequence('messages', 'seq'), 'no_owned_sequence_for_messages_seq'))::regclass, COALESCE((SELECT MAX(seq) FROM messages), 0) + 1, false) AS next_value");
    // is_called = false: the next value handed out is exactly max + 1 (and 1 for an empty table)
    for (const sql of all) assert.match(sql, /, false\) AS next_value$/);
  });

  test('a missing sequence cannot make the statement a silent NULL: the name is never passed to setval unguarded', () => {
    for (const t of IDENTITY_TABLES) {
      const sql = pgResetIdentitySql(t);
      assert.doesNotMatch(sql, /setval\(pg_get_serial_sequence/, 'setval must not receive the raw lookup result (NULL would be silent)');
      assert.ok(sql.includes(`'${missingSequenceName(t, 'seq')}'`), 'the fallback name is table and column specific');
    }
  });

  test('table and column names are validated, never interpolated blindly', () => {
    for (const bad of ["messages'; DROP TABLE users; --", 'Messages', '1x', '', 'a b', 'a.b']) {
      assert.throws(() => pgResetIdentitySql(bad), /plain lowercase identifiers/, bad);
      assert.throws(() => pgLockForResetSql(bad), /plain lowercase identifiers/, bad);
      assert.throws(() => pgIdentitySequenceNameSql(bad), /plain lowercase identifiers/, bad);
    }
    assert.throws(() => pgResetIdentitySql('messages', 'seq) --'), /plain lowercase identifiers/);
    assert.throws(() => pgIdentitySequenceNameSql('messages', 'a.b'), /plain lowercase identifiers/);
  });
});
