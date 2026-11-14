// Static check that db/migrations/001_init.sql (PostgreSQL) matches the SQLite schema in server/db.js.
//
// It reads server/db.js as TEXT, runs only that schema into a throwaway in-memory SQLite database to
// introspect it, and parses the PostgreSQL file as text. It never imports server/db.js, never opens a
// file database and never contacts PostgreSQL, so it cannot touch any real data. It proves the two
// definitions agree on tables, columns, constraints and indexes; that the PostgreSQL file actually
// applies is verified in the phase that adds a disposable PostgreSQL.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { PG_NOW_TS, PG_TODAY, PG_SHIFT_FUNCTION } from '../server/db/sql.js';
import { WIDE_INTEGER_COLUMNS, FLAG_COLUMNS, INT4_COLUMNS } from '../server/db/preflight.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const pgSql = read('db/migrations/001_init.sql');

// ---------- SQLite side ----------

function sqliteSchemaText() {
  const src = read('server/db.js');
  const start = src.indexOf('export function initSchema()');
  const open = src.indexOf('db.exec(`', start) + 'db.exec(`'.length;
  const close = src.indexOf('`);', open);
  assert.ok(start > 0 && open > start && close > open, 'could not locate the schema in server/db.js');
  return src.slice(open, close);
}

function introspectSqlite() {
  const mem = new DatabaseSync(':memory:');
  try {
    mem.exec('PRAGMA foreign_keys = ON;');
    mem.exec(sqliteSchemaText());
    const tables = {};
    for (const { name, sql } of mem.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
      const columns = mem.prepare(`PRAGMA table_info(${name})`).all().map((c) => ({ name: c.name, type: c.type, notNull: c.notnull === 1, pk: c.pk > 0, dflt: c.dflt_value }));
      const fks = mem.prepare(`PRAGMA foreign_key_list(${name})`).all().map((f) => `${f.from}->${f.table}.${f.to} ON DELETE ${f.on_delete}`).sort();
      const uniques = [];
      for (const idx of mem.prepare(`PRAGMA index_list(${name})`).all()) {
        const cols = mem.prepare(`PRAGMA index_info(${idx.name})`).all().map((i) => i.name);
        if (idx.origin === 'u') uniques.push(cols.join(','));
      }
      tables[name] = { columns, fks, uniques: uniques.sort(), pk: columns.filter((c) => c.pk).map((c) => c.name), checks: checkLists(sql) };
    }
    const indexes = mem.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all()
      .map(({ name, tbl_name }) => `${name} on ${tbl_name}(${mem.prepare(`PRAGMA index_info(${name})`).all().map((i) => i.name).join(',')})`).sort();
    return { tables, indexes };
  } finally {
    mem.close();
  }
}

// CHECK(col IN ('A', 'B')) -> { col: ['A', 'B'] }
function checkLists(sql) {
  const out = {};
  for (const m of sql.matchAll(/CHECK\s*\(\s*(\w+)\s+IN\s*\(((?:[^()']|'(?:[^']|'')*')*)\)\s*\)/g)) {
    out[m[1]] = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1]);
  }
  return out;
}

// ---------- PostgreSQL side (a small parser for exactly the shapes this file uses) ----------

const stripComments = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

// Split on commas that are not inside parentheses or quotes.
function topLevelItems(body) {
  const items = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function parsePg() {
  const clean = stripComments(pgSql);
  const tables = {};
  const order = [];
  for (const m of clean.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const [, name, body] = m;
    const t = { columns: [], fks: [], uniques: [], pk: [], checks: {}, rawColumns: {} };
    for (const item of topLevelItems(body)) {
      let r;
      if ((r = /^FOREIGN KEY \((\w+)\) REFERENCES (\w+)\((\w+)\)(?: ON DELETE (CASCADE|SET NULL))?$/.exec(item))) {
        t.fks.push(`${r[1]}->${r[2]}.${r[3]} ON DELETE ${r[4] || 'NO ACTION'}`);
      } else if ((r = /^UNIQUE\s*\(([^)]*)\)$/.exec(item))) {
        t.uniques.push(r[1].split(',').map((c) => c.trim()).join(','));
      } else if ((r = /^PRIMARY KEY\s*\(([^)]*)\)$/.exec(item))) {
        t.pk.push(...r[1].split(',').map((c) => c.trim()));
      } else {
        const col = /^("?)(\w+)\1\s+([A-Z]+(?: PRECISION)?)\b([\s\S]*)$/.exec(item);
        assert.ok(col, `cannot parse column definition in ${name}: ${item}`);
        const [, quoted, cname, type, rest] = col;
        const dflt = /\bDEFAULT\s+(\((?:[^()]|\([^()]*\)|\((?:[^()]|\([^()]*\))*\))*\)|'(?:[^']|'')*'|[-\w.]+)/.exec(rest);
        t.columns.push({ name: cname, type, quoted: quoted === '"', notNull: /\bNOT NULL\b/.test(rest), pk: /\bPRIMARY KEY\b/.test(rest), identity: /GENERATED (?:BY DEFAULT|ALWAYS) AS IDENTITY/.test(rest), dflt: dflt ? dflt[1] : null });
        if (/\bPRIMARY KEY\b/.test(rest)) t.pk.push(cname);
        if (/\bUNIQUE\b/.test(rest)) t.uniques.push(cname);
        t.rawColumns[cname] = rest;
        Object.assign(t.checks, checkLists(`${cname} ${rest}`));
      }
    }
    t.uniques.sort();
    t.fks.sort();
    tables[name] = t;
    order.push(name);
  }
  const indexes = [...clean.matchAll(/CREATE INDEX (\w+) ON (\w+)\(([^)]*)\);/g)]
    .map((m) => `${m[1]} on ${m[2]}(${m[3].split(',').map((c) => c.trim()).join(',')})`).sort();
  return { tables, order, indexes };
}

const sqlite = introspectSqlite();
const pg = parsePg();
// Columns that are 64-bit in SQLite and must stay BIGINT in PostgreSQL (money, and unbounded user input).
const MONEY_COLUMNS = new Set(WIDE_INTEGER_COLUMNS);
const IDENTITY_TABLES = ['messages', 'audit_logs'];

describe('PostgreSQL schema matches the SQLite schema', () => {
  test('the same tables exist (plus schema_migrations)', () => {
    assert.deepEqual(Object.keys(pg.tables).filter((t) => t !== 'schema_migrations').sort(), Object.keys(sqlite.tables).sort());
    assert.ok(pg.tables.schema_migrations, 'schema_migrations exists');
    assert.equal(Object.keys(sqlite.tables).length, 26);
  });

  test('every table has the same columns in the same order (plus seq on messages and audit_logs)', () => {
    for (const [name, s] of Object.entries(sqlite.tables)) {
      const pgCols = pg.tables[name].columns.map((c) => c.name).filter((c) => !(IDENTITY_TABLES.includes(name) && c === 'seq'));
      assert.deepEqual(pgCols, s.columns.map((c) => c.name), `columns of ${name}`);
    }
    for (const t of IDENTITY_TABLES) {
      const seq = pg.tables[t].columns.find((c) => c.name === 'seq');
      assert.ok(seq && seq.identity && seq.type === 'BIGINT', `${t}.seq is a BIGINT identity column`);
      assert.match(pg.tables[t].rawColumns.seq, /GENERATED BY DEFAULT AS IDENTITY/);
      assert.equal(pg.tables[t].columns[1].name, 'seq', `${t}.seq follows id`);
    }
    const others = Object.entries(pg.tables).filter(([n]) => !IDENTITY_TABLES.includes(n)).flatMap(([, t]) => t.columns.filter((c) => c.identity));
    assert.equal(others.length, 0, 'no other identity columns');
  });

  test('column types map exactly (TEXT, INTEGER, REAL to DOUBLE PRECISION; money and unbounded-input columns BIGINT)', () => {
    for (const [name, s] of Object.entries(sqlite.tables)) {
      for (const col of s.columns) {
        const p = pg.tables[name].columns.find((c) => c.name === col.name);
        const id = `${name}.${col.name}`;
        const expected = col.type === 'REAL' ? 'DOUBLE PRECISION' : (MONEY_COLUMNS.has(id) ? 'BIGINT' : col.type);
        assert.equal(p.type, expected, `type of ${id}`);
      }
    }
    for (const id of MONEY_COLUMNS) {
      const [t, c] = id.split('.');
      assert.equal(sqlite.tables[t].columns.find((x) => x.name === c).type, 'INTEGER', `${id} is an INTEGER in SQLite`);
    }
  });

  test('NOT NULL, primary keys, unique constraints and foreign keys match', () => {
    for (const [name, s] of Object.entries(sqlite.tables)) {
      const p = pg.tables[name];
      for (const col of s.columns.filter((c) => !c.pk)) {
        assert.equal(p.columns.find((c) => c.name === col.name).notNull, col.notNull, `NOT NULL of ${name}.${col.name}`);
      }
      assert.deepEqual([...p.pk].sort(), [...s.pk].sort(), `primary key of ${name}`);
      assert.deepEqual(p.uniques, s.uniques, `unique constraints of ${name}`);
      assert.deepEqual(p.fks, s.fks, `foreign keys of ${name}`);
    }
  });

  test('column defaults match, with SQLite date functions replaced by the shared PostgreSQL expressions', () => {
    const translate = (d) => (d === "datetime('now')" ? `(${PG_NOW_TS})` : d === "date('now')" ? `(${PG_TODAY})` : d);
    let checked = 0;
    for (const [name, s] of Object.entries(sqlite.tables)) {
      for (const col of s.columns) {
        const p = pg.tables[name].columns.find((c) => c.name === col.name);
        if (col.dflt === null) { assert.equal(p.dflt, null, `${name}.${col.name} has no default`); continue; }
        const sqliteDefault = col.dflt.startsWith('(') ? col.dflt.slice(1, -1) : col.dflt;
        const expected = ['datetime(\'now\')', 'date(\'now\')'].includes(sqliteDefault) ? translate(sqliteDefault) : col.dflt;
        assert.equal(p.dflt, expected, `default of ${name}.${col.name}`);
        checked++;
      }
    }
    assert.ok(checked >= 50, `expected the defaults of every column to be compared, got ${checked}`);
  });

  test('CHECK constraints list the same values', () => {
    let lists = 0;
    for (const [name, s] of Object.entries(sqlite.tables)) {
      assert.deepEqual(pg.tables[name].checks, s.checks, `CHECK lists of ${name}`);
      lists += Object.keys(s.checks).length;
    }
    assert.ok(lists >= 25, `expected the enum checks to be compared, got ${lists}`);
    assert.deepEqual(pg.tables.feedback.checks.decision, ['New', 'Shipped', 'In progress', 'Planned', "Won''t do"]);
  });

  test('the explicit indexes match', () => {
    assert.equal(sqlite.indexes.length, 16);
    assert.deepEqual(pg.indexes, sqlite.indexes);
  });

  test('tables are created after the tables they reference', () => {
    const position = Object.fromEntries(pg.order.map((n, i) => [n, i]));
    for (const [name, t] of Object.entries(pg.tables)) {
      for (const fk of t.fks) {
        const ref = /->(\w+)\./.exec(fk)[1];
        assert.ok(position[ref] < position[name], `${name} references ${ref}, which must be created first`);
      }
    }
  });
});

describe('PostgreSQL-specific requirements', () => {
  test('reserved words are never used as unquoted names, and current_role is quoted', () => {
    const RESERVED = new Set(['all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'both', 'case', 'cast', 'check', 'collate', 'column', 'constraint', 'create',
      'current_catalog', 'current_date', 'current_role', 'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except',
      'false', 'fetch', 'for', 'foreign', 'from', 'grant', 'group', 'having', 'in', 'initially', 'intersect', 'into', 'lateral', 'leading', 'limit', 'localtime', 'localtimestamp', 'not',
      'null', 'offset', 'on', 'only', 'or', 'order', 'placing', 'primary', 'references', 'returning', 'select', 'session_user', 'some', 'symmetric', 'system_user', 'table', 'then', 'to',
      'trailing', 'true', 'union', 'unique', 'user', 'using', 'variadic', 'when', 'where', 'window', 'with',
      'authorization', 'binary', 'collation', 'concurrently', 'cross', 'current_schema', 'freeze', 'full', 'ilike', 'inner', 'is', 'isnull', 'join', 'left', 'like', 'natural', 'notnull',
      'outer', 'overlaps', 'right', 'similar', 'tablesample', 'verbose']);
    for (const [table, t] of Object.entries(pg.tables)) {
      assert.ok(!RESERVED.has(table), `table name ${table} is reserved`);
      for (const c of t.columns) {
        if (c.quoted) continue;
        assert.ok(!RESERVED.has(c.name.toLowerCase()), `column ${table}.${c.name} is a reserved word and must be quoted`);
      }
    }
    const role = pg.tables.alumni_profiles.columns.find((c) => c.name === 'current_role');
    assert.ok(role && role.quoted, 'alumni_profiles."current_role" is quoted');
    assert.deepEqual(Object.values(pg.tables).flatMap((t) => t.columns.filter((c) => c.quoted).map((c) => c.name)), ['current_role']);
  });

  test('no SQLite-only syntax is left in the file', () => {
    const code = stripComments(pgSql);
    // (Statement kinds are checked separately: ON DELETE CASCADE is legitimate, a DELETE statement is not.)
    for (const bad of [/\bdatetime\s*\(/i, /\bdate\s*\('now'/i, /\bAUTOINCREMENT\b/i, /\bPRAGMA\b/i, /\bREAL\b/, /\bINSERT\b/i, /^\s*(UPDATE|DELETE|DROP)\b/im, /\browid\b/i, /\bWITHOUT ROWID\b/i]) {
      assert.doesNotMatch(code, bad, `unexpected ${bad}`);
    }
  });

  test('schema_migrations is created empty', () => {
    const cols = pg.tables.schema_migrations.columns.map((c) => c.name);
    assert.deepEqual(cols, ['version', 'name', 'applied_at']);
    assert.deepEqual(pg.tables.schema_migrations.pk, ['version']);
    assert.doesNotMatch(stripComments(pgSql), /\bINSERT\b/i);
  });

  test('the file is plain DDL: one table or index per statement, ending with a semicolon', () => {
    const statements = stripComments(pgSql).split(';').map((s) => s.trim()).filter(Boolean);
    assert.ok(statements.length > 40);
    for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) \w/, `unexpected statement: ${s.slice(0, 60)}`);
    assert.equal(statements.filter((s) => s.startsWith('CREATE TABLE')).length, 27);
    assert.equal(statements.filter((s) => s.startsWith('CREATE INDEX')).length, 16);
  });
});

// ---------------------------------------------------------------------------------------------
// Corrective follow-up tests (independent review findings M3, M11, M12)
// ---------------------------------------------------------------------------------------------

describe('migration files (M3, M11, M12)', () => {
  const fn002 = read('db/migrations/002_sqlite_compat_functions.sql');

  test('nothing masks schema drift: no IF NOT EXISTS and no CREATE OR REPLACE anywhere', () => {
    for (const [name, sql] of [['001_init.sql', pgSql], ['002_sqlite_compat_functions.sql', fn002]]) {
      const code = stripComments(sql);
      assert.doesNotMatch(code, /IF NOT EXISTS/i, `${name} must fail loudly if an object already exists`);
      assert.doesNotMatch(code, /OR REPLACE/i, `${name} must not silently replace an existing object`);
      assert.doesNotMatch(code, /\bDROP\b/i, `${name} must not drop anything`);
    }
  });

  test('the BIGINT columns are exactly the ones the preflight treats as wide', () => {
    const bigint = Object.entries(pg.tables).flatMap(([t, def]) => def.columns.filter((c) => c.type === 'BIGINT' && !c.identity).map((c) => `${t}.${c.name}`)).sort();
    assert.deepEqual(bigint, [...WIDE_INTEGER_COLUMNS].sort());
    assert.equal(WIDE_INTEGER_COLUMNS.length, 12);
  });

  test('every INTEGER column in the SQLite schema is classified for the data preflight (none can go unchecked)', () => {
    const classified = [...WIDE_INTEGER_COLUMNS, ...FLAG_COLUMNS, ...INT4_COLUMNS];
    assert.equal(new Set(classified).size, classified.length, 'no column is listed twice');
    const integers = Object.entries(sqlite.tables).flatMap(([t, def]) => def.columns.filter((c) => c.type === 'INTEGER').map((c) => `${t}.${c.name}`)).sort();
    assert.deepEqual(integers, [...classified].sort());
    // Flags are INTEGER 0/1 columns with a 0/1 default; 32-bit columns really are INTEGER in PostgreSQL.
    for (const key of FLAG_COLUMNS) {
      const [t, c] = key.split('.');
      assert.equal(pg.tables[t].columns.find((x) => x.name === c).type, 'INTEGER', key);
      assert.match(String(pg.tables[t].columns.find((x) => x.name === c).dflt), /^[01]$/, `${key} has a 0/1 default`);
    }
    for (const key of INT4_COLUMNS) {
      const [t, c] = key.split('.');
      assert.equal(pg.tables[t].columns.find((x) => x.name === c).type, 'INTEGER', key);
    }
  });

  test('every default timestamp uses the per-statement function, never the transaction-wide now()', () => {
    const code = stripComments(pgSql);
    assert.doesNotMatch(code, /\bnow\(\)|clock_timestamp/i);
    // one per SQLite column that defaults to datetime('now') or date('now'), plus schema_migrations.applied_at
    const sqliteNowDefaults = Object.values(sqlite.tables).flatMap((t) => t.columns).filter((c) => /^\(?(datetime|date)\('now'\)\)?$/.test(String(c.dflt))).length;
    assert.ok(sqliteNowDefaults >= 20, `expected the SQLite schema to have many timestamp defaults, got ${sqliteNowDefaults}`);
    assert.equal([...code.matchAll(/statement_timestamp\(\)/g)].length, sqliteNowDefaults + 1);
  });

  test('002 defines exactly one function, app_shift_ts, with the documented signature and properties', () => {
    const code = stripComments(fn002);
    assert.equal([...code.matchAll(/CREATE FUNCTION/g)].length, 1);
    assert.match(code, /CREATE FUNCTION app_shift_ts\(ts timestamp, iv interval\) RETURNS timestamp\s+LANGUAGE sql IMMUTABLE STRICT/);
    assert.equal(PG_SHIFT_FUNCTION, 'app_shift_ts');
    // the algorithm described in the header: first of the month + months + original day offset/time + remaining interval
    assert.match(code, /date_trunc\('month', ts\)/);
    assert.match(code, /\(ts - date_trunc\('month', ts\)\)/);
    assert.match(code, /EXTRACT\(YEAR FROM iv\) \* 12 \+ EXTRACT\(MONTH FROM iv\)/);
    assert.match(code, /\$\$\s*;?\s*$/);
    assert.equal([...code.matchAll(/\$\$/g)].length, 2, 'one dollar-quoted body');
  });
});
