// Tests for server/db/internal-columns.js and for the facade's handling of a result column called seq
// (independent review finding M1).
//
// The problem: the PostgreSQL schema gives messages and audit_logs an identity column named seq, and the
// institution data export runs SELECT * on audit_logs. The first fix removed every property called seq from
// every result, which would silently drop a column or alias that the application selected on purpose.
// The fix: nothing is removed by NAME. A backend hides only a result column that the database reports as the
// identity column of messages or audit_logs.
//
// Everything here is pure: synthetic result metadata, stub backends and the text of the schema files. No
// database of any kind is opened.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../server/db/index.js';
import { INTERNAL_COLUMNS, isInternalColumn, internalResultNames, stripInternalColumns } from '../server/db/internal-columns.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

// Describes result columns the way the PostgreSQL driver reports them (source table and column, or none).
const fromTable = (table, ...columns) => columns.map((column) => ({ name: column, table, column }));
const expression = (name) => ({ name, table: null, column: null });

describe('stripInternalColumns hides by source, never by name', () => {
  test('the internal columns are exactly seq on messages and audit_logs', () => {
    assert.deepEqual(INTERNAL_COLUMNS.map((c) => `${c.table}.${c.column}`), ['messages.seq', 'audit_logs.seq']);
    assert.ok(Object.isFrozen(INTERNAL_COLUMNS) && INTERNAL_COLUMNS.every((c) => Object.isFrozen(c)));
    assert.equal(isInternalColumn('audit_logs', 'seq'), true);
    assert.equal(isInternalColumn('messages', 'seq'), true);
    for (const [t, c] of [['users', 'seq'], ['audit_logs', 'id'], ['messages', 'body'], ['audit_logs', 'SEQ'], ['Audit_Logs', 'seq'], [null, 'seq'], [undefined, undefined]]) {
      assert.equal(isInternalColumn(t, c), false, `${t}.${c}`);
    }
  });

  test('SELECT * on audit_logs: the identity column is hidden and every real column is kept', () => {
    const columns = ['id', 'institution_id', 'actor_id', 'actor_name', 'actor_role', 'action', 'target_type', 'target_id', 'details', 'created_at'];
    const fields = fromTable('audit_logs', 'id', 'seq', ...columns.slice(1));
    const rows = [{ id: 'al_1', seq: '7', institution_id: 'i', actor_id: null, actor_name: 'A', actor_role: 'ADMIN', action: 'X', target_type: null, target_id: null, details: '{}', created_at: '2026-01-01 00:00:00' }];
    const before = JSON.stringify(rows);
    const out = stripInternalColumns(rows, fields);
    assert.deepEqual(Object.keys(out[0]), ['id', ...columns.slice(1)]);
    assert.equal(JSON.stringify(rows), before, 'the input rows are not mutated');
    assert.notEqual(out, rows);
  });

  test('SELECT m.* on messages is handled the same way', () => {
    const out = stripInternalColumns([{ id: 'm1', seq: 1, body: 'hi' }], fromTable('messages', 'id', 'seq', 'body'));
    assert.deepEqual(out, [{ id: 'm1', body: 'hi' }]);
  });

  test('an explicitly selected seq from any OTHER table is preserved', () => {
    const rows = [{ id: 'u1', seq: 4 }];
    assert.equal(stripInternalColumns(rows, fromTable('users', 'id', 'seq')), rows);
    assert.deepEqual(stripInternalColumns(rows, fromTable('steps', 'id', 'seq')), [{ id: 'u1', seq: 4 }]);
  });

  test('a computed alias named seq is preserved (COUNT, ROW_NUMBER, a literal)', () => {
    const rows = [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }];
    for (const seq of [expression('seq'), { name: 'seq', table: undefined, column: undefined }, { name: 'seq' }]) {
      const out = stripInternalColumns(rows, [...fromTable('audit_logs', 'id'), seq]);
      assert.equal(out, rows, 'nothing is removed');
      assert.deepEqual(out, [{ id: 'a', seq: 1 }, { id: 'b', seq: 2 }]);
    }
  });

  test('when the real identity column and an alias share the name seq, the name is KEPT (real data is never dropped)', () => {
    const fields = [...fromTable('audit_logs', 'id', 'seq'), expression('seq')]; // SELECT *, ROW_NUMBER() OVER () AS seq FROM audit_logs
    assert.deepEqual(internalResultNames(fields), []);
    const rows = [{ id: 'a', seq: 1 }];
    assert.equal(stripInternalColumns(rows, fields), rows);
    // the same with another table's seq
    assert.deepEqual(internalResultNames([...fromTable('messages', 'seq'), ...fromTable('users', 'seq')]), []);
  });

  test('a join that brings the identity columns of BOTH tables hides the shared name, because every occurrence is internal', () => {
    const fields = [...fromTable('audit_logs', 'id', 'seq'), ...fromTable('messages', 'body', 'seq')];
    assert.deepEqual(internalResultNames(fields), ['seq']);
    assert.deepEqual(stripInternalColumns([{ id: 'a', body: 'b', seq: 9 }], fields), [{ id: 'a', body: 'b' }]);
  });

  test('names are exact: SEQ, seq_no and "seq " are different columns', () => {
    const rows = [{ SEQ: 1, seq_no: 2 }];
    assert.equal(stripInternalColumns(rows, [{ name: 'SEQ', table: 'audit_logs', column: 'SEQ' }, { name: 'seq_no', table: 'audit_logs', column: 'seq_no' }]), rows);
  });

  test('ordinary results are returned untouched: the same array, the same rows', () => {
    const rows = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }];
    const out = stripInternalColumns(rows, fromTable('users', 'id', 'n'));
    assert.equal(out, rows);
    assert.deepEqual(rows, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    assert.deepEqual(stripInternalColumns([], fromTable('audit_logs', 'id', 'seq')), []);
    assert.deepEqual(stripInternalColumns(rows, []), rows);
  });
});

describe('the institution data export keeps its shape without any filtering by name', () => {
  // Column names of one table, in order, from a CREATE TABLE block.
  function columnsOf(sql, table) {
    const block = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\n\\s*\\);`).exec(sql);
    assert.ok(block, `table ${table} found`);
    return block[1].split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter((l) => l && !/^(FOREIGN KEY|PRIMARY KEY|UNIQUE)/.test(l))
      .map((l) => /^"?(\w+)"?\s+[A-Z]/.exec(l)?.[1]).filter(Boolean);
  }
  const sqliteSchema = read('server/db.js');
  const pgSchema = read('db/migrations/001_init.sql');

  test('SQLite audit_logs has no seq, so today the export query already returns exactly the real columns', () => {
    const cols = columnsOf(sqliteSchema, 'audit_logs');
    assert.deepEqual(cols, ['id', 'institution_id', 'actor_id', 'actor_name', 'actor_role', 'action', 'target_type', 'target_id', 'details', 'created_at']);
    assert.equal(columnsOf(sqliteSchema, 'messages').includes('seq'), false);
  });

  test('on PostgreSQL SELECT * on audit_logs and messages returns seq too, and removing exactly the internal columns restores the SQLite shape', () => {
    for (const table of ['audit_logs', 'messages']) {
      const pgColumns = columnsOf(pgSchema, table);
      const sqliteColumns = columnsOf(sqliteSchema, table);
      assert.deepEqual(pgColumns.filter((c) => !sqliteColumns.includes(c)), ['seq'], `${table}: seq is the only extra PostgreSQL column`);
      const fields = pgColumns.map((column) => ({ name: column, table, column }));
      const row = Object.fromEntries(pgColumns.map((c) => [c, c === 'seq' ? '12' : `value of ${c}`]));
      const [stripped] = stripInternalColumns([row], fields);
      assert.deepEqual(Object.keys(stripped), sqliteColumns, `${table}: the result has the SQLite column list, in the SQLite order`);
    }
  });

  test('the internal list matches the schema: exactly the identity columns of 001_init.sql, and no other column anywhere is called seq', () => {
    const identity = [];
    const seqColumns = [];
    for (const m of pgSchema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
      for (const col of columnsOf(pgSchema, m[1])) if (col === 'seq') seqColumns.push(m[1]);
      for (const line of m[2].split('\n')) {
        const id = /^\s*"?(\w+)"?\s+BIGINT GENERATED (?:BY DEFAULT|ALWAYS) AS IDENTITY/.exec(line);
        if (id) identity.push(`${m[1]}.${id[1]}`);
      }
    }
    assert.deepEqual(identity.sort(), INTERNAL_COLUMNS.map((c) => `${c.table}.${c.column}`).sort());
    assert.deepEqual(seqColumns.sort(), ['audit_logs', 'messages']);
    for (const m of sqliteSchema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(/g)) assert.equal(columnsOf(sqliteSchema, m[1]).includes('seq'), false, `SQLite ${m[1]}`);
  });

  test('through the facade: a backend that hides by source returns the export shape, while the same facade keeps an aliased seq', async () => {
    const auditFields = fromTable('audit_logs', 'id', 'seq', 'action');
    const auditRows = [{ id: 'al_1', seq: '3', action: 'DATA_EXPORTED' }];
    const aliasFields = [...fromTable('audit_logs', 'id'), expression('seq')];
    const aliasRows = [{ id: 'al_1', seq: 1 }];
    // A stand-in for the future PostgreSQL backend: it knows each result column's source.
    const answers = { 'SELECT * FROM audit_logs': [auditRows, auditFields], 'SELECT id, ROW_NUMBER() OVER () AS seq FROM audit_logs': [aliasRows, aliasFields] };
    const ops = {
      get: async (sql) => stripInternalColumns(answers[sql][0], answers[sql][1])[0],
      all: async (sql) => stripInternalColumns(answers[sql][0], answers[sql][1]),
      query: async (sql) => { const rows = stripInternalColumns(answers[sql][0], answers[sql][1]); return { rows, rowCount: rows.length }; },
      run: async () => ({ changes: 0 }), exec: async () => {}
    };
    const db = createDb({ kind: 'stub', ...ops, transaction: (fn) => fn(ops), close: async () => {} });
    assert.deepEqual(await db.all('SELECT * FROM audit_logs'), [{ id: 'al_1', action: 'DATA_EXPORTED' }], 'the export does not expose the identity column');
    assert.deepEqual(await db.all('SELECT id, ROW_NUMBER() OVER () AS seq FROM audit_logs'), [{ id: 'al_1', seq: 1 }], 'a computed seq survives');
    assert.deepEqual(await db.get('SELECT * FROM audit_logs'), { id: 'al_1', action: 'DATA_EXPORTED' });
  });

  test('the facade source contains no removal of result properties by name', () => {
    const source = read('server/db/index.js');
    assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ''), /\bdelete\b|HIDDEN_RESULT_COLUMNS|withoutHidden|\bseq\b/, 'index.js must not filter results');
  });
});
