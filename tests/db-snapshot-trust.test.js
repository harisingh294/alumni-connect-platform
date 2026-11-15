// Tests for the final M3 corrective round ("snapshot trustworthiness"):
//   1. snapshot facts reach runPreflight / summarizePreflight (never an unqualified `clear` for a weak snapshot),
//   2. every copied byte is verified (short writes, lying writes, tampered copies),
//   3. the header is parsed from the COPY,
//   4. the main/WAL pairing limitation is documented,
//   5. a direct write probe proves the disposable snapshot is read-only before any handle is issued,
//   6. temporary snapshot directories are cleaned up (close, throw, process exit) without ever throwing from close().
//
// Only disposable fixtures in fresh temporary directories. No real database, backup, PostgreSQL or Neon.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SnapshotError, takeSnapshot } from '../server/db/snapshot.js';
import {
  isPreflightReadOnlyHandle, openReadOnlyForPreflight, openSnapshotForPreflight, PreflightReadOnlyError, retrySnapshotCleanup, runPreflight,
  setSnapshotRemoverForTests, snapshotCleanupFailures, summarizePreflight, verifySnapshotOpenerForTests, withSnapshotForPreflight
} from '../server/db/preflight.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Test files run in parallel processes and several of these tests list the temp directory to prove that nothing
// is left behind. Give this process a private temp directory so other files cannot interfere. os.tmpdir() reads
// the environment on every call: TMPDIR on POSIX, TEMP/TMP on Windows, so all three are set. It is removed when
// the process exits.
const PRIVATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-tests-'));
for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = PRIVATE_TMP;
if (os.tmpdir() !== PRIVATE_TMP) throw new Error(`private temp directory was not applied: os.tmpdir() is ${os.tmpdir()}`);
process.on('exit', () => { try { fs.rmSync(PRIVATE_TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const tmpSnapshots = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('preflight-snapshot-') || n.startsWith('preflight-canary-')).sort();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const idsOf = (results) => results.map((r) => r.id);

function scenario(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-test-'));
  const open = [];
  const track = (db) => { open.push(db); return db; };
  const cleanup = () => {
    for (const db of open) { try { db.close(); } catch { /* already closed */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  let result;
  try { result = fn(dir, track); } catch (err) { cleanup(); throw err; }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

// A WAL-mode database with a LIVE writer: autocheckpoint off, connection kept open, so commits stay in the -wal.
function liveWal(dir, track, setup, name = 'app.db') {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  const file = path.join(src, name);
  const writer = track(new DatabaseSync(file));
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  setup(writer);
  return { src, file, writer };
}
const CLEAN = (w) => { w.exec('CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER)'); for (let i = 0; i < 6; i += 1) w.exec(`INSERT INTO a VALUES ('r${i}', ${i})`); };
// A quiescent copy of main + wal WITHOUT a -shm: the state of a stopped application whose process crashed.
function quiescentCopy(dir, live, name = 'quiet') {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(live.file, path.join(d, 'app.db'));
  fs.copyFileSync(`${live.file}-wal`, path.join(d, 'app.db-wal'));
  return { dir: d, file: path.join(d, 'app.db'), wal: path.join(d, 'app.db-wal') };
}
const flipByte = (file, offset) => { const b = fs.readFileSync(file); b[offset] ^= 0xff; fs.writeFileSync(file, b); };
const lastFrameOffset = (walFile) => { const size = fs.statSync(walFile).size; const ps = fs.readFileSync(walFile).readUInt32BE(8); return 32 + (((size - 32) / (24 + ps)) - 1) * (24 + ps); };

// The full path a caller uses.
function inspect(source, options) {
  const handle = openSnapshotForPreflight(source, options);
  try {
    const results = runPreflight(handle);
    const summary = summarizePreflight(results);
    const rows = Number(handle.prepare('SELECT COUNT(*) AS c FROM "a"').get().c);
    return { results, summary, rows, snapshot: handle.snapshot };
  } finally { handle.close(); }
}
const inspectNoTable = (source, options) => {
  const handle = openSnapshotForPreflight(source, options);
  try { const results = runPreflight(handle); return { results, summary: summarizePreflight(results), snapshot: handle.snapshot }; } finally { handle.close(); }
};

describe('snapshot facts are part of the preflight result and summary', () => {
  test('a quiesced WAL snapshot with nothing wrong is the only way to get an unqualified clear', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const copy = quiescentCopy(dir, live);
    const r = inspect(copy.file);
    assert.equal(r.summary.outcome, 'clear');
    assert.deepEqual(idsOf(r.summary.snapshotFindings), ['snapshot:copy-verified']);
    assert.equal(r.rows, 6);
    assert.deepEqual(r.summary.warnings, []);
  }));

  test('clean-shutdown attestation: a warning, so the outcome is needs_review and never clear', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    live.writer.close();
    assert.deepEqual(fs.readdirSync(live.src), ['app.db']);
    const r = inspect(live.file, { cleanShutdownConfirmed: true });
    assert.equal(r.snapshot.assumedCleanShutdown, true);
    assert.equal(r.rows, 6);
    const finding = r.results.find((x) => x.id === 'snapshot:assumed-clean-shutdown');
    assert.deepEqual([finding.severity, finding.status, finding.bad], ['warning', 'found', 1]);
    assert.match(finding.description, /ASSUMES the database was shut down cleanly/);
    assert.equal(r.summary.outcome, 'needs_review');
    assert.deepEqual(r.summary.warnings.map((x) => x.id), ['snapshot:assumed-clean-shutdown']);
    assert.ok(idsOf(r.summary.snapshotFindings).includes('snapshot:assumed-clean-shutdown'));
  }));

  test('a -shm present in the source (a process may still be running) is reported', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    assert.ok(fs.existsSync(`${live.file}-shm`));
    const r = inspect(live.file);
    assert.equal(r.snapshot.shmPresentInSource, true);
    const finding = r.results.find((x) => x.id === 'snapshot:source-shm-present');
    assert.deepEqual([finding.severity, finding.status], ['warning', 'found']);
    assert.equal(r.summary.outcome, 'needs_review');
    assert.ok(r.summary.warnings.some((x) => x.id === 'snapshot:source-shm-present'));
  }));

  test('a damaged final WAL frame: the committed row after it is absent, and the result says so', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const copy = quiescentCopy(dir, live);
    flipByte(copy.wal, lastFrameOffset(copy.wal) + 24 + 50);
    const r = inspect(copy.file);
    assert.equal(r.rows, 5, 'six rows were committed in the source; the last one is not in the snapshot');
    assert.equal(r.snapshot.wal.damagedFrames, 1);
    assert.equal(r.snapshot.wal.staleFrames, 0);
    const finding = r.results.find((x) => x.id === 'snapshot:wal-tail-ignored');
    // the last transaction spanned two frames: the earlier one is valid but has no commit record, the last is damaged
    assert.deepEqual([finding.severity, finding.status, finding.bad], ['warning', 'found', 2]);
    assert.match(finding.description, /1 damaged frame/);
    assert.match(finding.description, /1 valid frame\(s\) without a commit record/);
    assert.match(finding.description, /may NOT be in this snapshot/);
    assert.notEqual(r.summary.outcome, 'clear');
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('a partial trailing frame is reported the same way', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const copy = quiescentCopy(dir, live);
    fs.truncateSync(copy.wal, fs.statSync(copy.wal).size - 100);
    const r = inspect(copy.file);
    assert.equal(r.rows, 5);
    assert.equal(r.snapshot.wal.partialTailBytes, 4120 - 100);
    const finding = r.results.find((x) => x.id === 'snapshot:wal-tail-ignored');
    assert.match(finding.description, /partial trailing frame \(4020 bytes\)/);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('valid frames without a commit record (an interrupted transaction) are reported', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const copy = quiescentCopy(dir, live);
    // Turn the last frame into a VALID but uncommitted one: zero its commit size and recompute its checksum.
    const wal = fs.readFileSync(copy.wal);
    const ps = wal.readUInt32BE(8);
    const frameSize = 24 + ps;
    const frames = (wal.length - 32) / frameSize;
    const ck = (b, off, len, s0, s1) => { for (let i = off; i < off + len; i += 8) { s0 = (s0 + b.readUInt32LE(i) + s1) >>> 0; s1 = (s1 + b.readUInt32LE(i + 4) + s0) >>> 0; } return [s0, s1]; };
    let [s0, s1] = [wal.readUInt32BE(24), wal.readUInt32BE(28)];
    for (let i = 0; i < frames; i += 1) {
      const o = 32 + i * frameSize;
      if (i === frames - 1) wal.writeUInt32BE(0, o + 4);
      let c = ck(wal, o, 8, s0, s1);
      c = ck(wal, o + 24, ps, c[0], c[1]);
      [s0, s1] = c;
      if (i === frames - 1) { wal.writeUInt32BE(s0, o + 16); wal.writeUInt32BE(s1, o + 20); }
    }
    fs.writeFileSync(copy.wal, wal);
    const r = inspect(copy.file);
    assert.equal(r.snapshot.wal.uncommittedValidFrames, 2, 'the last transaction had two frames; neither is committed any more');
    assert.equal(r.snapshot.wal.damagedFrames, 0);
    assert.equal(r.rows, 5, 'the interrupted transaction is not visible');
    assert.match(r.results.find((x) => x.id === 'snapshot:wal-tail-ignored').description, /2 valid frame\(s\) without a commit record/);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('frames that are VERIFIABLY intact leftovers of an older WAL generation do not raise the warning', () => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => { CLEAN(w); w.exec('PRAGMA wal_checkpoint(RESTART)'); w.exec("INSERT INTO a VALUES ('after', 1)"); });
    const copy = quiescentCopy(dir, live);
    const r = inspect(copy.file);
    assert.ok(r.snapshot.wal.verifiedStaleFrames > 0, 'precondition: old-generation frames are present and verified');
    assert.equal(r.snapshot.wal.unverifiedTrailingFrames, 0);
    assert.equal(r.snapshot.wal.damagedFrames, 0);
    assert.equal(r.rows, 7);
    assert.equal(r.results.some((x) => x.id === 'snapshot:wal-tail-ignored'), false);
    assert.equal(r.summary.outcome, 'clear');
  }));

  test('a snapshot with ZERO tables is blocked, never clear (a main file taken without its WAL)', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const mainOnly = path.join(dir, 'mainonly');
    fs.mkdirSync(mainOnly);
    fs.copyFileSync(live.file, path.join(mainOnly, 'app.db'));
    const r = inspectNoTable(path.join(mainOnly, 'app.db'), { cleanShutdownConfirmed: true });
    const finding = r.results.find((x) => x.id === 'database:no-tables');
    assert.deepEqual([finding.severity, finding.status, finding.bad], ['blocker', 'found', 1]);
    assert.match(finding.description, /nothing to migrate/);
    assert.match(finding.description, /committed data may be missing/);
    assert.equal(r.summary.outcome, 'blocked');
    assert.deepEqual(r.summary.blockers.map((x) => x.id), ['database:no-tables']);
    assert.ok(r.summary.warnings.some((x) => x.id === 'snapshot:assumed-clean-shutdown'), 'and the attestation is reported too');
  }));

  test('a table-less database is blocked on the plain path as well', () => scenario((dir) => {
    const file = path.join(dir, 'empty.db');
    const d = new DatabaseSync(file); d.exec('PRAGMA user_version = 1'); d.close();
    const handle = openReadOnlyForPreflight(file);
    try {
      const summary = summarizePreflight(runPreflight(handle));
      assert.equal(summary.outcome, 'blocked');
    } finally { handle.close(); }
  }));

  test('the live-source snapshot of a fixture with a bad row is blocked AND qualified', () => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => { CLEAN(w); w.exec('INSERT INTO a VALUES (NULL, 9)'); });
    const r = inspect(live.file);
    assert.equal(r.summary.outcome, 'blocked');
    assert.ok(r.summary.blockers.some((x) => x.id === 'a.id:pk-null'));
    assert.ok(r.summary.warnings.some((x) => x.id === 'snapshot:source-shm-present'));
  }));
});

describe('copied bytes are verified', () => {
  const snap = (live, hooks) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-dest-')); try { return takeSnapshot(live.file, d, { testHooks: hooks }); } finally { fs.rmSync(d, { recursive: true, force: true }); } };

  test('short writes are completed: the copy is still byte-identical', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-dest-'));
    try {
      let calls = 0;
      const dribble = (fd, buf, offset, length) => { calls += 1; return fs.writeSync(fd, buf, offset, Math.min(length, 7)); };
      const info = takeSnapshot(live.file, d, { testHooks: { writeSync: dribble } });
      assert.ok(calls > 1000, 'many partial writes were needed');
      assert.equal(sha(path.join(d, 'snapshot.db')), sha(live.file));
      assert.equal(sha(path.join(d, 'snapshot.db-wal')), sha(`${live.file}-wal`));
      assert.equal(info.copyVerified, true);
      assert.equal(info.walBytes, fs.statSync(`${live.file}-wal`).size);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }));

  test('a write that reports success but stores fewer bytes (main or WAL) is caught by re-reading the copy', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const mainSize = fs.statSync(live.file).size;
    for (const lieOn of ['main', 'wal']) {
      let written = 0;
      const liar = (fd, buf, offset, length) => {
        const inMain = written < mainSize; // the main file is copied first, then the WAL
        const lie = (lieOn === 'main') === inMain;
        written += length;
        fs.writeSync(fd, buf, offset, lie ? Math.max(1, length - 3) : length);
        return length; // claims everything was written
      };
      assert.throws(() => snap(live, { writeSync: liar }), (e) => e instanceof SnapshotError && new RegExp(`copied ${lieOn === 'main' ? 'main file' : 'WAL'} is \\d+ bytes but \\d+ bytes were read`).test(e.message), lieOn);
    }
  }));

  test('a write that accepts no bytes, or throws, is refused as a write failure', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    assert.throws(() => snap(live, { writeSync: () => 0 }), /cannot write the copy of the main file: .*accepted 0 bytes/);
    assert.throws(() => snap(live, { writeSync: () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); } }), /cannot write the copy of the main file: ENOSPC/);
  }));

  test('a copy changed after writing is refused: same-size corruption (SHA-256), truncation and growth, for main and WAL', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const tamper = (kind, which) => (paths) => {
      const file = which === 'main' ? paths.outMain : paths.outWal;
      if (kind === 'flip') flipByte(file, 200);
      else if (kind === 'truncate') fs.truncateSync(file, fs.statSync(file).size - 1);
      else fs.appendFileSync(file, 'x');
    };
    for (const which of ['main', 'wal']) {
      assert.throws(() => snap(live, { onBeforeVerifyCopy: tamper('flip', which) }), /does not match the source bytes \(SHA-256 differs\)/, `${which} flip`);
      for (const kind of ['truncate', 'grow']) assert.throws(() => snap(live, { onBeforeVerifyCopy: tamper(kind, which) }), /bytes were read from the source/, `${which} ${kind}`);
    }
  }));

  test('the WAL is analysed from the copied bytes: the reported frame counts come from the copy on disk', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-dest-'));
    try {
      const info = takeSnapshot(live.file, d);
      const ps = 4096;
      assert.equal(info.wal.completeFrames, (fs.statSync(path.join(d, 'snapshot.db-wal')).size - 32) / (24 + ps));
      assert.equal(info.walBytes, fs.statSync(path.join(d, 'snapshot.db-wal')).size);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }));
});

describe('the header comes from the copy', () => {
  const rollbackDb = (dir, rows = 2000) => {
    const file = path.join(dir, 'rb.db');
    const d = new DatabaseSync(file);
    d.exec('CREATE TABLE a (id TEXT PRIMARY KEY, b TEXT)');
    const ins = d.prepare('INSERT INTO a VALUES (?, ?)');
    for (let i = 0; i < rows; i += 1) ins.run(`k${i}`, 'x'.repeat(100));
    d.close();
    return file;
  };
  const refuses = (file, pattern, options) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-dest-')); try { assert.throws(() => takeSnapshot(file, d, options), pattern); } finally { fs.rmSync(d, { recursive: true, force: true }); } };

  test('a header that changes between source inspection and the copy is refused', () => scenario((dir) => {
    const file = rollbackDb(dir);
    // flip the journal-mode bytes (1,1) -> (2,2) after the source has been inspected but before it is copied
    refuses(file, /source changed while it was being copied \(main(?: content|, main content)?\)/, { testHooks: { onAfterFirstPass: ({ main }) => { const b = fs.readFileSync(main); b[18] = 2; b[19] = 2; fs.writeFileSync(main, b); } } });
  }));

  test('page size, journal mode and file size are taken from the copied bytes and match the file', () => scenario((dir) => {
    const file = rollbackDb(dir);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-dest-'));
    try {
      const info = takeSnapshot(file, d);
      const copy = fs.readFileSync(path.join(d, 'snapshot.db'));
      assert.equal(info.pageSize, copy.readUInt16BE(16));
      assert.equal(info.journalMode, copy[18] === 1 ? 'rollback' : 'wal');
      assert.equal(info.mainBytes, copy.length);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }));

  test('malformed or inconsistent copied headers are refused', () => scenario((dir) => {
    const good = fs.readFileSync(rollbackDb(dir));
    const variant = (name, mutate) => { const b = Buffer.from(good); mutate(b); const f = path.join(dir, `${name}.db`); fs.writeFileSync(f, b); return f; };
    refuses(variant('magic', (b) => { b[0] = 0x58; }), /not a SQLite database \(bad header\)/);
    refuses(variant('versions33', (b) => { b[18] = 3; b[19] = 3; }), /unsupported file format versions \(3, 3\)/);
    refuses(variant('versions21', (b) => { b[18] = 2; b[19] = 1; }), /unsupported file format versions \(2, 1\)/);
    refuses(variant('ps3000', (b) => b.writeUInt16BE(3000, 16)), /invalid page size 3000/);
    refuses(variant('ps0', (b) => b.writeUInt16BE(0, 16)), /invalid page size 0/);
    refuses(variant('size', (b) => { b.writeUInt16BE(8192, 16); }), /not a multiple of its page size|truncated/);
    refuses(path.join(dir, 'does-not-exist.db'), /does not exist/);
    const short = path.join(dir, 'short.db'); fs.writeFileSync(short, good.subarray(0, 50)); refuses(short, /not a SQLite database/);
  }));

  test('a main file cut off at a page boundary is caught by the header page count', () => scenario((dir) => {
    const file = rollbackDb(dir);
    const size = fs.statSync(file).size;
    assert.ok(size > 8 * 4096);
    fs.truncateSync(file, size - 4096 * 5);
    refuses(file, /holds \d+ pages but its header says \d+: it is truncated/);
  }));

  test('a WAL-mode database with sidecars on a non-WAL header is refused using the copied header', () => scenario((dir) => {
    const file = rollbackDb(dir);
    fs.writeFileSync(`${file}-wal`, '');
    refuses(file, /not in WAL mode but has -wal or -shm files/);
  }));
});

describe('the main/WAL pairing requirement', () => {
  test('KNOWN LIMITATION, documented: a WAL from another database with the same page size is NOT detected', () => scenario((dir, track) => {
    const a = liveWal(dir, track, (w) => w.exec("CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER); INSERT INTO a VALUES ('x', 1)"), 'a.db');
    const b = liveWal(path.join(dir, 'other'), track, (w) => w.exec('CREATE TABLE b (k TEXT, v TEXT); INSERT INTO b VALUES (\'1\', \'2\')'), 'b.db');
    const mixed = path.join(dir, 'mixed'); fs.mkdirSync(mixed);
    fs.copyFileSync(a.file, path.join(mixed, 'app.db'));
    fs.copyFileSync(`${b.file}-wal`, path.join(mixed, 'app.db-wal'));
    const handle = openSnapshotForPreflight(path.join(mixed, 'app.db'));
    try {
      const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      assert.deepEqual(tables, ['b'], 'a plausible but WRONG database passed every check; the WAL checksums do not identify the database');
    } finally { handle.close(); }
  }));

  test('the documentation states the requirement and the dangerous case, and does not claim checksums prove identity', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'db', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(readme, /adjacent `-wal` must belong to the exact database file/);
    assert.match(readme, /restoring or replacing a `\.db` file while leaving an older `-wal` beside it/);
    assert.match(readme, /WAL checksums do not prove which database a WAL belongs to/);
    assert.match(readme, /restored together with its matching WAL state, or from a cleanly closed database/);
    const source = fs.readFileSync(path.join(repoRoot, 'server', 'db', 'snapshot.js'), 'utf8');
    assert.match(source, /PAIRING/);
  });
});

describe('direct read-only proof on the disposable snapshot', () => {
  const cantOpen = Object.assign(new Error('unable to open database file'), { errcode: 14 });
  // honors read-only for the canary (missing file) and returns whatever `wrap` makes of a real connection otherwise
  const opener = (make) => (p, o) => { if (!fs.existsSync(p)) throw cantOpen; return make(p, o); };

  test('positive control: the real read-only opener passes the whole proof', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    assert.equal(verifySnapshotOpenerForTests(live.file, (p, o) => new DatabaseSync(p, o)), true);
    assert.deepEqual(tmpSnapshots().filter((n) => n.startsWith('preflight-snapshot-')), [], 'and its directory was removed');
  }));

  test('a target that is actually WRITABLE (it passes the canary) is refused, and its snapshot directory is removed', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const before = tmpSnapshots();
    const writable = opener((p) => new DatabaseSync(p)); // ignores readOnly for existing files
    assert.throws(() => verifySnapshotOpenerForTests(live.file, writable), (e) => e instanceof PreflightReadOnlyError && /accepted a write: it is NOT read-only, so no handle is issued/.test(e.message));
    assert.deepEqual(tmpSnapshots(), before);
  }));

  test('a write probe that fails for any reason other than read-only is also refused', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const odd = opener((p, o) => { const real = new DatabaseSync(p, o); const exec = real.exec.bind(real); real.exec = (sql) => { if (/__preflight_write_probe__/.test(sql)) throw Object.assign(new Error('disk I/O error'), { errcode: 10 }); return exec(sql); }; return real; });
    assert.throws(() => verifySnapshotOpenerForTests(live.file, odd), /for a reason other than read-only \(disk I\/O error\)/);
  }));

  test('a connection on which query_only cannot be restored after the probe is refused', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const stuck = opener((p, o) => {
      const real = new DatabaseSync(p, o); let off = false;
      const exec = real.exec.bind(real); const prepare = real.prepare.bind(real);
      real.exec = (sql) => { if (/query_only = OFF/.test(sql)) off = true; if (/query_only = ON/.test(sql) && off) return undefined; return exec(sql); };
      real.prepare = (sql) => (/^PRAGMA query_only$/.test(sql) && off ? { get: () => ({ query_only: 0 }) } : prepare(sql));
      return real;
    });
    assert.throws(() => verifySnapshotOpenerForTests(live.file, stuck), /query_only could not be re-enabled/);
  }));

  test('the probe changes neither the snapshot nor any source file', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const sourceBefore = Object.fromEntries(fs.readdirSync(live.src).filter((n) => !n.endsWith('-shm')).map((n) => [n, sha(path.join(live.src, n))]));
    const hashes = [];
    const spy = opener((p, o) => {
      const real = new DatabaseSync(p, o);
      hashes.push(['open', sha(p)]);
      const close = real.close.bind(real);
      real.close = () => { hashes.push(['close', sha(p)]); close(); };
      return real;
    });
    verifySnapshotOpenerForTests(live.file, spy);
    const snapshotHashes = hashes.filter(([, h]) => h);
    assert.equal(new Set(snapshotHashes.map(([, h]) => h)).size, 1, 'snapshot.db is byte-identical before and after the whole proof, including the write probe');
    const sourceAfter = Object.fromEntries(fs.readdirSync(live.src).filter((n) => !n.endsWith('-shm')).map((n) => [n, sha(path.join(live.src, n))]));
    assert.deepEqual(sourceAfter, sourceBefore);
  }));

  test('even a WRITABLE connection leaves nothing behind from the probe (it is rolled back)', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const seen = [];
    const writable = opener((p) => {
      const real = new DatabaseSync(p);
      const close = real.close.bind(real);
      real.close = () => { try { seen.push(real.prepare("SELECT name FROM sqlite_master WHERE name = '__preflight_write_probe__'").all().length); } catch { /* ignore */ } close(); };
      return real;
    });
    assert.throws(() => verifySnapshotOpenerForTests(live.file, writable), PreflightReadOnlyError);
    assert.deepEqual(seen.filter((n) => n !== 0), [], 'the probe table was never committed');
  }));

  test('the public API issues a branded handle only after the proof, and a failed proof leaves no handle and no directory', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const handle = openSnapshotForPreflight(live.file);
    assert.equal(isPreflightReadOnlyHandle(handle), true);
    assert.throws(() => handle.prepare('PRAGMA query_only = OFF'), PreflightReadOnlyError);
    handle.close();
    const before = tmpSnapshots();
    let issued = null;
    try { issued = verifySnapshotOpenerForTests(live.file, opener((p) => new DatabaseSync(p))); } catch { /* expected */ }
    assert.equal(issued, null, 'no result, so no handle, was produced');
    assert.deepEqual(tmpSnapshots(), before);
    assert.equal(openSnapshotForPreflight.length, 1);
  }));
});

describe('temporary snapshot cleanup', () => {
  test('close() removes the directory, reports it, never throws, and is idempotent', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const handle = openSnapshotForPreflight(live.file);
    const res = handle.close();
    assert.equal(res.cleaned, true);
    assert.match(path.basename(res.directory), /^preflight-snapshot-/);
    assert.equal(fs.existsSync(res.directory), false);
    assert.equal(handle.close(), res, 'a second close returns the first result');
  }));

  test('withSnapshotForPreflight closes the handle when the callback returns, throws, or rejects', async () => {
    await scenario(async (dir, track) => {
      const live = liveWal(dir, track, CLEAN);
      const before = tmpSnapshots();
      assert.equal(withSnapshotForPreflight(live.file, (h) => summarizePreflight(runPreflight(h)).outcome), 'needs_review');
      assert.deepEqual(tmpSnapshots(), before);
      assert.throws(() => withSnapshotForPreflight(live.file, {}, () => { throw new Error('caller failed'); }), /caller failed/);
      assert.deepEqual(tmpSnapshots(), before, 'removed although the caller threw');
      await assert.rejects(withSnapshotForPreflight(live.file, {}, async () => { throw new Error('async failure'); }), /async failure/);
      assert.deepEqual(tmpSnapshots(), before, 'removed although the callback rejected');
      assert.equal(await withSnapshotForPreflight(live.file, {}, async (h) => runPreflight(h).length > 0), true);
      assert.deepEqual(tmpSnapshots(), before);
    });
  });

  test('a snapshot that is refused leaves no directory behind', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const before = tmpSnapshots();
    live.writer.exec('BEGIN IMMEDIATE');
    flipByte(live.file, 0);
    assert.throws(() => openSnapshotForPreflight(live.file), SnapshotError);
    assert.deepEqual(tmpSnapshots(), before);
    live.writer.exec('ROLLBACK');
  }));

  test('a handle that is never closed is cleaned up when the process exits normally, and nothing else in the temp directory is touched', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const quiet = quiescentCopy(dir, live);
    const tmpRoot = path.join(dir, 'tmp-root');
    fs.mkdirSync(tmpRoot);
    const bystanders = ['preflight-snapshot-unrelated', 'something-else'];
    for (const name of bystanders) { fs.mkdirSync(path.join(tmpRoot, name)); fs.writeFileSync(path.join(tmpRoot, name, 'keep.txt'), 'keep'); }
    const script = `import { openSnapshotForPreflight } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'server', 'db', 'preflight.js')).href)};
      const h = openSnapshotForPreflight(${JSON.stringify(quiet.file)}); console.log('opened', h.snapshot.pageSize); /* deliberately not closed */`;
    const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env: { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, ''), /opened 4096/);
    assert.deepEqual(fs.readdirSync(tmpRoot).sort(), [...bystanders].sort(), 'its own snapshot directory is gone; unrelated directories are untouched');
    for (const name of bystanders) assert.equal(fs.readFileSync(path.join(tmpRoot, name, 'keep.txt'), 'utf8'), 'keep');
  }));

  test('a failing delete never makes close() throw, is NOT reported as deleted, and is retried later', async () => {
    await scenario(async (dir, track) => {
      const live = liveWal(dir, track, CLEAN);
      const warnings = [];
      const onWarning = (w) => { if (w.name === 'PreflightSnapshotCleanupWarning') warnings.push(w); };
      process.on('warning', onWarning);
      const restore = setSnapshotRemoverForTests(() => { throw new Error('EBUSY: resource busy (simulated)'); });
      let res;
      try {
        const handle = openSnapshotForPreflight(live.file);
        res = handle.close();
        assert.equal(res.cleaned, false);
        assert.match(res.error, /EBUSY/);
        assert.equal(fs.existsSync(res.directory), true, 'the directory is reported as still present because it is');
        assert.deepEqual(snapshotCleanupFailures().map((f) => f.directory), [res.directory]);
        await new Promise((r) => setImmediate(r));
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0].code, 'PREFLIGHT_SNAPSHOT_CLEANUP_FAILED');
        assert.match(warnings[0].message, /could NOT be removed/);
        assert.equal(retrySnapshotCleanup(), 1, 'still failing');
      } finally { restore(); process.off('warning', onWarning); }
      assert.equal(retrySnapshotCleanup(), 0, 'removed once deletion works again');
      assert.equal(fs.existsSync(res.directory), false);
      assert.deepEqual(snapshotCleanupFailures(), []);
    });
  });

  test('a delete that silently does nothing is detected, not trusted', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const restore = setSnapshotRemoverForTests(() => {}); // claims success, deletes nothing
    let res;
    try { res = openSnapshotForPreflight(live.file).close(); } finally { restore(); }
    assert.equal(res.cleaned, false);
    assert.match(res.error, /still exists after removal/);
    assert.equal(retrySnapshotCleanup(), 0);
    assert.equal(fs.existsSync(res.directory), false);
  }));

  test('only the handle\'s own snapshot directory is ever passed to the remover, and it is a private directory of this module', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const targets = [];
    const restore = setSnapshotRemoverForTests((d) => { targets.push(d); fs.rmSync(d, { recursive: true, force: true }); });
    let res;
    try { res = openSnapshotForPreflight(live.file).close(); } finally { restore(); }
    assert.deepEqual(targets, [res.directory]);
    assert.equal(path.dirname(res.directory), fs.realpathSync(os.tmpdir()) === path.dirname(res.directory) ? path.dirname(res.directory) : os.tmpdir());
    assert.match(path.basename(res.directory), /^preflight-snapshot-/);
    assert.ok(fs.existsSync(live.file), 'the source is untouched');
  }));

  test('the documentation shows the required try/finally pattern', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'db', 'README.md'), 'utf8');
    assert.match(readme, /try \{[\s\S]*?runPreflight\(db\)[\s\S]*?\} finally \{\s*db\.close\(\);/);
    const source = fs.readFileSync(path.join(repoRoot, 'server', 'db', 'preflight.js'), 'utf8');
    assert.match(source, /try \{[\s\S]*?runPreflight\(handle\)[\s\S]*?\} finally \{\s*handle\.close\(\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// Trailing-frame classification (final M3 correction). SQLite ignores every frame after the valid chain. That is only
// harmless for verifiable leftovers of an older WAL generation; a committed transaction that was zero-filled,
// corrupted or lost must never be mistaken for one.
// ---------------------------------------------------------------------------------------------
describe('WAL trailing frames: only verifiably intact older-generation frames are harmless', () => {
  const FRAME = 24 + 4096;
  const frameAt = (i) => 32 + i * FRAME;
  const frameCount = (wal) => (fs.statSync(wal).size - 32) / FRAME;
  // 6 autocommit inserts: 15 frames, the last transaction spans frames 13 and 14
  const base = (dir, track) => { const live = liveWal(dir, track, CLEAN); return { live, copy: quiescentCopy(dir, live) }; };
  // a WAL that was RESTARTED: the new generation is 2 frames, the 13 frames after them are the previous generation
  const restarted = (dir, track) => {
    const live = liveWal(dir, track, (w) => { CLEAN(w); w.exec('PRAGMA wal_checkpoint(RESTART)'); w.exec("INSERT INTO a VALUES ('after', 1)"); });
    return { live, copy: quiescentCopy(dir, live, 'restarted') };
  };
  const mutate = (file, fn) => { const b = fs.readFileSync(file); fn(b); fs.writeFileSync(file, b); };
  const outcomeOf = (file) => inspect(file);
  const tail = (r) => r.results.find((x) => x.id === 'snapshot:wal-tail-ignored');

  test('control: a valid quiesced WAL is clear', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    const r = outcomeOf(copy.file);
    assert.equal(r.summary.outcome, 'clear');
    assert.deepEqual([r.snapshot.wal.damagedFrames, r.snapshot.wal.unverifiedTrailingFrames, r.snapshot.wal.verifiedStaleFrames, r.snapshot.wal.partialTailBytes], [0, 0, 0, 0]);
    assert.equal(r.rows, 6);
  }));

  test('a valid older-generation tail is verified (its checksum chain holds) and stays clear; every committed row is present', () => scenario((dir, track) => {
    const { copy } = restarted(dir, track);
    const r = outcomeOf(copy.file);
    const w = r.snapshot.wal;
    assert.equal(r.rows, 7);
    assert.equal(w.validFrames, 2);
    assert.equal(w.verifiedStaleFrames, w.completeFrames - w.validFrames, 'every trailing frame is a verified leftover');
    assert.equal(w.verifiedStaleFrames, 13);
    assert.deepEqual([w.damagedFrames, w.unverifiedTrailingFrames], [0, 0]);
    assert.equal(r.summary.outcome, 'clear');
  }));

  test('a trailing frame with ZERO-FILLED salts (data and checksum intact) is damaged current-generation data: its row is absent and the result is needs_review', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    mutate(copy.wal, (b) => b.fill(0, frameAt(14) + 8, frameAt(14) + 16));
    const r = outcomeOf(copy.file);
    assert.equal(r.rows, 5, 'the last transaction is not visible');
    assert.equal(r.snapshot.wal.damagedFrames, 1);
    assert.equal(r.snapshot.wal.verifiedStaleFrames, 0, 'it is NOT classified as an older generation');
    assert.match(tail(r).description, /1 damaged frame\(s\) that belong to the current WAL generation/);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('a trailing frame with CORRUPTED salts is damaged, never stale (one byte, or fully random salts)', () => {
    for (const kind of ['one byte', 'random']) {
      scenario((dir, track) => {
        const { copy } = base(dir, track);
        mutate(copy.wal, (b) => { if (kind === 'one byte') b[frameAt(14) + 11] ^= 0x5a; else crypto.randomBytes(8).copy(b, frameAt(14) + 8); });
        const r = outcomeOf(copy.file);
        assert.equal(r.rows, 5, kind);
        assert.equal(r.snapshot.wal.damagedFrames, 1, kind);
        assert.equal(r.snapshot.wal.verifiedStaleFrames, 0, kind);
        assert.equal(r.summary.outcome, 'needs_review', kind);
      });
    }
  });

  test('both frames of the last transaction with damaged salts are both reported (the damaged chain is followed)', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    mutate(copy.wal, (b) => { b.fill(0, frameAt(13) + 8, frameAt(13) + 16); b.fill(0, frameAt(14) + 8, frameAt(14) + 16); });
    const r = outcomeOf(copy.file);
    assert.equal(r.snapshot.wal.damagedFrames, 2);
    assert.equal(r.rows, 5);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('an invalid checksum chain: a corrupted checksum field in the last frame is damaged', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    mutate(copy.wal, (b) => { b[frameAt(14) + 17] ^= 0xff; });
    const r = outcomeOf(copy.file);
    assert.equal(r.snapshot.wal.damagedFrames, 1);
    assert.equal(r.rows, 5);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('an invalid chain inside an older-generation tail is NOT trusted: the broken frames are unverified and the result is needs_review', () => {
    for (const kind of ['checksum field', 'page data']) {
      scenario((dir, track) => {
        const { copy } = restarted(dir, track);
        mutate(copy.wal, (b) => { if (kind === 'checksum field') b[frameAt(8) + 18] ^= 0xff; else b[frameAt(8) + 24 + 100] ^= 0xff; });
        const r = outcomeOf(copy.file);
        assert.equal(r.rows, 7, `${kind}: committed rows are intact`);
        assert.ok(r.snapshot.wal.unverifiedTrailingFrames >= 1, kind);
        assert.ok(r.snapshot.wal.verifiedStaleFrames < 13, kind);
        assert.match(tail(r).description, /could not be verified as intact leftovers of an older WAL generation/, kind);
        assert.equal(r.summary.outcome, 'needs_review', kind);
      });
    }
  });

  test('CRITICAL REGRESSION: zero-filling the last two frames cannot silently discard a committed row and return clear', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    assert.equal(frameCount(copy.wal), 15);
    mutate(copy.wal, (b) => b.fill(0, frameAt(13), frameAt(15)));
    const r = outcomeOf(copy.file);
    assert.equal(r.rows, 5, 'the committed sixth row is gone from the snapshot');
    assert.equal(r.snapshot.wal.unverifiedTrailingFrames, 2, 'zero-filled frames are not "stale"');
    assert.equal(r.snapshot.wal.verifiedStaleFrames, 0);
    const finding = tail(r);
    assert.deepEqual([finding.severity, finding.status], ['warning', 'found']);
    assert.match(finding.description, /2 trailing frame\(s\) that could not be verified/);
    assert.notEqual(r.summary.outcome, 'clear');
    assert.equal(r.summary.outcome, 'needs_review');
    assert.ok(r.summary.warnings.some((x) => x.id === 'snapshot:wal-tail-ignored'));
  }));

  test('zero-filled tails of any length, and random garbage frames, are unverified', () => {
    for (const [label, fill] of [['last 1 frame', (b) => b.fill(0, frameAt(14), frameAt(15))], ['last 3 frames', (b) => b.fill(0, frameAt(12), frameAt(15))],
      ['random garbage in the last 2 frames', (b) => crypto.randomBytes(2 * FRAME).copy(b, frameAt(13))]]) {
      scenario((dir, track) => {
        const { copy } = base(dir, track);
        mutate(copy.wal, fill);
        const r = outcomeOf(copy.file);
        assert.ok(r.snapshot.wal.unverifiedTrailingFrames + r.snapshot.wal.damagedFrames >= 1, label);
        assert.equal(r.snapshot.wal.verifiedStaleFrames, 0, label);
        assert.equal(r.summary.outcome, 'needs_review', label);
      });
    }
  });

  test('conservative: an isolated leftover frame with no chain to check cannot be verified, so it is reported', () => scenario((dir, track) => {
    const { copy } = restarted(dir, track);
    fs.truncateSync(copy.wal, frameAt(3)); // new generation (2 frames) + exactly ONE old-generation frame
    const r = outcomeOf(copy.file);
    assert.equal(r.snapshot.wal.verifiedStaleFrames, 0);
    assert.equal(r.snapshot.wal.unverifiedTrailingFrames, 1);
    assert.equal(r.rows, 7);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('a WAL truncated PARTWAY through a frame is reported', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    fs.truncateSync(copy.wal, frameAt(14) + 1000);
    const r = outcomeOf(copy.file);
    assert.equal(r.snapshot.wal.partialTailBytes, 1000);
    assert.equal(r.rows, 5);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('KNOWN LIMITATION: a WAL cut exactly at a frame boundary is indistinguishable from a legitimately shorter WAL and is NOT detected', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    fs.truncateSync(copy.wal, frameAt(13)); // drops the whole last transaction at a boundary
    const r = outcomeOf(copy.file);
    assert.equal(r.rows, 5, 'a committed row is missing');
    assert.deepEqual([r.snapshot.wal.damagedFrames, r.snapshot.wal.unverifiedTrailingFrames, r.snapshot.wal.partialTailBytes, r.snapshot.wal.uncommittedValidFrames], [0, 0, 0, 0]);
    assert.equal(r.summary.outcome, 'clear', 'the format carries no evidence of the missing frames; only the operator can notice (see the README checklist)');
    const readme = fs.readFileSync(path.join(repoRoot, 'db', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(readme, /cut exactly at a frame boundary/);
    assert.match(readme, /may be undetectable/);
  }));

  test('a trailing frame is never called stale on the strength of different salts alone', () => scenario((dir, track) => {
    // 13 leftover frames with intact chains are verified; the same frames with every salt byte zeroed are not
    const { copy } = restarted(dir, track);
    mutate(copy.wal, (b) => { for (let i = 2; i < 15; i += 1) b.fill(0, frameAt(i) + 8, frameAt(i) + 16); });
    const r = outcomeOf(copy.file);
    assert.equal(r.snapshot.wal.verifiedStaleFrames, 0);
    assert.ok(r.snapshot.wal.unverifiedTrailingFrames + r.snapshot.wal.damagedFrames >= 13);
    assert.equal(r.summary.outcome, 'needs_review');
  }));

  test('the README explains when an older-generation frame counts as verified, and that uncertain tails give needs_review', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'db', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(readme, /verifiably intact leftover of an older WAL generation/);
    assert.match(readme, /non-zero page number and non-zero salts and its checksum chains from the previous trailing frame/);
    assert.match(readme, /zero-filled, corrupted or unchained trailing frames.*needs_review/i);
    assert.match(readme, /WAL checksums do not prove which database a WAL belongs to/);
    assert.doesNotMatch(readme, /older WAL generation after the valid chain are normal and not reported as a warning/);
  });
});

describe('hardening around the write probe and the test seams', () => {
  const cantOpen = Object.assign(new Error('unable to open database file'), { errcode: 14 });

  test('the write probe requires query_only to be really OFF before it writes: a writable connection that ignores OFF is refused', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    const sneaky = (p) => {
      if (!fs.existsSync(p)) throw cantOpen;
      const real = new DatabaseSync(p); // WRITABLE
      const exec = real.exec.bind(real);
      real.exec = (sql) => (/query_only = OFF/.test(sql) ? undefined : exec(sql)); // pretends to switch it off
      return real;
    };
    assert.throws(() => verifySnapshotOpenerForTests(live.file, sneaky), /query_only could not be switched off, so the write probe would not test the connection itself/);
  }));

  test('the test seams refuse to run outside a test process', () => {
    const entry = pathToFileURL(path.join(repoRoot, 'server', 'db', 'preflight.js')).href;
    const script = `import * as m from ${JSON.stringify(entry)};
      const out = {};
      for (const [name, call] of Object.entries({
        remover: () => m.setSnapshotRemoverForTests(() => {}),
        snapshot: () => m.verifySnapshotOpenerForTests('/nonexistent', () => {}),
        opener: () => m.verifyReadOnlyOpenerForTests('/nonexistent', () => {})
      })) { try { call(); out[name] = 'ALLOWED'; } catch (e) { out[name] = e.message; } }
      console.log(JSON.stringify(out));`;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    for (const [name, message] of Object.entries(out)) assert.match(message, /is a test seam and may only be called from a test process/, name);
  });

  test('inside the test process the seams work (they are only gated, not removed)', () => scenario((dir, track) => {
    const live = liveWal(dir, track, CLEAN);
    assert.equal(verifySnapshotOpenerForTests(live.file, (p, o) => new DatabaseSync(p, o)), true);
  }));
});

// ---------------------------------------------------------------------------------------------
// Accepted limits of the trailing-frame classification (D1, D2, L1) and multiple older generations.
// These tests pin what the code ACTUALLY does. They are not guarantees: where the outcome is `clear` although a
// committed row is missing, that is the documented limitation, not a success.
// ---------------------------------------------------------------------------------------------
describe('WAL trailing frames: accepted limits (D1, D2, L1) and multiple older generations', () => {
  const FRAME = 24 + 4096;
  const at = (i) => 32 + i * FRAME;
  const mutate = (file, fn) => { const b = fs.readFileSync(file); fn(b); fs.writeFileSync(file, b); };
  const tail = (r) => r.results.find((x) => x.id === 'snapshot:wal-tail-ignored');
  const wal = (r) => r.snapshot.wal;
  // 6 autocommit inserts = 15 frames; the last transaction is frames 13 and 14
  const base = (dir, track) => { const live = liveWal(dir, track, CLEAN); return { live, copy: quiescentCopy(dir, live) }; };
  const restarted = (dir, track) => {
    const live = liveWal(dir, track, (w) => { CLEAN(w); w.exec('PRAGMA wal_checkpoint(RESTART)'); w.exec("INSERT INTO a VALUES ('after', 1)"); });
    return { live, copy: quiescentCopy(dir, live, 'restarted') };
  };
  const saltsOf = (walFile, from, to) => { const b = fs.readFileSync(walFile); const out = []; for (let i = from; i < to; i += 1) out.push(`${b.readUInt32BE(at(i) + 8)}:${b.readUInt32BE(at(i) + 12)}`); return out; };

  test('multiple older WAL generations: every run of leftovers is verified, nothing is reported, committed rows are all present', () => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => {
      CLEAN(w); // generation A: 15 frames
      w.exec('PRAGMA wal_checkpoint(RESTART)');
      for (let i = 0; i < 3; i += 1) w.exec(`INSERT INTO a VALUES ('b${i}', 1)`); // generation B: 6 frames
      w.exec('PRAGMA wal_checkpoint(RESTART)');
      w.exec("INSERT INTO a VALUES ('c', 1)"); // generation C (current): 2 frames
    });
    const copy = quiescentCopy(dir, live);
    const header = fs.readFileSync(copy.wal);
    const current = `${header.readUInt32BE(16)}:${header.readUInt32BE(20)}`;
    const trailing = saltsOf(copy.wal, 2, 15);
    const generations = new Set(trailing);
    assert.equal(generations.size, 2, 'precondition: the trailing frames belong to TWO older generations');
    assert.equal(generations.has(current), false, 'and neither is the current one');
    const r = inspect(copy.file);
    assert.equal(r.rows, 10);
    assert.equal(wal(r).validFrames, 2);
    assert.equal(wal(r).verifiedStaleFrames, 13);
    assert.deepEqual([wal(r).damagedFrames, wal(r).unverifiedTrailingFrames], [0, 0]);
    assert.equal(r.results.some((x) => x.id === 'snapshot:wal-tail-ignored'), false);
    assert.equal(r.summary.outcome, 'clear');
  }));

  test('D2: corrupting the page data of the FIRST frame of an older run is NOT detected; the frame counts as verified because of the chain linkage, not its contents', () => scenario((dir, track) => {
    const { live, copy } = restarted(dir, track);
    const pristine = fs.readFileSync(`${live.file}-wal`).subarray(at(2) + 24, at(3));
    mutate(copy.wal, (b) => { b[at(2) + 24 + 100] ^= 0xff; });
    const corrupted = fs.readFileSync(copy.wal).subarray(at(2) + 24, at(3));
    assert.notDeepEqual(corrupted, pristine, 'precondition: that frame\'s page data really differs from the source');
    const r = inspect(copy.file);
    assert.equal(r.rows, 7, 'committed data is unaffected: SQLite ignores these frames');
    assert.equal(wal(r).verifiedStaleFrames, 13, 'classified verified: its stored checksum still links to the next frame; its own contents are NOT independently verified');
    assert.deepEqual([wal(r).damagedFrames, wal(r).unverifiedTrailingFrames], [0, 0]);
    assert.equal(r.summary.outcome, 'clear');
  }));

  test('D2 contrast: the same corruption in a LATER frame of the run, or in the first frame\'s stored checksum, IS reported', () => {
    for (const [label, hit] of [['page data of a middle frame', (b) => { b[at(8) + 24 + 100] ^= 0xff; }], ['stored checksum of the first old frame', (b) => { b[at(2) + 18] ^= 0xff; }]]) {
      scenario((dir, track) => {
        const { copy } = restarted(dir, track);
        mutate(copy.wal, hit);
        const r = inspect(copy.file);
        assert.ok(wal(r).unverifiedTrailingFrames >= 1, label);
        assert.match(tail(r).description, /could not be verified as intact leftovers/, label);
        assert.equal(r.summary.outcome, 'needs_review', label);
      });
    }
  });

  test('D1 (accepted limitation): two trailing frames with identical constructed non-zero salts and a consistent chain, the first with corrupted page data, are accepted as an older generation, so a committed row is missing and the outcome is clear', () => scenario((dir, track) => {
    const { copy } = base(dir, track);
    const header = fs.readFileSync(copy.wal);
    const constructed = Buffer.alloc(8); constructed.writeUInt32BE(0xdeadbeef, 0); constructed.writeUInt32BE(0x12345678, 4);
    assert.notDeepEqual(header.subarray(16, 24), constructed, 'precondition: the salts differ from the current generation');
    mutate(copy.wal, (b) => { constructed.copy(b, at(13) + 8); constructed.copy(b, at(14) + 8); b[at(13) + 24 + 50] ^= 0xff; });
    const r = inspect(copy.file);
    // What is actually established: frame 14's checksum chains from frame 13's stored checksum, and the salts are
    // equal and non-zero. That is all the format allows the tool to see. It is NOT proof that this is an older generation.
    assert.equal(wal(r).verifiedStaleFrames, 2);
    assert.deepEqual([wal(r).damagedFrames, wal(r).unverifiedTrailingFrames, wal(r).partialTailBytes, wal(r).uncommittedValidFrames], [0, 0, 0, 0]);
    assert.equal(r.rows, 5, 'the sixth committed row is not in the snapshot');
    assert.equal(r.summary.outcome, 'clear', 'KNOWN LIMITATION D1: the tool cannot tell this from genuine leftovers');
    assert.equal(r.results.some((x) => x.id === 'snapshot:wal-tail-ignored'), false);
  }));

  test('D1 boundaries: the same constructed salts are reported when the frames still chain from the valid chain, when the salts are not identical, or when the second frame does not chain', () => {
    const constructed = Buffer.alloc(8); constructed.writeUInt32BE(0xdeadbeef, 0); constructed.writeUInt32BE(0x12345678, 4);
    const other = Buffer.alloc(8); other.writeUInt32BE(0xcafebabe, 0); other.writeUInt32BE(0x0badf00d, 4);
    const cases = [
      ['salts changed, page data intact (the frames chain from the valid chain, so they are damaged current-generation data)', (b) => { constructed.copy(b, at(13) + 8); constructed.copy(b, at(14) + 8); }, { damaged: 2 }],
      ['first frame corrupted, salts NOT identical', (b) => { constructed.copy(b, at(13) + 8); other.copy(b, at(14) + 8); b[at(13) + 24 + 50] ^= 0xff; }, { unverified: 2 }],
      ['identical salts but the second frame\'s checksum is broken', (b) => { constructed.copy(b, at(13) + 8); constructed.copy(b, at(14) + 8); b[at(13) + 24 + 50] ^= 0xff; b[at(14) + 18] ^= 0xff; }, { unverified: 2 }]
    ];
    for (const [label, hit, expect] of cases) {
      scenario((dir, track) => {
        const { copy } = base(dir, track);
        mutate(copy.wal, hit);
        const r = inspect(copy.file);
        assert.equal(wal(r).verifiedStaleFrames, 0, label);
        if (expect.damaged) assert.equal(wal(r).damagedFrames, expect.damaged, label);
        if (expect.unverified) assert.equal(wal(r).unverifiedTrailingFrames, expect.unverified, label);
        assert.equal(r.summary.outcome, 'needs_review', label);
      });
    }
  });

  test('L1 (accepted limitation): newer committed frames reverted to the OLDER frame contents that used to be there form a valid-looking stale chain; the row is lost and the outcome is clear', () => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => { CLEAN(w); w.exec('PRAGMA wal_checkpoint(RESTART)'); w.exec("INSERT INTO a VALUES ('n1', 1)"); });
    const older = quiescentCopy(dir, live, 'older'); // new generation: n1 (2 frames), older generation behind it
    live.writer.exec("INSERT INTO a VALUES ('n2', 1)"); // overwrites the older frames 2 and 3 with a NEW committed transaction
    const newer = quiescentCopy(dir, live, 'newer');

    const control = inspect(newer.file);
    assert.equal(control.rows, 8, 'control: with n2 intact all committed rows are present');
    assert.equal(wal(control).validFrames, 4);
    assert.equal(control.summary.outcome, 'clear');

    // Write the older contents back over the newer frames 2 and 3 (what stale blocks returning would do).
    const oldBytes = fs.readFileSync(older.wal);
    mutate(newer.wal, (b) => oldBytes.copy(b, at(2), at(2), at(4)));
    const r = inspect(newer.file);
    assert.equal(r.rows, 7, 'the committed n2 row is gone');
    assert.equal(wal(r).validFrames, 2);
    assert.equal(wal(r).verifiedStaleFrames, 13, 'the restored frames chain exactly like genuine leftovers');
    assert.deepEqual([wal(r).damagedFrames, wal(r).unverifiedTrailingFrames], [0, 0]);
    assert.equal(r.summary.outcome, 'clear', 'KNOWN LIMITATION L1: indistinguishable from a legitimately shorter log');
  }));

  test('the README documents D1, D2, L1, the non-cryptographic checksum, and that no salt ordering is assumed', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'db', 'README.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(readme, /WAL checksums are non-cryptographic: they can detect accidental corruption but do not authenticate frames, salts, or database identity\./);
    assert.match(readme, /D1, identical constructed salts/);
    assert.match(readme, /identical non-zero salts and a consistent checksum chain are accepted as an older generation/);
    assert.match(readme, /does not assume that WAL salts are sequential generation counters/);
    assert.match(readme, /D2, the first frame of an older run/);
    assert.match(readme, /Its own page data is not independently verified/);
    assert.match(readme, /L1, older contents restored over newer frames/);
    assert.match(readme, /a committed transaction can be missing while the outcome is `clear`/);
    assert.match(readme, /cut exactly at a frame boundary may be undetectable.*older frame contents restored over newer committed frames, limitation L1/);
    assert.match(readme, /WAL checksums do not prove which database a WAL belongs to/);
  });

  test('the classification does not assume sequential salts: the source contains no salt arithmetic', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'server', 'db', 'snapshot.js'), 'utf8');
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /salt1\s*[-+]|[-+]\s*salt1|salt2\s*[-+]|[-+]\s*salt2|salts\[0\]\s*[-+]/);
  });
});
