// Tests that use SQLite itself as the reference ("oracle") for the migration helpers:
//   * the month/year date-arithmetic ALGORITHM behind db/migrations/002_sqlite_compat_functions.sql,
//   * the data preflight queries (server/db/preflight.js),
//   * the inventory of queries that would expose the PostgreSQL-only seq column.
//
// Everything runs on throwaway in-memory SQLite databases. Nothing here touches a file database, the
// application's database module, PostgreSQL or Neon. (The PostgreSQL text itself is only checked
// structurally elsewhere; running it on a real PostgreSQL is the job of a later phase.)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { buildPreflightQueries, introspectSqlite, runPreflight, openReadOnlyForPreflight, WIDE_INTEGER_COLUMNS } from '../server/db/preflight.js';
import os from 'node:os';
import { INTERNAL_COLUMNS } from '../server/db/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- the SQLite schema, taken from server/db.js as TEXT ----------

function schemaText() {
  const src = fs.readFileSync(path.join(repoRoot, 'server', 'db.js'), 'utf8');
  const start = src.indexOf('export function initSchema()');
  const open = src.indexOf('db.exec(`', start) + 'db.exec(`'.length;
  return src.slice(open, src.indexOf('`);', open));
}

function memoryDb({ foreignKeys = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'};`);
  db.exec(schemaText());
  return db;
}

// ---------- date arithmetic: SQLite is the reference ----------

const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmt = (ms) => { const d = new Date(ms); return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
function parts(text) {
  const [date, time] = text.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  return { y, m, d, h, mi, s, ms: Date.UTC(y, m - 1, d, h, mi, s), monthStart: Date.UTC(y, m - 1, 1) };
}
const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

// The algorithm app_shift_ts uses: first day of the target month, plus the original day offset and
// time of day, plus the interval's own days and time. (Seconds to days: plain addition.)
function appShift(text, n, unit) {
  const p = parts(text);
  if (UNIT_MS[unit]) return fmt(p.ms + n * UNIT_MS[unit]);
  const months = unit === 'year' ? n * 12 : n;
  const firstOfTargetMonth = Date.UTC(p.y, p.m - 1 + months, 1);
  return fmt(firstOfTargetMonth + (p.ms - p.monthStart));
}

// What a plain PostgreSQL interval does: add the months, then clamp the day to the end of that month.
function clampedShift(text, n, unit) {
  const p = parts(text);
  const months = unit === 'year' ? n * 12 : n;
  const target = Date.UTC(p.y, p.m - 1 + months, 1);
  const t = new Date(target);
  const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(p.d, lastDay), p.h, p.mi, p.s));
}

const modifier = (n, unit) => `${n >= 0 ? '+' : ''}${n} ${unit}s`;

describe('month and year arithmetic: the algorithm matches SQLite (M2)', () => {
  const mem = new DatabaseSync(':memory:');
  const sqlite = (text, n, unit) => mem.prepare('SELECT datetime(?, ?) AS v').get(text, modifier(n, unit)).v;

  const TRICKY = ['2025-01-31 10:00:00', '2025-03-31 23:59:59', '2025-05-31 00:00:00', '2025-08-31 12:30:45', '2025-10-31 06:00:00', '2025-12-31 23:59:59',
    '2025-01-30 01:02:03', '2025-01-29 01:02:03', '2025-02-28 15:00:00', '2024-02-29 08:00:00', '2024-02-28 08:00:00', '2023-02-28 23:59:59',
    '2024-12-31 00:00:00', '2025-01-01 00:00:00', '2000-02-29 12:00:00', '2100-02-28 12:00:00', '2025-07-15 13:14:15', '1999-12-31 23:59:59'];

  test('hand-picked month-end, leap-day and year-boundary dates', () => {
    for (const t of TRICKY) {
      for (const unit of ['month', 'year', 'day', 'hour', 'minute', 'second']) {
        for (const n of [1, -1, 2, -2, 5, 11, 12, 13, -12, -13, 24, 25, 30, -30, 365, -365, 0]) {
          assert.equal(appShift(t, n, unit), sqlite(t, n, unit), `${t} ${modifier(n, unit)}`);
        }
      }
    }
  });

  test('five thousand pseudo-random timestamps and modifiers (deterministic seed)', () => {
    let seed = 20261114;
    const next = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
    const units = ['month', 'year', 'day', 'hour', 'minute', 'second'];
    let compared = 0;
    for (let i = 0; i < 5000; i++) {
      const t = `${1990 + next(130)}-${pad(1 + next(12))}-${pad(1 + next(28 + next(4)))}`; // up to day 31; impossible dates are skipped below
      const text = `${t} ${pad(next(24))}:${pad(next(60))}:${pad(next(60))}`;
      if (Number.isNaN(Date.parse(`${text.replace(' ', 'T')}Z`)) || fmt(Date.parse(`${text.replace(' ', 'T')}Z`)) !== text) continue; // e.g. Feb 30
      const unit = units[next(units.length)];
      const n = next(2001) - 1000;
      assert.equal(appShift(text, n, unit), sqlite(text, n, unit), `${text} ${modifier(n, unit)}`);
      compared++;
    }
    assert.ok(compared > 4000, `most generated cases must be real dates and actually compared, got ${compared}`);
  });

  test('a plain interval (clamping to month end) is NOT the same, which is why app_shift_ts exists', () => {
    assert.equal(sqlite('2025-01-31 10:00:00', 1, 'month'), '2025-03-03 10:00:00', 'SQLite normalizes the overflow');
    assert.equal(clampedShift('2025-01-31 10:00:00', 1, 'month'), '2025-02-28 10:00:00', 'a plain PostgreSQL interval clamps');
    assert.equal(appShift('2025-01-31 10:00:00', 1, 'month'), '2025-03-03 10:00:00');
    assert.equal(sqlite('2024-02-29 08:00:00', 1, 'year'), '2025-03-01 08:00:00');
    assert.equal(clampedShift('2024-02-29 08:00:00', 1, 'year'), '2025-02-28 08:00:00');
    assert.equal(appShift('2024-02-29 08:00:00', 1, 'year'), '2025-03-01 08:00:00');
    let differing = 0;
    for (const t of TRICKY) for (const unit of ['month', 'year']) for (const n of [1, 2, 12]) if (clampedShift(t, n, unit) !== sqlite(t, n, unit)) differing++;
    assert.ok(differing >= 10, `the clamping behavior differs from SQLite for many realistic dates (${differing} of ${TRICKY.length * 6})`);
  });

  test('SQLite has no weeks unit: its answer is NULL, which is why the helper rejects it', () => {
    assert.equal(mem.prepare("SELECT datetime('2025-01-01 00:00:00', '+2 weeks') AS v").get().v, null);
  });

  test('SQLite evaluates "now" once per statement, the behavior statement_timestamp() reproduces', () => {
    assert.equal(mem.prepare("SELECT datetime('now') = datetime('now') AS same, strftime('%f', 'now') = strftime('%f', 'now') AS samefrac").get().same, 1);
  });
});

// ---------- data preflight ----------


// runPreflight only accepts a handle opened read-only from a FILE, so the throwaway in-memory fixture is
// copied into a temporary file (VACUUM INTO) and that copy is opened through the module's own opener.
function preflightOf(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-fixture-'));
  const file = path.join(dir, 'copy.db');
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const handle = openReadOnlyForPreflight(file);
  const results = runPreflight(handle);
  handle.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

describe('data preflight queries (M12)', () => {
  test('a freshly created schema passes every check, and every column is covered', () => {
    const db = memoryDb();
    const results = preflightOf(db);
    assert.ok(results.length > 150, `expected a query per column and foreign key, got ${results.length}`);
    assert.deepEqual(results.filter((r) => r.status !== 'ok'), [], 'no finding, warning or unverifiable check on a fresh schema');
    const ids = new Set(results.map((r) => r.id));
    for (const key of WIDE_INTEGER_COLUMNS) assert.ok(ids.has(`${key}:bigint`), `${key} is checked as BIGINT`);
    assert.ok(ids.has('users.is_active:flag') && ids.has('institutions.hue:int4') && ids.has('courses.duration_years:double'));
    assert.ok(ids.has('alumni_profiles.skills_json:json') && ids.has('institutions.name:text'));
    assert.ok([...ids].some((id) => id.endsWith(':orphans')), 'foreign keys are checked');
    db.close();
  });

  test('it finds the bad values PostgreSQL would reject', () => {
    const db = memoryDb({ foreignKeys: false });
    const badOf = (id) => preflightOf(db).find((r) => r.id === id).bad;
    const insertInstitution = (id, extra = {}) => {
      const row = { id, name: 'N', short_name: 'S', abbr: 'A', domain: 'd', city: 'c', state: 's', type: 't', founded: 2000, ...extra };
      db.prepare(`INSERT INTO institutions (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
    };
    insertInstitution('ok');
    assert.equal(badOf('institutions.founded:bigint'), 0);

    insertInstitution('frac', { founded: 1999.5 }); // stored as REAL in an INTEGER column
    assert.equal(badOf('institutions.founded:bigint'), 1);
    insertInstitution('word', { founded: 'abc' }); // text in an INTEGER column
    assert.equal(badOf('institutions.founded:bigint'), 2);

    insertInstitution('big32', { hue: 3000000000 }); // fits SQLite, not a 32-bit PostgreSQL INTEGER
    assert.equal(badOf('institutions.hue:int4'), 1);
    insertInstitution('flag2', { is_sandbox: 2 });
    assert.equal(badOf('institutions.is_sandbox:flag'), 1);

    db.prepare("INSERT INTO institutions (id, name, short_name, abbr, domain, city, state, type, founded) VALUES ('nul', 'a' || char(0) || 'b', 'S', 'A', 'd', 'c', 's', 't', 2000)").run();
    assert.equal(badOf('institutions.name:text'), 1);

    // BIGINT accepts what 32-bit INTEGER would not: no false alarm for a large but whole number
    db.prepare("INSERT INTO courses (id, institution_id, name, level, duration_years, seats) VALUES ('c1', 'ok', 'n', 'UG', 3, 5000000000)").run();
    assert.equal(badOf('courses.seats:bigint'), 0);
    db.prepare("INSERT INTO courses (id, institution_id, name, level, duration_years, seats) VALUES ('c2', 'ok', 'n', 'UG', 3, 'many')").run();
    assert.equal(badOf('courses.seats:bigint'), 1);
    db.prepare("INSERT INTO courses (id, institution_id, name, level, duration_years) VALUES ('c3', 'ok', 'n', 'UG', 'three')").run();
    assert.equal(badOf('courses.duration_years:double'), 1);

    db.prepare("INSERT INTO courses (id, institution_id, name, level, duration_years) VALUES ('c4', 'ghost', 'n', 'UG', 3)").run();
    assert.equal(badOf('courses.institution_id->institutions.id:orphans'), 1);

    db.prepare("INSERT INTO users (id, email, password_hash, role, full_name) VALUES ('u1', 'u1@example.com', 'x', 'ALUMNI', 'U')").run();
    db.prepare(`INSERT INTO alumni_profiles (id, user_id, graduation_year, degree, branch, current_company, current_role, industry, location, skills_json)
      VALUES ('p1', 'u1', 2020, 'd', 'b', 'c', 'r', 'i', 'l', 'not json')`).run();
    assert.equal(badOf('alumni_profiles.skills_json:json'), 1);

    // PRAGMA foreign_key_check agrees about the orphan (the preflight is a superset of it)
    assert.ok(db.prepare('PRAGMA foreign_key_check').all().length >= 1);
    db.close();
  });

  test('queries are read-only and built only from validated identifiers', () => {
    const db = memoryDb();
    for (const q of buildPreflightQueries(introspectSqlite(db)).filter((x) => x.sql)) assert.match(q.sql, /^SELECT .* FROM /s, q.id);
    assert.throws(() => buildPreflightQueries([{ name: 'users; DROP TABLE users', columns: [], fks: [] }]), /Unsupported identifier/);
    assert.throws(() => buildPreflightQueries([{ name: 'users', columns: [{ name: 'a b', type: 'TEXT' }], fks: [] }]), /Unsupported identifier/);
    db.close();
  });
});

// ---------- the seq column must not reach callers ----------

describe('queries that would expose the seq identity column (M9)', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = walk(path.join(repoRoot, 'server')).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}db${path.sep}`));
  const rel = (f) => path.relative(repoRoot, f).split(path.sep).join('/');

  test('inventory: the only SELECT * on messages or audit_logs is the institution data export', () => {
    const star = /\bSELECT\s+(?:\w+\.)?\*\s+FROM\s+(audit_logs|messages)\b/i;
    const aliased = /\bSELECT\s+(\w+)\.\*\s+FROM\s+(audit_logs|messages)\s+\1\b/i;
    const hits = files.filter((f) => { const text = fs.readFileSync(f, 'utf8'); return star.test(text) || aliased.test(text); }).map(rel);
    // This is the known exposure, and only on PostgreSQL: the SQLite schema has no seq column. It is handled by the backend,
    // which hides a column only when the database reports it as the identity column of these tables (server/db/internal-columns.js),
    // never by the column's name. The permanent fix is an explicit column list in that query (a route change, recorded in
    // db/README.md). If it is fixed, make this list empty.
    assert.deepEqual(hits, ['server/routes/admin_institution.js']);
    assert.deepEqual(INTERNAL_COLUMNS.map((c) => `${c.table}.${c.column}`), ['messages.seq', 'audit_logs.seq']);
  });

  test('no application code refers to seq directly (and nothing is ever hidden by that name)', () => {
    for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\bseq\b/, `${rel(f)} must not use seq`);
  });
});
