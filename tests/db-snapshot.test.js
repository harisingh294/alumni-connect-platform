// Tests for WAL-safe snapshots (server/db/snapshot.js and openSnapshotForPreflight in server/db/preflight.js),
// the follow-up to the independent audit of M3.
//
// The application runs SQLite in WAL mode, so committed data can sit in the -wal file. Every fixture here is a
// disposable database in a fresh temporary directory, created and deleted by this test. No real database, backup,
// PostgreSQL or Neon is touched. Live-writer scenarios keep a writable connection OPEN on a fixture while the
// snapshot is taken, which is exactly the state in which committed rows exist only in the -wal.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyzeWal, parseMainHeader, SnapshotError, takeSnapshot } from '../server/db/snapshot.js';
import { isPreflightReadOnlyHandle, openReadOnlyForPreflight, openSnapshotForPreflight, PreflightReadOnlyError, runPreflight, summarizePreflight } from '../server/db/preflight.js';

// Test files run in parallel processes and several of these tests list the temp directory to prove that nothing
// is left behind. Give this process a private temp directory so other files cannot interfere. os.tmpdir() reads
// the environment on every call: TMPDIR on POSIX, TEMP/TMP on Windows, so all three are set. It is removed when
// the process exits.
const PRIVATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-tests-'));
for (const key of ['TMPDIR', 'TEMP', 'TMP']) process.env[key] = PRIVATE_TMP;
if (os.tmpdir() !== PRIVATE_TMP) throw new Error(`private temp directory was not applied: os.tmpdir() is ${os.tmpdir()}`);
process.on('exit', () => { try { fs.rmSync(PRIVATE_TMP, { recursive: true, force: true }); } catch { /* ignore */ } });
const tmpSnapshots = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('preflight-snapshot-') || n.startsWith('preflight-canary-')).sort();

// Runs fn(dir) in a fresh temporary directory; open writers registered with track() are closed first.
function scenario(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-test-'));
  const open = [];
  const track = (db) => { open.push(db); return db; };
  try { return fn(dir, track); } finally {
    for (const db of open) { try { db.close(); } catch { /* already closed */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A WAL-mode database with a LIVE writer: autocheckpoint is off and the connection stays open, so every commit
// stays in the -wal. Returns { src, file, writer }.
function liveWal(dir, track, setup, { name = 'app.db' } = {}) {
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  const file = path.join(src, name);
  const writer = track(new DatabaseSync(file));
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
  setup(writer);
  return { src, file, writer };
}

const SCHEMA = "CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER); INSERT INTO a VALUES ('x', 1); INSERT INTO a VALUES ('y', 2);";
const stateOf = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => {
  const p = path.join(dir, n);
  const st = fs.statSync(p, { bigint: true });
  return [n, { size: st.size, mtimeNs: st.mtimeNs, ino: st.ino, sha: n.endsWith('-shm') ? null : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }];
}));
const count = (db, sql = 'SELECT COUNT(*) AS c FROM a') => Number(db.prepare(sql).get().c);
const withSnapshotDir = (fn) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-dest-')); try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); } };
// A quiescent copy of a live fixture's main + wal (the writer is open but idle) for corruption experiments.
function frozenCopy(dir, live, name = 'frozen') {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(live.file, path.join(d, 'app.db'));
  fs.copyFileSync(`${live.file}-wal`, path.join(d, 'app.db-wal'));
  return { dir: d, file: path.join(d, 'app.db'), wal: path.join(d, 'app.db-wal') };
}
const flipByte = (file, offset) => { const b = fs.readFileSync(file); b[offset] ^= 0xff; fs.writeFileSync(file, b); };

describe('committed WAL data is part of the inspected snapshot', () => {
  test('rows that exist ONLY in the -wal are inspected; copying just the main file would miss them', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(`${SCHEMA} INSERT INTO a VALUES (NULL, 3)`)); // a NULL TEXT primary key, committed in the WAL only
      assert.ok(fs.statSync(`${live.file}-wal`).size > 0, 'precondition: the data is in the WAL');
      assert.ok(fs.existsSync(`${live.file}-shm`));

      // The hazard: a main-file-only copy does not even contain the table.
      const naive = path.join(dir, 'naive.db');
      fs.copyFileSync(live.file, naive);
      const naiveDb = new DatabaseSync(naive, { readOnly: true });
      assert.throws(() => count(naiveDb), /no such table: a/);
      naiveDb.close();
      // Evidence for why the ORIGINAL is never opened with SQLite: even a read-only open of a WAL-mode database
      // creates -wal/-shm files next to it.
      assert.ok(fs.existsSync(`${naive}-shm`) || fs.existsSync(`${naive}-wal`), 'a read-only SQLite open of a WAL database leaves sidecar files behind');
      for (const suffix of ['-wal', '-shm']) fs.rmSync(naive + suffix, { force: true });
      assert.throws(() => openReadOnlyForPreflight(naive), /WAL mode/, 'and the plain opener refuses such a file');

      const handle = openSnapshotForPreflight(live.file);
      try {
        assert.equal(isPreflightReadOnlyHandle(handle), true);
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 3, 'all three committed rows are visible');
        assert.ok(handle.snapshot.wal.committedFrames > 0);
        assert.equal(handle.snapshot.walPresent, true);
        assert.equal(handle.snapshot.assumedCleanShutdown, false);
        assert.ok(handle.snapshot.expectedPageCount >= 2, 'the page count implied by the last commit record was verified against SQLite when the snapshot was opened');
        const results = runPreflight(handle);
        assert.equal(results.find((r) => r.id === 'a.id:pk-null').bad, 1, 'the problem row that lives only in the WAL is found');
        assert.equal(summarizePreflight(results).outcome, 'blocked');
      } finally { handle.close(); }
    });
  });

  test('data split between the main file (checkpointed) and the WAL (later commits) is all present', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => { w.exec(SCHEMA); w.exec('PRAGMA wal_checkpoint(TRUNCATE)'); w.exec("INSERT INTO a VALUES ('z', 3)"); w.exec("UPDATE a SET n = 99 WHERE id = 'x'"); w.exec("DELETE FROM a WHERE id = 'y'"); });
      const naive = path.join(dir, 'naive.db');
      fs.copyFileSync(live.file, naive);
      const naiveDb = new DatabaseSync(naive, { readOnly: true });
      assert.equal(count(naiveDb), 2, 'main alone: the two checkpointed rows, with the old values');
      assert.equal(count(naiveDb, "SELECT n AS c FROM a WHERE id = 'x'"), 1);
      naiveDb.close();
      const handle = openSnapshotForPreflight(live.file);
      try {
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 2);
        assert.deepEqual(handle.prepare('SELECT id, n FROM "a" ORDER BY id').all().map((r) => ({ ...r })), [{ id: 'x', n: 99 }, { id: 'z', n: 3 }], 'update, delete and insert from the WAL are applied');
      } finally { handle.close(); }
    });
  });

  test('a large transaction that spans many WAL frames is applied completely', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => {
        w.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body TEXT)');
        w.exec('BEGIN');
        const ins = w.prepare('INSERT INTO big (body) VALUES (?)');
        for (let i = 0; i < 3000; i += 1) ins.run('x'.repeat(200));
        w.exec('COMMIT');
      });
      const handle = openSnapshotForPreflight(live.file);
      try {
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "big"'), 3000);
        assert.ok(handle.snapshot.wal.completeFrames > 100);
        assert.equal(handle.snapshot.wal.validFrames, handle.snapshot.wal.completeFrames, 'the validator agrees with SQLite on every frame');
        assert.equal(handle.snapshot.wal.uncommittedValidFrames, 0);
      } finally { handle.close(); }
    });
  });
});

describe('the original files are never touched', () => {
  test('main, -wal and -shm are byte-identical, no file appears in the source directory, and the live writer keeps working', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      const before = stateOf(live.src);
      assert.deepEqual(Object.keys(before), ['app.db', 'app.db-shm', 'app.db-wal']);
      const handle = openSnapshotForPreflight(live.file);
      runPreflight(handle);
      assert.throws(() => handle.prepare("INSERT INTO a VALUES ('q', 1)"), PreflightReadOnlyError);
      handle.close();
      const after = stateOf(live.src);
      assert.deepEqual(Object.keys(after), Object.keys(before), 'no new file, none removed');
      for (const name of ['app.db', 'app.db-wal']) assert.deepEqual(after[name], before[name], `${name} unchanged (size, mtime, inode, sha256)`);
      assert.equal(after['app.db-shm'].size, before['app.db-shm'].size);
      // the writer is undisturbed: it can still commit, and the WAL grows normally
      live.writer.exec("INSERT INTO a VALUES ('later', 9)");
      assert.ok(fs.statSync(`${live.file}-wal`).size > Number(before['app.db-wal'].size));
    });
  });

  test('the snapshot directory is private and is deleted on close and on failure', () => {
    const before = tmpSnapshots();
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      const handle = openSnapshotForPreflight(live.file);
      assert.equal(tmpSnapshots().length, before.length + 1, 'one snapshot directory while open');
      handle.close();
      assert.deepEqual(tmpSnapshots(), before, 'removed on close');
      flipByte(live.file, 0); // not a SQLite file any more
      assert.throws(() => openSnapshotForPreflight(live.file), SnapshotError);
      assert.deepEqual(tmpSnapshots(), before, 'removed when the snapshot is refused');
    });
  });

  test('the source is never opened with SQLite: a database held under an EXCLUSIVE lock by another connection is still snapshotted from files', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      live.writer.exec('BEGIN EXCLUSIVE'); // an uncommitted transaction is open on the source
      live.writer.exec("INSERT INTO a VALUES ('uncommitted', 0)");
      const handle = openSnapshotForPreflight(live.file);
      try {
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 2, 'uncommitted rows are never part of the snapshot');
      } finally { handle.close(); live.writer.exec('ROLLBACK'); }
    });
  });
});

describe('source states that must be refused or attested', () => {
  test('a cleanly closed WAL database (main file only) needs an explicit confirmation', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      live.writer.close(); // clean shutdown: SQLite checkpoints and deletes -wal and -shm
      assert.deepEqual(fs.readdirSync(live.src), ['app.db']);
      assert.throws(() => openSnapshotForPreflight(live.file), /WAL mode but there is no -wal file/);
      const handle = openSnapshotForPreflight(live.file, { cleanShutdownConfirmed: true });
      try {
        assert.equal(handle.snapshot.assumedCleanShutdown, true);
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 2);
      } finally { handle.close(); }
    });
  });

  test('a zero-length -wal (after a TRUNCATE checkpoint) needs no confirmation: the main file is complete', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => { w.exec(SCHEMA); w.exec('PRAGMA wal_checkpoint(TRUNCATE)'); });
      assert.equal(fs.statSync(`${live.file}-wal`).size, 0);
      const handle = openSnapshotForPreflight(live.file);
      try {
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 2);
        assert.equal(handle.snapshot.walBytes, 0);
        assert.equal(handle.snapshot.assumedCleanShutdown, false);
      } finally { handle.close(); }
    });
  });

  test('a -shm without a -wal, a non-empty rollback journal, and sidecars on a non-WAL database are inconsistent', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      live.writer.close();
      fs.writeFileSync(`${live.file}-shm`, Buffer.alloc(32768));
      assert.throws(() => openSnapshotForPreflight(live.file, { cleanShutdownConfirmed: true }), /-shm file exists without a -wal/);
      fs.rmSync(`${live.file}-shm`);
      fs.writeFileSync(`${live.file}-journal`, 'hot');
      assert.throws(() => openSnapshotForPreflight(live.file, { cleanShutdownConfirmed: true }), /non-empty rollback journal/);
      fs.writeFileSync(`${live.file}-journal`, '');
      const handle = openSnapshotForPreflight(live.file, { cleanShutdownConfirmed: true });
      handle.close();
      fs.rmSync(`${live.file}-journal`);

      const rb = path.join(dir, 'rollback.db');
      const w = new DatabaseSync(rb); w.exec(SCHEMA); w.close();
      const ok = openSnapshotForPreflight(rb);
      assert.equal(ok.snapshot.journalMode, 'rollback');
      ok.close();
      fs.writeFileSync(`${rb}-wal`, '');
      assert.throws(() => openSnapshotForPreflight(rb), /not in WAL mode but has -wal or -shm/);
    });
  });

  test('sidecars that are directories or symbolic links, and unusable main files, are refused', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      const copy = frozenCopy(dir, live);
      fs.rmSync(copy.wal);
      fs.mkdirSync(copy.wal);
      assert.throws(() => openSnapshotForPreflight(copy.file), /-wal file is not a regular file/);
      fs.rmSync(copy.wal, { recursive: true });
      let symlinkCreated = false;
      try {
        fs.symlinkSync(`${live.file}-wal`, copy.wal);
        symlinkCreated = true;
      } catch (error) {
        const windowsPermissionLimitation = process.platform === 'win32'
          && ['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error.code);
        if (!windowsPermissionLimitation) throw error;
      }
      if (symlinkCreated) {
        assert.throws(() => openSnapshotForPreflight(copy.file), /symbolic link/);
        fs.rmSync(copy.wal);
      }

      const junk = path.join(dir, 'junk.db');
      fs.writeFileSync(junk, 'x'.repeat(8192));
      assert.throws(() => openSnapshotForPreflight(junk), /not a SQLite database/);
      assert.throws(() => openSnapshotForPreflight(path.join(dir, 'missing.db')), /does not exist/);
      assert.throws(() => openSnapshotForPreflight(`${live.file}-wal`), /pass the main database file/);
      assert.throws(() => openSnapshotForPreflight(':memory:'), SnapshotError);
      assert.throws(() => openSnapshotForPreflight(dir), /not a regular file/);
      const truncated = path.join(dir, 'truncated.db');
      fs.writeFileSync(truncated, Buffer.concat([fs.readFileSync(live.file), Buffer.alloc(100)]));
      assert.throws(() => openSnapshotForPreflight(truncated, { cleanShutdownConfirmed: true }), /not a multiple of its page size/);
    });
  });

  test('an unreadable -wal is reported, not skipped (skipped when running as root, which ignores file modes)', { skip: process.platform === 'win32' ? 'Windows does not enforce POSIX chmod file-read permissions' : process.getuid?.() === 0 ? 'running as root: file permissions are not enforced' : false }, () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      const copy = frozenCopy(dir, live);
      fs.chmodSync(copy.wal, 0o000);
      try { assert.throws(() => openSnapshotForPreflight(copy.file), /cannot read the -wal file/); } finally { fs.chmodSync(copy.wal, 0o600); }
    });
  });

  test('the snapshot directory may not be inside the source directory or non-empty', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      const inside = path.join(live.src, 'snap');
      fs.mkdirSync(inside);
      assert.throws(() => takeSnapshot(live.file, inside), /must not be inside the source directory/);
      assert.throws(() => takeSnapshot(live.file, live.src), /must not be inside the source directory/);
      fs.rmSync(inside, { recursive: true });
      withSnapshotDir((d) => {
        fs.writeFileSync(path.join(d, 'x'), '');
        assert.throws(() => takeSnapshot(live.file, d), /must be empty/);
      });
    });
  });
});

describe('a source that changes while it is copied is refused', () => {
  const changeDuringCopy = (mutate, expected) => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
    withSnapshotDir((d) => {
      assert.throws(() => takeSnapshot(live.file, d, { testHooks: { onAfterFirstPass: () => mutate(live) } }), expected);
    });
  });

  test('a commit that lands after the copy (the WAL grows)', () => changeDuringCopy((l) => l.writer.exec("INSERT INTO a VALUES ('race', 1)"), /source changed while it was being copied \(.*wal/));
  test('a checkpoint that rewrites the main file', () => changeDuringCopy((l) => l.writer.exec('PRAGMA wal_checkpoint(TRUNCATE)'), /source changed while it was being copied/));
  test('a WAL that disappears (the last connection closed cleanly)', () => changeDuringCopy((l) => l.writer.close(), /source changed while it was being copied/));
  test('a content change that keeps size and timestamps (same-granularity write) is caught by the hash', () => changeDuringCopy((l) => {
    const file = `${l.file}-wal`;
    const st = fs.statSync(file);
    const b = fs.readFileSync(file); b[100] ^= 0x01;
    fs.writeFileSync(file, b);
    fs.utimesSync(file, st.atime, st.mtime); // restore the timestamps; ctime still moves, and the hash differs
  }, /source changed while it was being copied \(.*wal/));
  test('a timestamp-only change is also refused (it cannot be told apart from a write)', () => changeDuringCopy((l) => { const t = new Date(); fs.utimesSync(l.file, t, new Date(t.getTime() + 5000)); }, /source changed while it was being copied \(main\)/));

  test('an undisturbed source produces a snapshot whose hashes equal the source', () => {
    scenario((dir, track) => {
      const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
      withSnapshotDir((d) => {
        const info = takeSnapshot(live.file, d);
        assert.equal(info.mainSha256, crypto.createHash('sha256').update(fs.readFileSync(live.file)).digest('hex'));
        assert.equal(info.walSha256, crypto.createHash('sha256').update(fs.readFileSync(`${live.file}-wal`)).digest('hex'));
        assert.deepEqual(fs.readdirSync(d).sort(), ['snapshot.db', 'snapshot.db-wal'], 'the -shm is deliberately not copied');
      });
    });
  });
});

describe('damaged or inconsistent WAL files are refused', () => {
  const fixture = (fn) => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => { w.exec('CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER)'); for (let i = 0; i < 6; i += 1) w.exec(`INSERT INTO a VALUES ('r${i}', ${i})`); });
    const copy = frozenCopy(dir, live);
    const walSize = fs.statSync(copy.wal).size;
    const frameSize = 24 + 4096;
    assert.equal((walSize - 32) % frameSize, 0, 'precondition: whole frames');
    return fn({ dir, live, copy, frames: (walSize - 32) / frameSize, frameSize });
  });

  test('wrong magic, a header shorter than 32 bytes, and a bad header checksum', () => fixture(({ copy }) => {
    const good = fs.readFileSync(copy.wal);
    fs.writeFileSync(copy.wal, good.subarray(0, 10));
    assert.throws(() => openSnapshotForPreflight(copy.file), /shorter than its 32-byte header/);
    const bad = Buffer.from(good); bad[0] ^= 0xff; fs.writeFileSync(copy.wal, bad);
    assert.throws(() => openSnapshotForPreflight(copy.file), /bad magic/);
    const salt = Buffer.from(good); salt[17] ^= 0xff; fs.writeFileSync(copy.wal, salt);
    assert.throws(() => openSnapshotForPreflight(copy.file), /header checksum is wrong/);
    fs.writeFileSync(copy.wal, good);
    const ok = openSnapshotForPreflight(copy.file); ok.close();
  }));

  test('a WAL whose page size differs from the database is refused', () => fixture(({ dir, copy }) => {
    const other = path.join(dir, 'p8192.db');
    const w = new DatabaseSync(other); w.exec('PRAGMA page_size = 8192; PRAGMA journal_mode = WAL; CREATE TABLE z (a)'); w.close();
    fs.copyFileSync(other, copy.file); // an 8192-byte-page main file with a 4096-byte-page WAL beside it
    assert.throws(() => openSnapshotForPreflight(copy.file), /page size .* differs/);
  }));

  test('a damaged frame in the MIDDLE, with later frames of the same WAL, is refused: SQLite would silently drop committed data', () => fixture(({ copy, frames, frameSize }) => {
    assert.ok(frames >= 4);
    flipByte(copy.wal, 32 + 1 * frameSize + 24 + 50); // page data of frame 2
    assert.throws(() => openSnapshotForPreflight(copy.file), /WAL frame 2 is invalid but frame \d+ of the same WAL generation follows/);
  }));

  test('a damaged FINAL frame is tolerated as a torn write: the last transaction is not part of the snapshot, and this is reported', () => fixture(({ copy, frames, frameSize }) => {
    flipByte(copy.wal, 32 + (frames - 1) * frameSize + 24 + 50);
    const handle = openSnapshotForPreflight(copy.file);
    try {
      assert.equal(handle.snapshot.wal.invalidFrames, 1);
      assert.equal(handle.snapshot.wal.validFrames, frames - 1);
      assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 5, 'six inserts were committed; the one in the torn frame is not visible');
    } finally { handle.close(); }
  }));

  test('a partial trailing frame is tolerated and reported', () => fixture(({ copy, frames }) => {
    const size = fs.statSync(copy.wal).size;
    fs.truncateSync(copy.wal, size - 100);
    const handle = openSnapshotForPreflight(copy.file);
    try {
      assert.equal(handle.snapshot.wal.partialTailBytes, 4120 - 100);
      assert.equal(handle.snapshot.wal.completeFrames, frames - 1);
      assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 5);
    } finally { handle.close(); }
  }));

  test('stale frames of an older WAL generation after the valid chain are not an error', () => fixture(({ dir, live }) => {
    // checkpoint (reset) then write less: the tail of the WAL file still holds frames with the previous salts
    const reset = liveWal(dir, (db) => live.writer && db, (w) => { w.exec('CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER)'); for (let i = 0; i < 6; i += 1) w.exec(`INSERT INTO a VALUES ('r${i}', ${i})`); w.exec('PRAGMA wal_checkpoint(RESTART)'); w.exec("INSERT INTO a VALUES ('after', 1)"); }, { name: 'restart.db' });
    try {
      const handle = openSnapshotForPreflight(reset.file);
      try {
        assert.equal(count(handle, 'SELECT COUNT(*) AS c FROM "a"'), 7);
        assert.ok(handle.snapshot.wal.completeFrames > handle.snapshot.wal.validFrames, 'old-generation frames are present and ignored');
        assert.equal(handle.snapshot.wal.verifiedStaleFrames, handle.snapshot.wal.completeFrames - handle.snapshot.wal.validFrames, 'and each of them is a verified leftover');
        assert.equal(handle.snapshot.wal.invalidFrames, handle.snapshot.wal.completeFrames - handle.snapshot.wal.validFrames);
      } finally { handle.close(); }
    } finally { reset.writer.close(); }
  }));

  test('a damaged main file is caught by the integrity check on the opened snapshot', () => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => { w.exec('CREATE TABLE a (id TEXT PRIMARY KEY, n INTEGER)'); const ins = w.prepare('INSERT INTO a VALUES (?, ?)'); for (let i = 0; i < 500; i += 1) ins.run(`row-${i}`, i); });
    live.writer.close();
    const file = live.file;
    const b = fs.readFileSync(file);
    for (let off = 3 * 4096 + 20; off < 3 * 4096 + 200; off += 1) b[off] = 0xa5; // scribble over a leaf page of the table
    fs.writeFileSync(file, b);
    assert.throws(() => openSnapshotForPreflight(file, { cleanShutdownConfirmed: true }), (e) => e instanceof PreflightReadOnlyError && /integrity_check|could not be verified/.test(e.message));
  }));
});

describe('the WAL validator agrees with SQLite', () => {
  test('parseMainHeader and analyzeWal on real files', () => scenario((dir, track) => {
    const live = liveWal(dir, track, (w) => w.exec(SCHEMA));
    const header = parseMainHeader(fs.readFileSync(live.file).subarray(0, 100));
    assert.equal(header.pageSize, 4096);
    assert.equal(header.journalMode, 'wal');
    assert.equal(header.headerPages, 1, 'the in-header page count is trusted when the change counter matches');
    const fd = fs.openSync(`${live.file}-wal`, 'r');
    try {
      const a = analyzeWal(fd, fs.statSync(`${live.file}-wal`).size, 4096);
      assert.equal(a.validFrames, a.completeFrames);
      assert.equal(a.invalidFrames, 0);
      assert.equal(a.partialTailBytes, 0);
      assert.ok(a.committedFrames > 0 && a.commitDbSizePages >= 2);
    } finally { fs.closeSync(fd); }
    assert.throws(() => parseMainHeader(Buffer.alloc(100)), SnapshotError);
    assert.throws(() => parseMainHeader(Buffer.from('SQLite format 3\0' + 'x'.repeat(84))), SnapshotError);
  }));
});
