// Consistent, read-only snapshots of a SQLite database for the migration preflight.
//
// Pure file-system code: this module never loads or opens SQLite, and it only READS the source files. It writes
// only into the destination directory the caller gives it (a fresh temporary directory).
//
// Why this exists. The application runs SQLite in WAL mode (server/db.js: PRAGMA journal_mode = WAL). In WAL mode
// committed data can live in the `-wal` file next to the database, not in the main file, until a checkpoint
// moves it. Copying only the main `.db` file can therefore silently lose committed rows. The complete state is
// "main file + valid -wal frames". `-shm` is only a shared-memory index that SQLite rebuilds from the WAL, so it
// is deliberately NOT copied.
//
// SOURCE STATE REQUIRED (see db/README.md): the application, and every other process that uses the database, is
// STOPPED. This module cannot lock the source (it never opens it with SQLite, so it cannot take SQLite locks), so
// it cannot prove nobody is writing. It makes a concurrent change detectable instead: the files are hashed while
// they are copied and hashed again afterwards in the opposite order, and their identity, size and timestamps are
// compared before and after. Any difference means the copy is not a single point in time and the snapshot is
// refused.
//
// PAIRING. SQLite does not record which database a WAL belongs to: the WAL header holds salts and a checksum that
// prove the WAL is internally consistent, NOT that it belongs to the main file beside it. A snapshot is only as
// good as the pairing of the two files. Never restore or replace a `.db` while leaving an older `-wal` next to it
// (the result is a plausible but wrong database that passes every check here), and never pair a database with a
// WAL from another database. See db/README.md.
//
// COPY VERIFICATION. Every byte that is written is verified: short writes are completed, and afterwards the copied
// main file and WAL are re-read from the destination and compared (size and SHA-256) with the source bytes that
// were copied. The main-file header and the WAL are then parsed from the COPIES, not from an earlier read of the
// source.
//
// The snapshot is also refused when the source is in a state this design cannot vouch for:
//   * a non-empty rollback journal (`-journal`): a transaction was interrupted and needs recovery, which would
//     mean writing to the source;
//   * a `-shm` without a `-wal`, or sidecars for a database that is not in WAL mode;
//   * a WAL-mode main file with NO `-wal` unless the caller states that the database was shut down cleanly
//     (`cleanShutdownConfirmed`): a main file copied without its WAL looks identical to a cleanly closed one;
//   * a sidecar that is not a regular file, or any file that cannot be read;
//   * a WAL whose header, page size or checksum chain is invalid in a way that would make SQLite ignore
//     committed data (valid frames after a corrupt one), see analyzeWal().
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class SnapshotError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SnapshotError';
    this.code = 'PREFLIGHT_SNAPSHOT_REFUSED';
  }
}
const refuse = (why, cause) => new SnapshotError(`snapshot refused: ${why}`, cause ? { cause } : undefined);

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_VERSION = 3007000;
const CHUNK = 1 << 20;

// Reads the 100-byte database header. Returns { pageSize, walMode, journalMode } or throws.
export function parseMainHeader(buf) {
  if (buf.length < 100 || buf.toString('latin1', 0, 16) !== SQLITE_MAGIC) throw refuse('the main file is not a SQLite database (bad header)');
  const raw = buf.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw refuse(`invalid page size ${raw} in the database header`);
  const write = buf[18];
  const read = buf[19];
  // The in-header page count is only trustworthy when the change counter matches the version-valid-for number.
  const headerPages = buf.readUInt32BE(24) === buf.readUInt32BE(92) && buf.readUInt32BE(28) > 0 ? buf.readUInt32BE(28) : null;
  if (write === 2 && read === 2) return { pageSize, journalMode: 'wal', headerPages };
  if (write === 1 && read === 1) return { pageSize, journalMode: 'rollback', headerPages };
  throw refuse(`unsupported file format versions (${write}, ${read}) in the database header`);
}

function checksum(buf, offset, length, bigEndian, s0 = 0, s1 = 0) {
  for (let i = offset; i < offset + length; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(i) : buf.readUInt32LE(i);
    const x1 = bigEndian ? buf.readUInt32BE(i + 4) : buf.readUInt32LE(i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

// Validates a WAL file the way SQLite reads it and reports what a reader will see. `mainPageSize` is the page
// size from the main file (null when the main file is empty). Throws SnapshotError when SQLite would silently
// ignore or truncate committed data:
//   * unreadable WAL header, wrong version, bad header checksum (SQLite then treats the WAL as empty),
//   * a page size different from the database's,
//   * a frame that fails validation while LATER frames of the same WAL generation (same salts) exist.
// Tolerated, and reported: damaged or unverifiable trailing frames, a partial trailing frame, and valid frames
// without a commit record (an interrupted transaction, which SQLite ignores by design). Only trailing frames that
// are VERIFIABLY intact leftovers of an older WAL generation count as normal (see the classification below).
// A WAL cut exactly at a frame boundary cannot be told from a legitimately shorter WAL and is not detectable.
export function analyzeWal(fd, size, mainPageSize) {
  if (size < 32) throw refuse(`the WAL file is ${size} bytes: shorter than its 32-byte header`);
  const head = Buffer.alloc(32);
  fs.readSync(fd, head, 0, 32, 0);
  const magic = head.readUInt32BE(0);
  if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) throw refuse('the WAL file has a bad magic number');
  const bigEndian = magic === WAL_MAGIC_BE;
  if (head.readUInt32BE(4) !== WAL_VERSION) throw refuse(`unsupported WAL format version ${head.readUInt32BE(4)}`);
  const pageSize = head.readUInt32BE(8);
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) throw refuse(`invalid page size ${pageSize} in the WAL header`);
  const [h0, h1] = checksum(head, 0, 24, bigEndian);
  if (h0 !== head.readUInt32BE(24) || h1 !== head.readUInt32BE(28)) throw refuse('the WAL header checksum is wrong (SQLite would ignore the whole WAL and its committed data)');
  if (mainPageSize != null && pageSize !== mainPageSize) throw refuse(`the WAL page size (${pageSize}) differs from the database page size (${mainPageSize})`);
  const salt1 = head.readUInt32BE(16);
  const salt2 = head.readUInt32BE(20);

  const frameSize = 24 + pageSize;
  const complete = Math.floor((size - 32) / frameSize);
  const partialTailBytes = (size - 32) - complete * frameSize;
  const frame = Buffer.alloc(frameSize);
  let s0 = head.readUInt32BE(24);
  let s1 = head.readUInt32BE(28);
  let valid = 0;
  let committed = 0;
  let commitDbSize = null;
  let firstInvalid = -1;
  const sameGeneration = (i) => { // does frame i carry this WAL generation's salts?
    fs.readSync(fd, frame, 0, 24, 32 + i * frameSize);
    return frame.readUInt32BE(8) === salt1 && frame.readUInt32BE(12) === salt2;
  };
  for (let i = 0; i < complete; i += 1) {
    fs.readSync(fd, frame, 0, frameSize, 32 + i * frameSize);
    let ok = frame.readUInt32BE(8) === salt1 && frame.readUInt32BE(12) === salt2 && frame.readUInt32BE(0) !== 0;
    let next = [s0, s1];
    if (ok) {
      next = checksum(frame, 0, 8, bigEndian, s0, s1);
      next = checksum(frame, 24, pageSize, bigEndian, next[0], next[1]);
      ok = next[0] === frame.readUInt32BE(16) && next[1] === frame.readUInt32BE(20);
    }
    if (!ok) { firstInvalid = i; break; }
    [s0, s1] = next;
    valid += 1;
    const dbSize = frame.readUInt32BE(4);
    if (dbSize !== 0) { committed = valid; commitDbSize = dbSize; }
  }
  // ---- Classify everything after the valid chain. ----
  // SQLite ignores these frames, which is only harmless if they are LEFTOVERS of an older WAL generation. They
  // are not harmless if they are a committed transaction that was damaged, zero-filled or lost. The format cannot
  // always tell the two apart, so a frame counts as a leftover only on positive evidence; everything else is
  // reported (damaged or unverified) and raises the WAL-tail warning.
  //
  // What the format offers: each frame's checksum is cumulative: it is computed from the PREVIOUS frame's stored
  // checksum plus this frame's page number, commit size and page data. The salts are NOT covered by the checksum.
  //   * A trailing frame whose checksum chains from the end of the valid chain, with a page number, is a frame of
  //     the CURRENT generation whose salts were damaged: damaged (it may be committed data).
  //   * A trailing frame with the current salts that fails validation: damaged.
  //   * Otherwise a frame is a verified older-generation frame only if it has a non-zero page number and non-zero
  //     salts AND its checksum chains from the previous trailing frame (same salts). The first frame of such a
  //     run has no readable predecessor (it was overwritten), so it counts only if the NEXT frame chains from it.
//     This is evidence about the chain LINKAGE, not about the first frame's own contents, and the checksum is not
//     authentication (accepted limitations D1, D2 and L1: see db/README.md).
  //   * Anything else (zero-filled, garbage, a broken chain, an isolated frame): unverified.
  // A frame of an older generation is not proof of which database the WAL belongs to; checksums never are.
  let damaged = 0;
  let verifiedStale = 0;
  let unverified = 0;
  if (firstInvalid >= 0) {
    for (let j = firstInvalid + 1; j < complete; j += 1) {
      if (sameGeneration(j)) throw refuse(`WAL frame ${firstInvalid + 1} is invalid but frame ${j + 1} of the same WAL generation follows it: SQLite would silently drop committed data after the damage`);
    }
    const buf = Buffer.alloc(frameSize);
    const metas = [];
    let seed = [s0, s1]; // end of the valid chain, advanced through frames that still chain from it
    let inCurrentChain = true;
    for (let j = firstInvalid; j < complete; j += 1) {
      fs.readSync(fd, buf, 0, frameSize, 32 + j * frameSize);
      const stored = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      const salts = [buf.readUInt32BE(8), buf.readUInt32BE(12)];
      const pgnoOk = buf.readUInt32BE(0) !== 0;
      const chainsFrom = (from) => {
        let c = checksum(buf, 0, 8, bigEndian, from[0], from[1]);
        c = checksum(buf, 24, pageSize, bigEndian, c[0], c[1]);
        return c[0] === stored[0] && c[1] === stored[1];
      };
      const meta = { pageNumberOk: pgnoOk, salts, stored, sameGeneration: salts[0] === salt1 && salts[1] === salt2, kind: null, chainsFromPrevious: false };
      if (meta.sameGeneration) {
        meta.kind = 'damaged'; // current salts, failed validation
        inCurrentChain = false;
      } else if (inCurrentChain && pgnoOk && chainsFrom(seed)) {
        meta.kind = 'damaged'; // continues the current chain, so it is current-generation data with damaged salts
        seed = stored;
      } else {
        inCurrentChain = false;
        const prev = metas[metas.length - 1];
        const linked = prev && prev.kind === null && prev.structural && prev.salts[0] === salts[0] && prev.salts[1] === salts[1];
        meta.structural = pgnoOk && salts[0] !== 0 && salts[1] !== 0;
        meta.chainsFromPrevious = Boolean(linked && meta.structural && chainsFrom(prev.stored));
        meta.followsSameSalts = Boolean(linked);
      }
      metas.push(meta);
    }
    for (let k = 0; k < metas.length; k += 1) {
      const m = metas[k];
      if (m.kind === 'damaged') { damaged += 1; continue; }
      let verified;
      if (!m.structural) verified = false;
      else if (m.chainsFromPrevious) verified = true;
      else if (m.followsSameSalts) verified = false; // same run, but the chain is broken here
      else { // the first frame of a run: needs the next frame to chain from it
        const next = metas[k + 1];
        verified = Boolean(next && next.kind === null && next.chainsFromPrevious);
      }
      if (verified) verifiedStale += 1; else unverified += 1;
    }
  }
  return {
    pageSize,
    completeFrames: complete,
    validFrames: valid,
    committedFrames: committed,
    uncommittedValidFrames: valid - committed,
    invalidFrames: firstInvalid >= 0 ? complete - firstInvalid : 0,
    damagedFrames: damaged,
    verifiedStaleFrames: verifiedStale,
    staleFrames: verifiedStale, // same number: only VERIFIED older-generation frames are called stale
    unverifiedTrailingFrames: unverified,
    partialTailBytes,
    commitDbSizePages: commitDbSize
  };
}

const fingerprint = (p) => {
  const s = fs.lstatSync(p, { bigint: true, throwIfNoEntry: false });
  if (!s) return null;
  return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
};

function lstatRegular(p, what) {
  const s = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!s) return null;
  if (s.isSymbolicLink()) throw refuse(`${what} is a symbolic link; refusing to follow it`);
  if (!s.isFile()) throw refuse(`${what} is not a regular file`);
  return s;
}

function readError(what, err) { return refuse(`cannot read ${what}: ${err?.code ?? ''} ${err?.message ?? err}`.trim(), err); }

// Writes buf[0..length) completely, continuing after short writes. A write that accepts no bytes is an error.
function writeAll(fd, buf, length, writeSync) {
  let offset = 0;
  while (offset < length) {
    const n = writeSync(fd, buf, offset, length - offset);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`write accepted ${n} bytes with ${length - offset} left to write`);
    offset += n;
  }
}

// Streams src to dst (when dst is given) and returns { bytes, sha256 } of the bytes READ from src.
function streamFile(src, dst, what, writeSync = fs.writeSync) {
  let fdIn;
  let fdOut;
  try {
    fdIn = fs.openSync(src, 'r');
    if (dst) fdOut = fs.openSync(dst, 'wx', 0o600);
    const hash = crypto.createHash('sha256');
    const buf = Buffer.alloc(CHUNK);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fdIn, buf, 0, CHUNK, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      if (fdOut !== undefined) {
        try { writeAll(fdOut, buf, n, writeSync); } catch (err) { throw refuse(`cannot write the copy of ${what}: ${err?.code ?? ''} ${err?.message ?? err}`.trim(), err); }
      }
      bytes += n;
    }
    return { bytes, sha256: hash.digest('hex') };
  } catch (err) {
    throw err instanceof SnapshotError ? err : readError(what, err);
  } finally {
    if (fdIn !== undefined) fs.closeSync(fdIn);
    if (fdOut !== undefined) fs.closeSync(fdOut);
  }
}

// Re-reads a COPY from disk and requires its real size and SHA-256 to equal those of the source bytes that were copied.
function verifyCopy(file, expected, what) {
  const size = fs.statSync(file).size;
  if (size !== expected.bytes) throw refuse(`the copied ${what} is ${size} bytes but ${expected.bytes} bytes were read from the source`);
  const again = streamFile(file, null, `the copied ${what}`);
  if (again.bytes !== expected.bytes || again.sha256 !== expected.sha256) throw refuse(`the copied ${what} does not match the source bytes (SHA-256 differs): the copy is corrupt`);
  return again;
}

// Copies sourcePath (+ its WAL) into destDir as snapshot.db (+ snapshot.db-wal) and verifies the result.
// Returns a description of the snapshot. destDir must exist, be empty and not be inside the source directory.
// testHooks is for tests only (it grants no capability: the copy is verified from disk regardless):
//   onBeforeCopy, onAfterFirstPass, onBeforeVerifyCopy(paths), writeSync(fd, buf, offset, length).
export function takeSnapshot(sourcePath, destDir, { cleanShutdownConfirmed = false, testHooks = {} } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath.trim() || sourcePath === ':memory:' || sourcePath.startsWith('file:')) {
    throw refuse('a path to a database file is required');
  }
  const mainStat = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!mainStat) throw refuse(`${sourcePath} does not exist`);
  const main = mainStat.isSymbolicLink() ? fs.realpathSync(sourcePath) : path.resolve(sourcePath);
  if (!fs.statSync(main).isFile()) throw refuse(`${sourcePath} is not a regular file`);
  if (/-(wal|shm|journal)$/.test(main)) throw refuse('pass the main database file, not a sidecar');
  const wal = `${main}-wal`;
  const shm = `${main}-shm`;
  const journal = `${main}-journal`;

  const destReal = fs.realpathSync(destDir);
  const sourceDir = fs.realpathSync(path.dirname(main));
  if (destReal === sourceDir || destReal.startsWith(sourceDir + path.sep)) throw refuse('the snapshot directory must not be inside the source directory');
  if (fs.readdirSync(destDir).length !== 0) throw refuse('the snapshot directory must be empty');

  // Source inspection that needs no database header: the kinds of file that are present.
  const walStat = lstatRegular(wal, 'the -wal file');
  const shmStat = lstatRegular(shm, 'the -shm file');
  const journalStat = lstatRegular(journal, 'the -journal file');
  if (journalStat && journalStat.size > 0) throw refuse('a non-empty rollback journal exists (an interrupted transaction needs recovery, which would write to the source)');
  if (shmStat && !walStat) throw refuse('a -shm file exists without a -wal file: the state is inconsistent');
  const walNonEmpty = Boolean(walStat) && walStat.size > 0;

  const before = { main: fingerprint(main), wal: fingerprint(wal), shm: shmStat ? 'present' : null, journal: fingerprint(journal) };
  const outMain = path.join(destReal, 'snapshot.db');
  const outWal = path.join(destReal, 'snapshot.db-wal');
  const writeSync = testHooks.writeSync ?? fs.writeSync;
  testHooks.onBeforeCopy?.({ main, wal });

  // Pass 1: copy main, then WAL.
  const copiedMain = streamFile(main, outMain, 'the main file', writeSync);
  const copiedWal = walNonEmpty ? streamFile(wal, outWal, 'the -wal file', writeSync) : null;
  testHooks.onAfterFirstPass?.({ main, wal });
  // Pass 2: hash again in the opposite order, then compare identity, size, timestamps and content.
  const changed = [];
  let againWal = null;
  if (walNonEmpty) {
    try { againWal = streamFile(wal, null, 'the -wal file'); } catch (err) {
      if (err.cause?.code !== 'ENOENT') throw err;
      changed.push('wal (it disappeared)');
    }
  }
  const againMain = streamFile(main, null, 'the main file');
  const after = { main: fingerprint(main), wal: fingerprint(wal), shm: lstatRegular(shm, 'the -shm file') ? 'present' : null, journal: fingerprint(journal) };
  for (const k of Object.keys(before)) if (before[k] !== after[k]) changed.push(k);
  if (againMain.sha256 !== copiedMain.sha256 || againMain.bytes !== copiedMain.bytes) changed.push('main content');
  if (copiedWal && againWal && (againWal.sha256 !== copiedWal.sha256 || againWal.bytes !== copiedWal.bytes)) changed.push('wal content');
  if (changed.length) throw refuse(`the source changed while it was being copied (${[...new Set(changed)].join(', ')}). Stop every process that uses the database and try again`);

  // Verify the COPIES byte for byte against what was read from the source.
  testHooks.onBeforeVerifyCopy?.({ outMain, outWal });
  verifyCopy(outMain, copiedMain, 'main file');
  if (copiedWal) verifyCopy(outWal, copiedWal, 'WAL');

  // Everything below uses the COPIED bytes only.
  let headerBytes;
  try {
    const fd = fs.openSync(outMain, 'r');
    try { headerBytes = Buffer.alloc(100); headerBytes = headerBytes.subarray(0, fs.readSync(fd, headerBytes, 0, 100, 0)); } finally { fs.closeSync(fd); }
  } catch (err) { throw readError('the copied main file', err); }
  const copyMainSize = fs.statSync(outMain).size;
  const emptyMain = copyMainSize === 0;
  const info = emptyMain ? { pageSize: null, journalMode: 'wal', headerPages: null } : parseMainHeader(headerBytes);
  if (!emptyMain && copyMainSize % info.pageSize !== 0) throw refuse(`the main file size (${copyMainSize}) is not a multiple of its page size (${info.pageSize}): it is truncated or damaged`);
  if (info.headerPages != null && copyMainSize < info.headerPages * info.pageSize) {
    throw refuse(`the main file holds ${copyMainSize / info.pageSize} pages but its header says ${info.headerPages}: it is truncated`);
  }
  const walPresent = Boolean(walStat);
  if (info.journalMode === 'rollback' && (walPresent || shmStat)) throw refuse('the database is not in WAL mode but has -wal or -shm files: the state is inconsistent');
  if (!walPresent && info.journalMode === 'wal' && !cleanShutdownConfirmed) {
    throw refuse('the database is in WAL mode but there is no -wal file. A main file copied without its WAL looks exactly like a cleanly shut down database. Stop the application so SQLite shuts down cleanly, point this at the ORIGINAL location (not at a copy of the main file), or pass cleanShutdownConfirmed: true if you know the database was closed cleanly');
  }
  if (emptyMain && !walNonEmpty) throw refuse('the main file is empty and there is no WAL data');

  let wa = null;
  if (copiedWal) {
    const fd = fs.openSync(outWal, 'r');
    try { wa = analyzeWal(fd, fs.fstatSync(fd).size, info.pageSize); } finally { fs.closeSync(fd); }
    if (emptyMain && wa.committedFrames === 0) throw refuse('the main file is empty and the WAL holds no committed transaction');
  }
  return Object.freeze({
    journalMode: info.journalMode,
    pageSize: info.pageSize ?? wa?.pageSize ?? null,
    mainBytes: copiedMain.bytes,
    mainSha256: copiedMain.sha256,
    walPresent,
    walBytes: copiedWal?.bytes ?? 0,
    walSha256: copiedWal?.sha256 ?? null,
    shmPresentInSource: Boolean(shmStat),
    assumedCleanShutdown: info.journalMode === 'wal' && !walPresent,
    copyVerified: true,
    wal: wa ? Object.freeze(wa) : null,
    // The page count a reader must see once the committed WAL frames are applied; null when it is not implied by the WAL.
    expectedPageCount: wa && wa.committedFrames > 0 ? wa.commitDbSizePages : null
  });
}
