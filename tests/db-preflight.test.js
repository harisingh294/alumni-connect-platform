// Tests for server/db/preflight.js (independent review finding M3): read-only enforcement, the new checks, the
// distinction between blockers, warnings and unverifiable checks, and identifier handling.
//
// Only temporary fixtures: every database here is created in a fresh temporary directory by this test and
// deleted afterwards. The application's database, the migration copy and any backup are never opened, and no
// PostgreSQL or Neon connection exists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  buildPreflightQueries, extractCheckExpressions, introspectSqlite, isPreflightReadOnlyHandle, openReadOnlyForPreflight, verifyReadOnlyOpenerForTests,
  PreflightReadOnlyError, runPreflight, summarizePreflight, MAX_SAFE
} from '../server/db/preflight.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Creates a database file from `setup(db)` (writable, test only), closes it, and returns its path.
function makeDb(dir, setup, name = 'fixture.db') {
  const file = path.join(dir, name);
  const db = new DatabaseSync(file);
  setup(db);
  db.close();
  return file;
}

// Runs the preflight on a fixture through the real read-only opener. Returns the results keyed by id.
function preflight(setup) {
  return withTempDir((dir) => {
    const handle = openReadOnlyForPreflight(makeDb(dir, setup));
    try {
      const results = runPreflight(handle);
      return Object.assign(results, { byId: Object.fromEntries(results.map((r) => [r.id, r])) });
    } finally { handle.close(); }
  });
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('read-only enforcement (fail closed)', () => {
  test('runPreflight refuses every handle that did not come from openReadOnlyForPreflight', () => {
    const memory = new DatabaseSync(':memory:');
    assert.throws(() => runPreflight(memory), PreflightReadOnlyError);
    memory.close();
    withTempDir((dir) => {
      const writable = new DatabaseSync(makeDb(dir, (d) => d.exec('CREATE TABLE t (id TEXT PRIMARY KEY)')));
      assert.throws(() => runPreflight(writable), (e) => e instanceof PreflightReadOnlyError && e.code === 'PREFLIGHT_NOT_READ_ONLY');
      writable.close();
      const rawReadOnly = new DatabaseSync(path.join(dir, 'fixture.db'), { readOnly: true });
      assert.throws(() => runPreflight(rawReadOnly), PreflightReadOnlyError, 'even a genuinely read-only raw handle is refused: it was not proven by the opener');
      rawReadOnly.close();
    });
    for (const bad of [null, undefined, {}, { prepare() {} }, 'a.db']) assert.throws(() => runPreflight(bad), PreflightReadOnlyError);
  });

  test('the opener refuses in-memory databases, URIs, empty paths, missing files and directories, and creates nothing', () => {
    withTempDir((dir) => {
      for (const bad of [':memory:', '', '   ', 'file:x.db?mode=rwc', null, undefined, 42]) assert.throws(() => openReadOnlyForPreflight(bad), PreflightReadOnlyError, String(bad));
      const missing = path.join(dir, 'missing.db');
      assert.throws(() => openReadOnlyForPreflight(missing), /not an existing regular file/);
      assert.equal(fs.existsSync(missing), false, 'a missing file is never created');
      assert.throws(() => openReadOnlyForPreflight(dir), /not an existing regular file/);
    });
  });

  test('there is no way to inject an opener: extra arguments are ignored, and the test seam never returns a handle', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a')"));
      assert.equal(openReadOnlyForPreflight.length, 1);
      let called = false;
      const trap = () => { called = true; throw new Error('must never be used'); };
      const handle = openReadOnlyForPreflight(file, { open: trap });
      assert.equal(called, false, 'a supplied opener is never called');
      assert.equal(isPreflightReadOnlyHandle(handle), true);
      handle.close();
      assert.equal(verifyReadOnlyOpenerForTests(file, (p, o) => new DatabaseSync(p, o)), true, 'the seam returns a verdict, not a handle');
      assert.throws(() => runPreflight(true), PreflightReadOnlyError);
    });
  });

  test('a runtime that ignores the readOnly option is detected by the canary and refused before the target is opened', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec('CREATE TABLE t (id TEXT PRIMARY KEY)'));
      const opened = [];
      const ignoresReadOnly = (p) => { const db = new DatabaseSync(p); opened.push(p); return db; }; // writable, option dropped
      assert.throws(() => verifyReadOnlyOpenerForTests(file, ignoresReadOnly), /did not honor the readOnly option/);
      assert.equal(opened.length, 1, 'only the canary was opened: the real file was never opened writable');
      assert.notEqual(opened[0], file);
      assert.equal(fs.existsSync(opened[0]), false, 'the canary directory is removed');
    });
  });

  test('the canary must fail for the RIGHT reason: any other error means read-only support is unproven', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec('CREATE TABLE t (id TEXT PRIMARY KEY)'));
      const calls = [];
      const open = (p) => { calls.push(p); throw new Error('some unrelated failure'); };
      assert.throws(() => verifyReadOnlyOpenerForTests(file, open), /unexpected reason, so read-only support could not be proven/);
      assert.equal(calls.length, 1, 'the target was not opened');
    });
  });

  test('a handle on which query_only cannot be confirmed is refused and closed', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec('CREATE TABLE t (id TEXT PRIMARY KEY)'));
      let closed = false;
      const cantOpen = Object.assign(new Error('unable to open database file'), { errcode: 14 });
      const fake = (p) => {
        if (p !== file) throw cantOpen; // honors readOnly on the canary
        return { exec() {}, prepare: () => ({ get: () => ({ query_only: 0 }) }), close() { closed = true; } };
      };
      assert.throws(() => verifyReadOnlyOpenerForTests(file, fake), /query_only could not be enabled/);
      assert.equal(closed, true);
      const failing = (p) => { if (p !== file) throw cantOpen; return { exec() { throw new Error('boom'); }, close() { closed = 'again'; } }; };
      assert.throws(() => verifyReadOnlyOpenerForTests(file, failing), /cannot enable query_only: boom/);
    });
  });

  test('an open failure is reported, never retried writable', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec('CREATE TABLE t (id TEXT PRIMARY KEY)'));
      const calls = [];
      const cantOpen = Object.assign(new Error('unable to open database file'), { errcode: 14 });
      const open = (p, o) => { calls.push(o); if (p !== file) throw cantOpen; throw new Error('cannot open'); };
      assert.throws(() => verifyReadOnlyOpenerForTests(file, open), /cannot open .* read-only/);
      assert.ok(calls.every((o) => o?.readOnly === true), 'every open used readOnly: true');
      assert.equal(calls.length, 2);
    });
  });

  test('a WAL-mode file, or any file with sidecars, is refused by the plain opener', () => {
    withTempDir((dir) => {
      const wal = makeDb(dir, (d) => d.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id TEXT PRIMARY KEY)"), 'wal.db');
      assert.throws(() => openReadOnlyForPreflight(wal), /WAL mode.*openSnapshotForPreflight/s);
      const plain = makeDb(dir, (d) => d.exec('CREATE TABLE t (id TEXT PRIMARY KEY)'), 'plain.db');
      for (const suffix of ['-wal', '-shm', '-journal']) {
        fs.writeFileSync(plain + suffix, '');
        assert.throws(() => openReadOnlyForPreflight(plain), new RegExp(`${suffix} exists`), suffix);
        fs.rmSync(plain + suffix);
      }
      fs.writeFileSync(path.join(dir, 'junk.db'), 'not a database at all, but longer than one hundred bytes '.repeat(4));
      assert.throws(() => openReadOnlyForPreflight(path.join(dir, 'junk.db')), PreflightReadOnlyError);
      fs.writeFileSync(path.join(dir, 'empty.db'), '');
      assert.throws(() => openReadOnlyForPreflight(path.join(dir, 'empty.db')), PreflightReadOnlyError);
      assert.deepEqual({ ...openReadOnlyForPreflight(plain).close() }, { cleaned: true, directory: null });
    });
  });

  test('the opened handle is branded, frozen, and refuses anything but the fixed read statements', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a')"));
      const handle = openReadOnlyForPreflight(file);
      assert.equal(isPreflightReadOnlyHandle(handle), true);
      assert.equal(isPreflightReadOnlyHandle({ ...handle }), false, 'a copy is not branded');
      assert.ok(Object.isFrozen(handle));
      assert.equal(Number(handle.prepare('PRAGMA query_only').get().query_only), 1);
      for (const sql of [
        "INSERT INTO t VALUES ('b')", "DELETE FROM t", "UPDATE t SET id = 'z'", 'DROP TABLE t', 'CREATE TABLE x (a)', 'PRAGMA query_only = OFF', 'PRAGMA query_only(0)',
        'PRAGMA query_only=0', 'PRAGMA writable_schema = 1', 'PRAGMA journal_mode = WAL', 'PRAGMA user_version = 5', 'VACUUM', "ATTACH DATABASE 'x.db' AS x",
        'SELECT 1; DROP TABLE t', 'SELECT 1;\nDELETE FROM t', 'WITH x AS (SELECT 1) DELETE FROM t', 'BEGIN IMMEDIATE', '', '   ', null, undefined, 5
      ]) assert.throws(() => handle.prepare(sql), PreflightReadOnlyError, String(sql));
      assert.deepEqual({ ...handle.prepare('SELECT id FROM t').get() }, { id: 'a' });
      handle.close();
    });
  });

  test('evidence: this Node enforces read-only at the connection level, and a full preflight leaves the file byte-identical with no side files', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => {
        d.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER CHECK(n >= 0), created_at TEXT); INSERT INTO t VALUES ('a', 1, '2026-01-01 00:00:00')");
      });
      // Raw connection-level read-only: even after query_only is switched OFF, a write is refused by the engine.
      const raw = new DatabaseSync(file, { readOnly: true });
      raw.exec('PRAGMA query_only = OFF');
      assert.throws(() => raw.exec("INSERT INTO t VALUES ('b', 2, 'x')"), /readonly database/);
      raw.close();

      const before = sha(file);
      const mtime = fs.statSync(file).mtimeMs;
      const handle = openReadOnlyForPreflight(file);
      const results = runPreflight(handle);
      assert.ok(results.length > 3);
      assert.throws(() => handle.prepare("INSERT INTO t VALUES ('c', 3, 'x')"), PreflightReadOnlyError);
      handle.close();
      assert.equal(sha(file), before, 'file bytes unchanged');
      assert.equal(fs.statSync(file).mtimeMs, mtime, 'modification time unchanged');
      assert.deepEqual(fs.readdirSync(dir), ['fixture.db'], 'no journal, WAL or other side file was created');
    });
  });
});

describe('NULL primary keys', () => {
  test('a NULL in a TEXT PRIMARY KEY is a blocker (SQLite allows it, PostgreSQL does not)', () => {
    const r = preflight((d) => d.exec("CREATE TABLE a (id TEXT PRIMARY KEY, v TEXT); INSERT INTO a VALUES ('x', 'v'); INSERT INTO a VALUES (NULL, 'w'); INSERT INTO a VALUES (NULL, 'z')"));
    assert.deepEqual({ ...r.byId['a.id:pk-null'] }, { id: 'a.id:pk-null', description: r.byId['a.id:pk-null'].description, severity: 'blocker', status: 'found', bad: 2 });
    assert.equal(summarizePreflight(r).outcome, 'blocked');
  });

  test('composite primary keys are checked per column; clean tables pass', () => {
    const r = preflight((d) => d.exec("CREATE TABLE c (a TEXT, b TEXT, PRIMARY KEY (a, b)); INSERT INTO c VALUES ('1', NULL); INSERT INTO c VALUES (NULL, '2'); INSERT INTO c VALUES ('ok', 'ok'); CREATE TABLE clean (id TEXT PRIMARY KEY); INSERT INTO clean VALUES ('x')"));
    assert.equal(r.byId['c.a:pk-null'].bad, 1);
    assert.equal(r.byId['c.b:pk-null'].bad, 1);
    assert.equal(r.byId['clean.id:pk-null'].status, 'ok');
  });

  test('an INTEGER PRIMARY KEY (rowid alias) and tables without a primary key produce no false alarm', () => {
    const r = preflight((d) => d.exec("CREATE TABLE i (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO i (v) VALUES ('x'); CREATE TABLE nopk (v TEXT); INSERT INTO nopk VALUES (NULL)"));
    assert.equal(r.byId['i.id:pk-null'].status, 'ok');
    assert.equal(r.some((x) => x.id.startsWith('nopk.') && x.id.endsWith(':pk-null')), false);
  });
});

describe('CHECK constraints', () => {
  const unchecked = (sql) => (d) => { d.exec('PRAGMA ignore_check_constraints = ON'); d.exec(sql); };

  test('rows violating a column-level or table-level CHECK are blockers; NULL and valid rows are not', () => {
    const r = preflight(unchecked(`
      CREATE TABLE k (id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('A', 'B')), n INTEGER, m INTEGER, CONSTRAINT pos CHECK (n > 0 OR n IS NULL), CHECK(m <> n));
      INSERT INTO k VALUES ('ok', 'A', 1, 2);
      INSERT INTO k VALUES ('nullkind', NULL, 1, 2);
      INSERT INTO k VALUES ('badkind', 'ZZZ', 1, 2);
      INSERT INTO k VALUES ('badn', 'B', -5, 2);
      INSERT INTO k VALUES ('badm', 'B', 3, 3);
    `));
    const checks = r.filter((x) => x.id.startsWith('k:check:'));
    assert.deepEqual(checks.map((c) => [c.id, c.bad, c.severity, c.status]), [
      ['k:check:1', 1, 'blocker', 'found'], ['k:check:2', 1, 'blocker', 'found'], ['k:check:3', 1, 'blocker', 'found']
    ]);
    assert.match(checks[0].description, /CHECK\(kind IN \('A', 'B'\)\)/);
  });

  test('a clean table passes every CHECK', () => {
    const r = preflight((d) => d.exec("CREATE TABLE k (id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('A','B'))); INSERT INTO k VALUES ('x', 'A')"));
    assert.equal(r.byId['k:check:1'].status, 'ok');
  });

  test('strings, quoted identifiers and comments containing the word CHECK or parentheses do not confuse the extractor', () => {
    const sql = `CREATE TABLE t (
      "check" TEXT, -- CHECK(this is a comment)
      note TEXT DEFAULT 'CHECK(x)' /* CHECK(also a comment) */,
      v TEXT CHECK(v NOT LIKE '%)%' AND length(v) > (1 + 1)),
      CHECK ( v <> 'a''b' )
    )`;
    assert.deepEqual(extractCheckExpressions(sql), ["v NOT LIKE '%)%' AND length(v) > (1 + 1)", "v <> 'a''b'"]);
    assert.deepEqual(extractCheckExpressions('CREATE TABLE t (a TEXT)'), []);
    assert.deepEqual(extractCheckExpressions(null), []);
  });

  test('a CREATE TABLE that cannot be parsed reliably is reported as unverifiable, never silently skipped', () => {
    for (const sql of ["CREATE TABLE t (a TEXT CHECK(a <> 'x)", 'CREATE TABLE t (a TEXT CHECK(a <> 1', 'CREATE TABLE t (a TEXT CHECK a > 1)', 'CREATE TABLE t (a TEXT /* CHECK(a>1)']) {
      assert.equal(extractCheckExpressions(sql), null, sql);
      const results = buildPreflightQueries([{ name: 't', sql, columns: [], fks: [] }]);
      assert.deepEqual(results.map((x) => [x.id, x.severity, x.kind]), [['t:check', 'unverifiable', 'unverifiable']]);
    }
  });

  test('a CHECK that cannot be evaluated is unverifiable and does not abort the other checks', () => {
    const queries = buildPreflightQueries([{ name: 't', sql: 'CREATE TABLE t (a TEXT CHECK(no_such_function(a)))', columns: [{ name: 'a', type: 'TEXT', pk: false }], fks: [] }]);
    assert.ok(queries.some((x) => x.id === 't:check:1' && x.kind === 'check'));
    const r = preflight((d) => d.exec('CREATE TABLE t (a TEXT, b TEXT); INSERT INTO t VALUES (1, 2)'));
    assert.ok(r.every((x) => x.status === 'ok'));
    // evaluate the failing expression through the real runner: build the fixture without the CHECK, then
    // patch the schema text the runner introspects by creating the table with a function that exists only while creating
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => {
        d.function('f', (x) => x);
        d.exec('CREATE TABLE t (a TEXT CHECK(f(a) IS NOT NULL OR a IS NULL)); INSERT INTO t VALUES (\'x\')');
      });
      const handle = openReadOnlyForPreflight(file);
      const results = runPreflight(handle);
      handle.close();
      const check = results.find((x) => x.id === 't:check:1');
      assert.equal(check.status, 'unverifiable');
      assert.equal(check.severity, 'unverifiable');
      assert.equal(check.bad, null);
      assert.match(check.reason, /could not be evaluated: .*f/);
      assert.ok(results.some((x) => x.id === 't.a:text' && x.status === 'ok'), 'other checks still ran');
      assert.equal(summarizePreflight(results).outcome, 'needs_review');
    });
  });
});

describe('text encoding', () => {
  test('invalid UTF-8 byte sequences are blockers; valid multi-byte text is not', () => {
    const r = preflight((d) => d.exec(`
      CREATE TABLE s (id TEXT PRIMARY KEY, body TEXT);
      INSERT INTO s VALUES ('ok', 'plain');
      INSERT INTO s VALUES ('uni', CAST(x'e282ac' AS TEXT));          -- a valid euro sign
      INSERT INTO s VALUES ('lone', CAST(x'ff41' AS TEXT));           -- 0xFF is never valid
      INSERT INTO s VALUES ('trunc', CAST(x'41e282' AS TEXT));        -- truncated 3-byte sequence
      INSERT INTO s VALUES ('surrogate', CAST(x'eda080' AS TEXT));    -- an encoded lone surrogate
      INSERT INTO s VALUES ('overlong', CAST(x'c080' AS TEXT));       -- overlong NUL
    `));
    assert.equal(r.byId['s.body:utf8'].bad, 4);
    assert.equal(r.byId['s.body:utf8'].severity, 'blocker');
    assert.equal(r.byId['s.id:utf8'].status, 'ok');
  });

  test('a stored replacement character U+FFFD is a warning (manual review), not a blocker', () => {
    const r = preflight((d) => d.exec("CREATE TABLE s (id TEXT PRIMARY KEY, body TEXT); INSERT INTO s VALUES ('a', 'caf' || char(65533)); INSERT INTO s VALUES ('b', 'fine')"));
    assert.equal(r.byId['s.body:replacement-char'].bad, 1);
    assert.equal(r.byId['s.body:replacement-char'].severity, 'warning');
    assert.equal(r.byId['s.body:utf8'].status, 'ok', 'U+FFFD is valid UTF-8');
    const sum = summarizePreflight(r);
    assert.equal(sum.outcome, 'needs_review');
    assert.deepEqual(sum.warnings.map((x) => x.id), ['s.body:replacement-char']);
    assert.deepEqual(sum.blockers, []);
  });

  test('a database that is not UTF-8 reports the byte-level text checks as unverifiable instead of guessing', () => {
    const r = preflight((d) => d.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE s (id TEXT PRIMARY KEY, body TEXT); INSERT INTO s VALUES ('a', 'hello')"));
    assert.equal(r.byId['database:encoding'].status, 'unverifiable');
    assert.match(r.byId['database:encoding'].reason, /UTF-16le/i);
    assert.equal('s.body:utf8' in r.byId, false, 'the UTF-8 check was skipped, not run against UTF-16 bytes');
    assert.equal(r.byId['s.body:text'].status, 'ok', 'no false NUL alarm: UTF-16 text contains 0x00 bytes by design');
    assert.equal(summarizePreflight(r).outcome, 'needs_review');
  });
});

describe('integers outside the JavaScript safe range', () => {
  function schemaText() {
    const src = fs.readFileSync(path.join(repoRoot, 'server', 'db.js'), 'utf8');
    const start = src.indexOf('export function initSchema()');
    const open = src.indexOf('db.exec(`', start) + 'db.exec(`'.length;
    return src.slice(open, src.indexOf('`);', open));
  }
  const withSeats = (...values) => (d) => {
    d.exec('PRAGMA foreign_keys = OFF');
    d.exec(schemaText());
    values.forEach((v, i) => d.prepare("INSERT INTO courses (id, institution_id, name, level, duration_years, seats) VALUES (?, 'i', 'n', 'UG', 3, ?)").run(`c${i}`, v));
  };

  test('exactly +/-(2^53 - 1) is accepted; one beyond is a blocker', () => {
    assert.equal(MAX_SAFE, Number.MAX_SAFE_INTEGER);
    const r = preflight(withSeats(MAX_SAFE, -MAX_SAFE, 5000000000));
    assert.equal(r.byId['courses.seats:safe-integer'].status, 'ok');
    const bad = preflight(withSeats(MAX_SAFE, MAX_SAFE + 1, -MAX_SAFE - 1, 9223372036854775807n));
    // node:sqlite binds Numbers as REAL beyond 2^53 unless given a BigInt, so the fixture passes BigInts for those
    assert.ok(bad.byId['courses.seats:safe-integer'].bad >= 1);
    assert.equal(bad.byId['courses.seats:safe-integer'].severity, 'blocker');
  });

  test('precisely: 2^53, -(2^53) and the int64 maximum are each counted', () => {
    const r = preflight(withSeats(BigInt(MAX_SAFE) + 1n, -(BigInt(MAX_SAFE) + 1n), 9223372036854775807n, BigInt(MAX_SAFE), 0));
    assert.equal(r.byId['courses.seats:safe-integer'].bad, 3);
  });

  test('every BIGINT column gets the check, and NULL is not flagged', () => {
    const r = preflight(withSeats(null, 1));
    const ids = r.filter((x) => x.id.endsWith(':safe-integer')).map((x) => x.id).sort();
    assert.equal(ids.length, 12);
    assert.ok(r.filter((x) => x.id.endsWith(':safe-integer')).every((x) => x.status === 'ok'));
  });
});

describe('mixed timestamp formats', () => {
  const ts = (rows) => (d) => {
    d.exec('CREATE TABLE e (id TEXT PRIMARY KEY, created_at TEXT, title TEXT)');
    rows.forEach((v, i) => d.prepare('INSERT INTO e VALUES (?, ?, ?)').run(`r${i}`, v, '2026-01-01T00:00:00Z'));
  };

  test('ISO T...Z values mixed with SQLite space-separated values are flagged (rows outside the dominant format)', () => {
    const r = preflight(ts(['2026-01-01 10:00:00', '2026-01-02 10:00:00', '2026-01-03 10:00:00', '2026-01-04T10:00:00Z', '2026-01-05T10:00:00.123Z']));
    assert.equal(r.byId['e.created_at:timestamp-format'].bad, 2);
    assert.equal(r.byId['e.created_at:timestamp-format'].severity, 'warning');
    assert.equal(summarizePreflight(r).outcome, 'needs_review');
  });

  test('a uniform column passes, whichever of the three recognized formats it uses; NULL is ignored', () => {
    for (const rows of [['2026-01-01 10:00:00', null, '2026-01-02 11:00:00'], ['2026-01-01T10:00:00Z', '2026-01-02T11:30:00.5Z'], ['2026-01-01', '2026-02-01']]) {
      assert.equal(preflight(ts(rows)).byId['e.created_at:timestamp-format'].status, 'ok', JSON.stringify(rows));
    }
  });

  test('date-only mixed with full timestamps, and unrecognized values, are counted', () => {
    assert.equal(preflight(ts(['2026-01-01 10:00:00', '2026-01-01 11:00:00', '2026-01-02'])).byId['e.created_at:timestamp-format'].bad, 1);
    assert.equal(preflight(ts(['2026-01-01 10:00:00', 'yesterday', '01/02/2026'])).byId['e.created_at:timestamp-format'].bad, 2);
    assert.equal(preflight(ts(['yesterday', 'today'])).byId['e.created_at:timestamp-format'].bad, 2, 'a column with no recognized format is not "consistent"');
  });

  test('only columns named like timestamps are examined (a documented limitation: this is a name rule)', () => {
    const r = preflight(ts(['2026-01-01 10:00:00']));
    assert.equal('e.title:timestamp-format' in r.byId, false);
    const names = buildPreflightQueries([{ name: 't', columns: ['starts_at', 'ends_on', 'birth_date', 'date', 'timestamp', 'created_at', 'data', 'update', 'status', 'format'].map((name) => ({ name, type: 'TEXT' })), fks: [] }])
      .filter((x) => x.id.endsWith(':timestamp-format')).map((x) => x.id.split('.')[1].split(':')[0]);
    assert.deepEqual(names, ['starts_at', 'ends_on', 'birth_date', 'date', 'timestamp', 'created_at']);
  });
});

describe('identifier handling', () => {
  test('valid uppercase and mixed-case names run, quoted, and are reported as a warning', () => {
    const r = preflight((d) => d.exec(`PRAGMA foreign_keys = OFF; CREATE TABLE Users (Id TEXT PRIMARY KEY, FullName TEXT, Age INTEGER); CREATE TABLE "ORDER_ITEMS" (id TEXT PRIMARY KEY, uid TEXT REFERENCES Users(Id));
      INSERT INTO Users VALUES ('u', 'Name', 5); INSERT INTO ORDER_ITEMS VALUES ('o', 'ghost');`));
    assert.equal(r.byId['Users.Age:int4'].status, 'ok');
    assert.equal(r.byId['Users.Id:pk-null'].status, 'ok');
    assert.equal(r.byId['ORDER_ITEMS.uid->Users.Id:orphans'].bad, 1);
    assert.equal(r.byId['Users:uppercase-name'].severity, 'warning');
    assert.equal(r.byId['Users.FullName:uppercase-name'].status, 'found');
    assert.equal(r.byId['ORDER_ITEMS:uppercase-name'].severity, 'warning');
    const built = buildPreflightQueries([{ name: 'Users', columns: [{ name: 'Age', type: 'INTEGER' }, { name: 'Id', type: 'TEXT', pk: true }], fks: [] }]);
    assert.ok(built.length >= 3);
    for (const q of built.filter((x) => x.sql)) assert.match(q.sql, /FROM "Users"/, q.id);
  });

  test('names that differ only by case are blockers (PostgreSQL would fold them together)', () => {
    const q = buildPreflightQueries([{ name: 'users', columns: [], fks: [] }, { name: 'Users', columns: [], fks: [] }]);
    assert.deepEqual(q.filter((x) => x.id.endsWith('name-collision')).map((x) => [x.id, x.severity, x.bad]), [['Users:name-collision', 'blocker', 1]]);
    const c = buildPreflightQueries([{ name: 't', columns: [{ name: 'abc', type: 'TEXT' }, { name: 'ABC', type: 'TEXT' }], fks: [] }]);
    assert.ok(c.some((x) => x.id === 't.ABC:name-collision' && x.severity === 'blocker'));
  });

  test('injection and malformed names are still rejected, for tables, columns and foreign keys', () => {
    const bad = ['users; DROP TABLE users', 'a b', 'a"b', "a'b", 'a.b', '1abc', '', 'ünï', 'a-b', 'a\nb', '"quoted"', 'a--', 'x/*y*/'];
    for (const name of bad) {
      assert.throws(() => buildPreflightQueries([{ name, columns: [], fks: [] }]), /Unsupported identifier/, `table ${JSON.stringify(name)}`);
      assert.throws(() => buildPreflightQueries([{ name: 't', columns: [{ name, type: 'TEXT' }], fks: [] }]), /Unsupported identifier/, `column ${JSON.stringify(name)}`);
      assert.throws(() => buildPreflightQueries([{ name: 't', columns: [], fks: [{ from: name, table: 'p', to: 'id' }] }]), /Unsupported identifier/, `fk ${JSON.stringify(name)}`);
      assert.throws(() => buildPreflightQueries([{ name: 't', columns: [], fks: [{ from: 'a', table: name, to: 'id' }] }]), /Unsupported identifier/, `fk parent ${JSON.stringify(name)}`);
    }
  });

  test('a table with an unsupported name makes the whole run fail rather than skip it', () => {
    withTempDir((dir) => {
      const file = makeDb(dir, (d) => d.exec('CREATE TABLE "bad name" (id TEXT PRIMARY KEY)'));
      const handle = openReadOnlyForPreflight(file);
      assert.throws(() => runPreflight(handle), /Unsupported identifier/);
      handle.close();
    });
  });
});

describe('blockers, warnings and unverifiable checks are distinguished', () => {
  test('columns with a declared type the preflight does not classify are unverifiable, not skipped', () => {
    const r = preflight((d) => d.exec("CREATE TABLE m (id TEXT PRIMARY KEY, b BLOB, n NUMERIC, u, d DATETIME); INSERT INTO m VALUES ('x', x'00', 1, 2, 'z')"));
    for (const col of ['b', 'n', 'u', 'd']) {
      const x = r.byId[`m.${col}:type`];
      assert.equal(x.status, 'unverifiable', col);
      assert.equal(x.severity, 'unverifiable');
      assert.equal(x.bad, null);
      assert.ok(x.reason);
    }
  });

  test('summarizePreflight: blocked beats needs_review beats clear, and each group holds the right results', () => {
    const base = { description: 'd', bad: 0 };
    const ok = { ...base, id: 'ok', severity: 'blocker', status: 'ok' };
    const blocker = { ...base, id: 'b', severity: 'blocker', status: 'found', bad: 2 };
    const warning = { ...base, id: 'w', severity: 'warning', status: 'found', bad: 1 };
    const unv = { ...base, id: 'u', severity: 'unverifiable', status: 'unverifiable', bad: null, reason: 'r' };
    assert.deepEqual(summarizePreflight([ok]), { outcome: 'clear', blockers: [], warnings: [], unverifiable: [], passed: 1, snapshotFindings: [] });
    assert.equal(summarizePreflight([ok, warning]).outcome, 'needs_review');
    assert.equal(summarizePreflight([ok, unv]).outcome, 'needs_review');
    const all = summarizePreflight([ok, blocker, warning, unv]);
    assert.equal(all.outcome, 'blocked');
    assert.deepEqual([all.blockers, all.warnings, all.unverifiable].map((g) => g.map((x) => x.id)), [['b'], ['w'], ['u']]);
    assert.equal(all.passed, 1);
    assert.equal(summarizePreflight([]).outcome, 'clear');
  });

  test('severity by check: types, nulls, safe integers, UTF-8, CHECK and orphans block; U+FFFD and timestamps warn', () => {
    const r = buildPreflightQueries([
      { name: 't', sql: 'CREATE TABLE t (a TEXT CHECK(a <> 1))', columns: [{ name: 'a', type: 'TEXT', pk: true }, { name: 'created_at', type: 'TEXT' }], fks: [{ from: 'a', table: 'p', to: 'id' }] },
      { name: 'p', columns: [{ name: 'id', type: 'TEXT', pk: true }], fks: [] }
    ]);
    const sev = Object.fromEntries(r.map((x) => [x.id.replace(/^t\./, ''), x.severity]));
    assert.equal(sev['a:pk-null'], 'blocker');
    assert.equal(sev['a:text'], 'blocker');
    assert.equal(sev['a:utf8'], 'blocker');
    assert.equal(sev['a:replacement-char'], 'warning');
    assert.equal(sev['created_at:timestamp-format'], 'warning');
    assert.equal(sev['a->p.id:orphans'], 'blocker');
    assert.equal(r.find((x) => x.id === 't:check:1').severity, 'blocker');
  });

  test('introspection still reports each table CREATE statement and primary-key flags', () => {
    withTempDir((dir) => {
      const handle = openReadOnlyForPreflight(makeDb(dir, (d) => d.exec('CREATE TABLE Z (a TEXT PRIMARY KEY, b INTEGER)')));
      const [t] = introspectSqlite(handle);
      handle.close();
      assert.equal(t.name, 'Z');
      assert.match(t.sql, /CREATE TABLE Z/);
      assert.deepEqual(t.columns, [{ name: 'a', type: 'TEXT', pk: true }, { name: 'b', type: 'INTEGER', pk: false }]);
    });
  });
});

describe('foreign keys: implicit targets and composite keys', () => {
  const fixture = (sql) => preflight((d) => { d.exec('PRAGMA foreign_keys = OFF'); d.exec(sql); });
  const orphans = (r) => r.filter((x) => x.id.endsWith(':orphans'));

  test('REFERENCES parent (no column) is resolved to the parent primary key', () => {
    const r = fixture("CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, pid TEXT REFERENCES parent); INSERT INTO parent VALUES ('p1'); INSERT INTO child VALUES ('c1', 'p1'); INSERT INTO child VALUES ('c2', 'ghost'); INSERT INTO child VALUES ('c3', NULL)");
    assert.deepEqual(orphans(r).map((x) => [x.id, x.status, x.bad, x.severity]), [['child.pid->parent.id:orphans', 'found', 1, 'blocker']]);
    assert.ok(r.every((x) => !/(^|[.>])null\b|"null"/.test(x.id)), 'no identifier named null');
  });

  test('the primary key is found even when it is not the first column, and for an explicit target as before', () => {
    const r = fixture("CREATE TABLE parent (name TEXT, code TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, a TEXT REFERENCES parent, b TEXT REFERENCES parent(code)); INSERT INTO parent VALUES ('n', 'k1'); INSERT INTO child VALUES ('c', 'k1', 'zz')");
    assert.deepEqual(orphans(r).map((x) => [x.id, x.bad]).sort(), [['child.a->parent.code:orphans', 0], ['child.b->parent.code:orphans', 1]]);
  });

  test('the parent name is matched case-insensitively, as SQLite does', () => {
    const r = fixture("CREATE TABLE Parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, pid TEXT REFERENCES parent); INSERT INTO child VALUES ('c', 'x')");
    assert.deepEqual(orphans(r).map((x) => [x.status, x.bad]), [['found', 1]]);
  });

  test('a composite implicit key maps child columns to the parent key columns in key order', () => {
    const r = fixture(`CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY (b, a));
      CREATE TABLE child (id TEXT PRIMARY KEY, x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES parent);
      INSERT INTO parent VALUES ('A1', 'B1');
      INSERT INTO child VALUES ('ok', 'B1', 'A1');
      INSERT INTO child VALUES ('swapped', 'A1', 'B1');
      INSERT INTO child VALUES ('half-null', 'B1', NULL);`);
    const [o] = orphans(r);
    assert.equal(o.id, 'child.(x,y)->parent.(b,a):orphans');
    assert.equal(o.bad, 1, 'only the swapped pair is an orphan; a NULL in any key column satisfies the constraint, as in SQLite');
  });

  test('a composite explicit key is checked as one key, not column by column', () => {
    const r = fixture(`CREATE TABLE parent (a TEXT, b TEXT, PRIMARY KEY (a, b));
      CREATE TABLE child (id TEXT PRIMARY KEY, x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES parent(a, b));
      INSERT INTO parent VALUES ('1', 'p'); INSERT INTO parent VALUES ('2', 'q');
      INSERT INTO child VALUES ('ok', '1', 'p');
      INSERT INTO child VALUES ('mixed', '1', 'q');`); // each column exists somewhere in the parent, the PAIR does not
    assert.equal(orphans(r)[0].bad, 1);
  });

  test('unresolvable targets are unverifiable, with a reason, and never abort the run', () => {
    const r = fixture(`CREATE TABLE nopk (v TEXT); CREATE TABLE twopk (a TEXT, b TEXT, PRIMARY KEY (a, b));
      CREATE TABLE c1 (id TEXT PRIMARY KEY, r TEXT REFERENCES nopk);
      CREATE TABLE c2 (id TEXT PRIMARY KEY, r TEXT REFERENCES twopk);
      CREATE TABLE c3 (id TEXT PRIMARY KEY, r TEXT REFERENCES ghost);
      CREATE TABLE c4 (id TEXT PRIMARY KEY, r TEXT REFERENCES ghost(id));
      CREATE TABLE c5 (id TEXT PRIMARY KEY, r TEXT REFERENCES nopk(nosuchcolumn));`);
    const found = Object.fromEntries(orphans(r).map((x) => [x.id.split('.')[0], x]));
    assert.deepEqual(Object.keys(found).sort(), ['c1', 'c2', 'c3', 'c4', 'c5']);
    for (const x of Object.values(found)) { assert.equal(x.status, 'unverifiable'); assert.equal(x.severity, 'unverifiable'); assert.equal(x.bad, null); }
    assert.match(found.c1.reason, /no declared primary key/);
    assert.match(found.c2.reason, /2-column primary key but the foreign key has 1/);
    assert.match(found.c3.reason, /referenced table ghost is not in the schema/);
    assert.match(found.c4.reason, /referenced table ghost is not in the schema/);
    assert.match(found.c5.reason, /no column nosuchcolumn/);
    assert.ok(r.every((x) => !/(^|[.>])null\b/.test(x.id)));
    assert.equal(summarizePreflight(r).outcome, 'needs_review');
  });

  test('queries are never built with a missing identifier: null and undefined are rejected, not turned into "null"', () => {
    const tables = (to, table) => [{ name: 'c', columns: [{ name: 'a', type: 'TEXT' }], fks: [{ from: 'a', table, to }] }, { name: 'p', columns: [{ name: 'id', type: 'TEXT', pk: true }], fks: [] }];
    const out = buildPreflightQueries(tables(null, 'p'));
    assert.equal(out.find((x) => x.id.includes('orphans')).sql.includes('"null"'), false);
    assert.match(out.find((x) => x.id.includes('orphans')).sql, /p\."id" IS NULL/, 'resolved to the primary key');
    assert.equal(buildPreflightQueries(tables(undefined, 'p')).find((x) => x.id.includes('orphans')).sql.includes('undefined'), false);
    for (const bad of [null, undefined, 5, {}, ['a']]) {
      assert.throws(() => buildPreflightQueries([{ name: bad, columns: [], fks: [] }]), /Unsupported identifier/);
      assert.throws(() => buildPreflightQueries([{ name: 'c', columns: [{ name: bad, type: 'TEXT' }], fks: [] }]), /Unsupported identifier/);
      assert.throws(() => buildPreflightQueries(tables('id', bad)), /Unsupported identifier/, `fk parent ${String(bad)}`);
    }
  });

  test('introspection reports foreign-key ids, positions and primary-key order', () => {
    withTempDir((dir) => {
      const handle = openReadOnlyForPreflight(makeDb(dir, (d) => d.exec('CREATE TABLE P (a TEXT, b TEXT, PRIMARY KEY (b, a)); CREATE TABLE C (x TEXT, y TEXT, FOREIGN KEY (x, y) REFERENCES P)')));
      const [c, p] = introspectSqlite(handle);
      handle.close();
      assert.deepEqual(p.primaryKey, ['b', 'a']);
      assert.deepEqual(c.fks.map((f) => ({ ...f })), [{ id: 0, seq: 0, from: 'x', table: 'P', to: null }, { id: 0, seq: 1, from: 'y', table: 'P', to: null }]);
    });
  });
});
