// Tests for the destructive-operation guard, the seed CLI and the test isolation machinery.
// Every database touched here lives in a directory freshly created under the OS temp folder.
// The repository's data/ directory and any real database are never opened.
//
// This file deliberately imports only server/guard.js and server/dblocation.js (both free of
// import-time I/O). Anything that needs a database runs in a child process with its own temporary
// directory, so these tests do not depend on tests/preload.js being active in this process.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as guardModule from '../server/guard.js';
import { resolveDatabaseLocation, isTestProcess } from '../server/dblocation.js';

const { createGuard, resolveTarget, isInside, TEST_DIR_PREFIX, DISPOSABLE_MARKER } = guardModule;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.realpathSync.native(os.tmpdir());
const url = (p) => JSON.stringify(pathToFileURL(path.join(repoRoot, p)).href);
const cliPath = path.join(repoRoot, 'server', 'seed-cli.js');

// ---------- helpers ----------

function makeTempDir(prefix = 'alumni-connect-guardtest-') {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(tmpRoot, prefix)));
}

// Runs fn with a fresh temp dir, always removes it, and proves it was removed.
async function withTempDir(fn, prefix) {
  const dir = makeTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false, 'temporary directory must be cleaned up');
  }
}

// Environment for child processes: nothing inherited that could point at a real database.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL', 'DB_FILE', 'DATA_DIR', 'NODE_ENV', 'RENDER', 'SANDBOX', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[k];
  env.JWT_SECRET = 'guard-test-secret-' + crypto.randomBytes(8).toString('hex');
  return { ...env, ...extra };
}

const runModule = (code, env) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repoRoot, env, encoding: 'utf8', timeout: 120000 });

// A "real-looking" database holding one canary row, to prove it is never wiped.
function makeCanaryDb(dir, file = 'alumni_platform.db') {
  const p = path.join(dir, file);
  const d = new DatabaseSync(p);
  d.exec("CREATE TABLE users (id TEXT); INSERT INTO users (id) VALUES ('canary');");
  d.close();
  return p;
}
const canaryCount = (p) => {
  const d = new DatabaseSync(p);
  try { return d.prepare("SELECT COUNT(*) n FROM users WHERE id = 'canary'").get().n; } finally { d.close(); }
};
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// File names, hashes and modification times: any create, write, -wal or -shm shows up as a difference.
const snapshotDir = (dir) => fs.readdirSync(dir).sort().map((f) => {
  const p = path.join(dir, f);
  return `${f}:${sha256(p)}:${fs.statSync(p).mtimeMs}`;
});

// Child process that imports the real db/seed/guard modules (in a NON-test process), spies on every
// SQL statement, then runs `body`. The result is printed as one JSON line.
function scenario(body) {
  return `
import { db, dbPath, dropAllTables } from ${url('server/db.js')};
import { runSeed } from ${url('server/seed.js')};
import * as guard from ${url('server/guard.js')};
const prepOrig = db.prepare.bind(db);
const countTables = () => prepOrig("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n;
const log = [];
for (const m of ['exec', 'prepare']) { const o = db[m].bind(db); db[m] = (...a) => { log.push(String(a[0])); return o(...a); }; }
const result = { before: countTables(), attempts: {} };
const attempt = (name, fn) => { try { fn(); result.attempts[name] = 'ALLOWED'; } catch (e) { result.attempts[name] = String(e.message); } };
${body}
result.after = countTables();
result.log = log;
console.log('RESULT:' + JSON.stringify(result));
`;
}
function parseResult(out) {
  assert.equal(out.status, 0, `child failed: ${out.stderr}`);
  const line = out.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, `no result line. stdout: ${out.stdout} stderr: ${out.stderr}`);
  return JSON.parse(line.slice('RESULT:'.length));
}

// ---------- guard unit tests (in-process, using private guard instances) ----------

describe('guard: capabilities', () => {
  test('a disposable test target is only accepted for a fresh, empty, correctly named directory in the OS temp folder', async () => {
    const g = createGuard();
    // The repository's data/ folder: refused because it is outside the OS temp folder, or (when a
    // checkout itself lives under the temp folder, as in a scratch copy) because it is inside the repo.
    assert.throws(() => g.markDisposableTestTarget({ dir: path.join(repoRoot, 'data'), dbPath: path.join(repoRoot, 'data', 'x.db') }), /OS temp directory|inside the repository/);
    assert.throws(() => g.markDisposableTestTarget({ dir: tmpRoot, dbPath: path.join(tmpRoot, 'x.db') }), /OS temp directory/);
    await withTempDir((dir) => {
      assert.throws(() => g.markDisposableTestTarget({ dir, dbPath: path.join(dir, 'x.db') }), /unexpected directory name/);
    }, 'some-other-');
    await withTempDir((dir) => {
      fs.writeFileSync(path.join(dir, 'existing.db'), 'data');
      assert.throws(() => g.markDisposableTestTarget({ dir, dbPath: path.join(dir, 'x.db') }), /must be empty/);
      assert.equal(fs.readFileSync(path.join(dir, 'existing.db'), 'utf8'), 'data');
    }, TEST_DIR_PREFIX);
    await withTempDir((dir) => {
      assert.throws(() => g.markDisposableTestTarget({ dir, dbPath: path.join(dir, 'sub', 'x.db') }), /directly in the test directory/);
    }, TEST_DIR_PREFIX);
  });

  test('destructive operations need a genuine capability for that exact file; forged, foreign or wrong-target ones are refused', async () => {
    await withTempDir((dir) => {
      const g = createGuard();
      const other = createGuard();
      const db1 = path.join(dir, 'a.test.db');
      // A *.test.db name in a temp dir proves nothing without a capability.
      assert.throws(() => g.assertDestructiveAllowed(db1, 'drop all tables'), /no valid authorization/);
      assert.throws(() => g.assertDestructiveAllowed(db1, 'drop all tables', undefined), /no valid authorization/);
      assert.throws(() => g.assertDestructiveAllowed(db1, 'drop all tables', {}), /no valid authorization/);
      assert.throws(() => g.assertDestructiveAllowed(db1, 'drop all tables', 'yes'), /no valid authorization/);
      const cap = g.markDisposableTestTarget({ dir, dbPath: db1 });
      assert.ok(Object.isFrozen(cap) && Object.keys(cap).length === 0, 'the capability is opaque');
      assert.doesNotThrow(() => g.assertDestructiveAllowed(db1, 'drop all tables', cap));
      // Not valid for a sibling file, and not valid in another guard instance.
      assert.throws(() => g.assertDestructiveAllowed(path.join(dir, 'b.test.db'), 'drop all tables', cap), /different database/);
      assert.throws(() => other.assertDestructiveAllowed(db1, 'drop all tables', cap), /no valid authorization/);
      // Tampering with or removing the marker revokes it.
      const marker = path.join(dir, DISPOSABLE_MARKER);
      fs.writeFileSync(marker, 'tampered');
      assert.throws(() => g.assertDestructiveAllowed(db1, 'drop all tables', cap), /marker is missing/);
      fs.rmSync(marker);
      assert.throws(() => g.assertDestructiveAllowed(db1, 'drop all tables', cap), /marker is missing/);
    }, TEST_DIR_PREFIX);
  });

  test('production refuses everything, including capabilities obtained earlier', async () => {
    await withTempDir((dir) => {
      for (const prod of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
        const env = {};
        const g = createGuard({ getEnv: () => env });
        const target = path.join(dir, 'a.test.db');
        const cap = g.markDisposableTestTarget({ dir, dbPath: target });
        assert.doesNotThrow(() => g.assertDestructiveAllowed(target, 'drop all tables', cap));
        Object.assign(env, prod);
        assert.throws(() => g.assertDestructiveAllowed(target, 'drop all tables', cap), /production environment/);
        assert.throws(() => g.markDisposableTestTarget({ dir, dbPath: target }), /production environment/);
        assert.throws(() => g.validateWipeConfirmation(target, [`--confirm-wipe=${resolveTarget(target)}`]), /production environment/);
        assert.throws(() => g.authorizeManualWipe(target), /production environment/);
        fs.rmSync(path.join(dir, DISPOSABLE_MARKER), { force: true });
      }
    }, TEST_DIR_PREFIX);
  });

  test('a manual wipe can only be authorized by the seed CLI, from its real command line, with the exact path', async () => {
    await withTempDir((dir) => {
      const target = path.join(dir, 'local.db');
      const exact = resolveTarget(target);
      const argvFor = (script, ...args) => ['node', script, ...args];
      const asCli = (...args) => createGuard({ getArgv: () => argvFor(cliPath, ...args) });
      // Application code (the web server entry point) cannot grant itself a wipe, even holding the right flag.
      const server = createGuard({ getArgv: () => argvFor(path.join(repoRoot, 'server', 'index.js'), `--confirm-wipe=${exact}`) });
      assert.throws(() => server.authorizeManualWipe(target), /only the seed CLI/);
      assert.throws(() => createGuard({ getArgv: () => ['node'] }).authorizeManualWipe(target), /only the seed CLI/);
      // The CLI itself still needs the exact confirmation.
      assert.throws(() => asCli().authorizeManualWipe(target), /no confirmation/);
      assert.throws(() => asCli('--confirm-wipe=').authorizeManualWipe(target), /no confirmation/);
      assert.throws(() => asCli(`--confirm-wipe=${path.join(dir, 'other.db')}`).authorizeManualWipe(target), /does not match/);
      assert.throws(() => asCli('--confirm-wipe=local.db').authorizeManualWipe(target), /does not match/);
      assert.throws(() => asCli('--wipe-production-data').authorizeManualWipe(target), /no confirmation/);
      const g = asCli(`--confirm-wipe=${exact}`);
      const cap = g.authorizeManualWipe(target);
      assert.doesNotThrow(() => g.assertDestructiveAllowed(target, 'wipe', cap));
      assert.throws(() => g.assertDestructiveAllowed(path.join(dir, 'other.db'), 'wipe', cap), /different database/);
    });
  });

  test('confirmations: the wipe needs the exact path; the sandbox seed needs the exact path and, in production, SANDBOX=on', async () => {
    await withTempDir((dir) => {
      const target = path.join(dir, 'local.db');
      const exact = resolveTarget(target);
      const g = createGuard();
      assert.throws(() => g.validateWipeConfirmation(target, []), /no confirmation/);
      assert.equal(g.validateWipeConfirmation(target, [`--confirm-wipe=${exact}`]), exact);
      // Sandbox: always explicit.
      assert.throws(() => g.validateSandboxConfirmation(target, ['--sandbox']), /no confirmation/);
      assert.throws(() => g.validateSandboxConfirmation(target, [`--confirm-sandbox=${path.join(dir, 'x.db')}`]), /does not match/);
      assert.throws(() => g.validateSandboxConfirmation(target, [`--confirm-wipe=${exact}`]), /no confirmation/);
      assert.equal(g.validateSandboxConfirmation(target, [`--confirm-sandbox=${exact}`]), exact);
      // Sandbox in production: the exact path alone is not enough.
      for (const prod of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
        const noOptIn = createGuard({ getEnv: () => ({ ...prod }) });
        assert.throws(() => noOptIn.validateSandboxConfirmation(target, [`--confirm-sandbox=${exact}`]), /SANDBOX=on is not set/);
        const optedIn = createGuard({ getEnv: () => ({ ...prod, SANDBOX: 'on' }) });
        assert.throws(() => optedIn.validateSandboxConfirmation(target, []), /no confirmation/);
        assert.equal(optedIn.validateSandboxConfirmation(target, [`--confirm-sandbox=${exact}`]), exact);
      }
    });
  });

  test('database location is pure and test processes are detected', () => {
    assert.deepEqual(resolveDatabaseLocation({ DATA_DIR: '/x/y', DB_FILE: 'z.db' }), { dataDir: path.resolve('/x/y'), dbFile: 'z.db', dbPath: path.join(path.resolve('/x/y'), 'z.db') });
    assert.equal(resolveDatabaseLocation({}).dbFile, 'alumni_platform.db');
    assert.equal(resolveDatabaseLocation({ NODE_TEST_CONTEXT: '1' }).dbFile, 'alumni_platform.db', 'no test-specific file name fallback');
    assert.equal(isTestProcess({}, ['node', '/app/server/index.js'], []), false);
    assert.equal(isTestProcess({ NODE_TEST_CONTEXT: 'child-v8' }, ['node', 'x.js'], []), true);
    assert.equal(isTestProcess({}, ['node', '/repo/tests/api.test.js'], []), true);
    assert.equal(isTestProcess({}, ['node', 'x.js'], ['--test']), true);
  });
});

// ---------- destructive functions, in a real (non-test) process ----------

describe('destructive functions without authorization', () => {
  test('dropAllTables() refuses with no, forged or wrong capability before running any SQL', async () => {
    await withTempDir((dir) => {
      const env = cleanEnv({ DATA_DIR: dir, DB_FILE: 'unauthorized.db' });
      const r = parseResult(runModule(scenario(`
        attempt('none', () => dropAllTables());
        attempt('forged', () => dropAllTables({}));
        attempt('string', () => dropAllTables('--confirm-wipe'));
      `), env));
      for (const k of ['none', 'forged', 'string']) assert.match(r.attempts[k], /Refusing to drop all tables/, k);
      assert.ok(r.before > 0);
      assert.equal(r.after, r.before, 'no table may be dropped');
      assert.equal(r.log.length, 0, 'the guard must run before any SQL');
    });
  });

  test('runSeed() without an explicit mode, or a full seed without a capability, does not touch anything', async () => {
    await withTempDir((dir) => {
      const env = cleanEnv({ DATA_DIR: dir, DB_FILE: 'alumni_platform.db' });
      const r = parseResult(runModule(scenario(`
        attempt('noArgs', () => runSeed());
        attempt('emptyObject', () => runSeed({}));
        attempt('unknownMode', () => runSeed({ mode: 'wipe' }));
        attempt('fullNoCap', () => runSeed({ mode: 'full' }));
        attempt('fullForged', () => runSeed({ mode: 'full', authorization: {} }));
      `), env));
      for (const k of ['noArgs', 'emptyObject', 'unknownMode']) assert.match(r.attempts[k], /explicit mode/, k);
      for (const k of ['fullNoCap', 'fullForged']) assert.match(r.attempts[k], /Refusing to run a full seed/, k);
      assert.equal(r.after, r.before);
      assert.equal(r.log.length, 0);
    });
  });

  test('production cannot be bypassed', async () => {
    for (const prod of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
      await withTempDir((dir) => {
        const env = cleanEnv({ DATA_DIR: dir, DB_FILE: 'prod.db', ...prod });
        const r = parseResult(runModule(scenario(`
          attempt('authorize', () => guard.authorizeManualWipe(dbPath));
          attempt('drop', () => dropAllTables({}));
          attempt('full', () => runSeed({ mode: 'full' }));
        `), env));
        for (const k of ['authorize', 'drop', 'full']) assert.match(r.attempts[k], /production environment/, k);
        assert.equal(r.after, r.before);
        assert.equal(r.log.length, 0);
      });
    }
  });
});

// ---------- seed CLI ----------

describe('seed CLI', () => {
  const cli = (dir, args, extraEnv = {}) => spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot, env: cleanEnv({ DATA_DIR: dir, DB_FILE: 'local.db', ...extraEnv }), encoding: 'utf8', timeout: 120000
  });

  test('every refusal leaves an existing database byte-for-byte unchanged (no schema init, no journal change, no -wal/-shm)', async () => {
    await withTempDir((dir) => {
      const db = makeCanaryDb(dir, 'local.db');
      const exact = resolveTarget(db);
      const before = snapshotDir(dir);
      const refusals = [
        [[], /Refusing to wipe.*no confirmation/s],
        [['--confirm-wipe='], /Refusing to wipe.*no confirmation/s],
        [[`--confirm-wipe=${path.join(dir, 'other.db')}`], /Refusing to wipe.*does not match/s],
        [['--confirm-wipe=local.db'], /Refusing to wipe.*does not match/s],
        [['--wipe-production-data'], /Refusing to wipe.*no confirmation/s],
        [['--sandbox'], /Refusing to seed the sandbox.*no confirmation/s],
        [['--sandbox', `--confirm-sandbox=${path.join(dir, 'other.db')}`], /Refusing to seed the sandbox.*does not match/s],
        [['--sandbox', `--confirm-wipe=${exact}`], /Refusing to seed the sandbox.*no confirmation/s]
      ];
      for (const [args, pattern] of refusals) {
        const out = cli(dir, args);
        assert.equal(out.status, 1, args.join(' '));
        assert.match(out.stderr, pattern);
        assert.ok(out.stderr.includes(exact), 'the resolved target must be shown to the operator');
        assert.deepEqual(snapshotDir(dir), before, `must not touch the database: ${args.join(' ')}`);
      }
      assert.equal(canaryCount(db), 1);
      // Production, with and without the exact confirmation.
      for (const prod of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
        for (const args of [[`--confirm-wipe=${exact}`], [`--confirm-wipe=${exact}`, '--wipe-production-data'], ['--wipe-production-data']]) {
          const out = cli(dir, args, prod);
          assert.equal(out.status, 1);
          assert.match(out.stderr, /Refusing to wipe.*production environment/s);
          assert.deepEqual(snapshotDir(dir), before);
        }
        // Sandbox in production without the SANDBOX=on opt-in, even with the exact path.
        const sb = cli(dir, ['--sandbox', `--confirm-sandbox=${exact}`], prod);
        assert.equal(sb.status, 1);
        assert.match(sb.stderr, /SANDBOX=on is not set/);
        assert.deepEqual(snapshotDir(dir), before);
      }
    });
  });

  test('a refusal creates nothing at all when the target does not exist yet, and needs no JWT_SECRET', async () => {
    await withTempDir((base) => {
      const missing = path.join(base, 'not-created');
      const env = cleanEnv({ DATA_DIR: missing, DB_FILE: 'local.db' });
      delete env.JWT_SECRET;
      for (const args of [[], ['--sandbox'], ['--confirm-wipe=relative.db']]) {
        const out = spawnSync(process.execPath, [cliPath, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: 60000 });
        assert.equal(out.status, 1);
        assert.match(out.stderr, /Refusing to/);
        assert.doesNotMatch(out.stderr, /JWT_SECRET/);
        assert.equal(fs.existsSync(missing), false, 'the data directory must not be created');
      }
      assert.deepEqual(fs.readdirSync(base), []);
    });
  });

  test('positive control: the exact confirmation wipes only the confirmed database', async () => {
    await withTempDir((dir) => {
      const db = makeCanaryDb(dir, 'local.db');
      const bystander = makeCanaryDb(dir, 'bystander.db');
      const bystanderHash = sha256(bystander);
      const out = cli(dir, [`--confirm-wipe=${resolveTarget(db)}`]);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(canaryCount(db), 0, 'the confirmed database is rebuilt');
      const d = new DatabaseSync(db);
      try { assert.ok(d.prepare('SELECT COUNT(*) n FROM institutions').get().n > 0, 'seed data present'); } finally { d.close(); }
      assert.equal(sha256(bystander), bystanderHash, 'other databases are untouched');
    });
  });

  test('sandbox seed: explicit confirmation works, in production only with SANDBOX=on, and it warns when real data is present', async () => {
    await withTempDir((dir) => {
      const target = path.join(dir, 'local.db');
      const exact = resolveTarget(target);
      const ok = cli(dir, ['--sandbox', `--confirm-sandbox=${exact}`]);
      assert.equal(ok.status, 0, ok.stderr);
      const d = new DatabaseSync(target);
      try {
        assert.ok(d.prepare('SELECT COUNT(*) n FROM institutions WHERE is_sandbox = 1').get().n > 0, 'sandbox institutions exist');
        // Add one real (non-sandbox) institution, then seed again: the operator is warned.
        d.exec("INSERT INTO institutions (id, name, short_name, abbr, domain, city, state, type, founded) VALUES ('real_1','Real College','Real','RC','real.example','X','Y','Private',2000)");
      } finally { d.close(); }
      const again = cli(dir, ['--sandbox', `--confirm-sandbox=${exact}`]);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stderr, /already holds 1 real institution/);
      const d2 = new DatabaseSync(target);
      try { assert.equal(d2.prepare("SELECT COUNT(*) n FROM institutions WHERE id = 'real_1'").get().n, 1, 'the real institution survives'); } finally { d2.close(); }
    });
    await withTempDir((dir) => {
      const exact = resolveTarget(path.join(dir, 'local.db'));
      const prod = cli(dir, ['--sandbox', `--confirm-sandbox=${exact}`], { NODE_ENV: 'production', SANDBOX: 'on' });
      assert.equal(prod.status, 0, prod.stderr);
    });
  });
});

// ---------- test isolation ----------

describe('test isolation', () => {
  const preloadUrl = pathToFileURL(path.join(repoRoot, 'tests', 'preload.js')).href;
  const hostile = (fake) => cleanEnv({
    DATA_DIR: fake, DB_FILE: 'alumni_platform.db',
    DATABASE_URL: 'postgres://prod.invalid/alumni', TEST_DATABASE_URL: 'postgres://prod.invalid/alumni_test'
  });

  test('db.js fails closed in a test-looking process without isolation, before creating or opening anything', async () => {
    await withTempDir((base) => {
      const missing = path.join(base, 'not-created');
      // (a) NODE_TEST_CONTEXT, as set by the node test runner.
      const a = runModule(`import ${url('server/db.js')};`, cleanEnv({ DATA_DIR: missing, NODE_TEST_CONTEXT: 'child-v8' }));
      assert.notEqual(a.status, 0);
      assert.match(a.stderr, /test isolation is not active/);
      // (b) a script named *.test.js run directly with plain node.
      const probe = path.join(base, 'probe.test.js');
      fs.writeFileSync(probe, `import ${url('server/db.js')};\n`);
      const b = spawnSync(process.execPath, [probe], { cwd: repoRoot, env: cleanEnv({ DATA_DIR: missing }), encoding: 'utf8' });
      assert.notEqual(b.status, 0);
      assert.match(b.stderr, /test isolation is not active/);
      assert.equal(fs.existsSync(missing), false, 'nothing may be created');
    });
  });

  test('hostile DATA_DIR, DB_FILE, DATABASE_URL and TEST_DATABASE_URL cannot redirect a test process', async () => {
    await withTempDir((fake) => {
      const real = makeCanaryDb(fake);
      const before = snapshotDir(fake);
      const code = `
        import * as iso from ${url('tests/support/isolation.js')};
        // Hostile values set AFTER the isolation was established, right before db.js loads.
        process.env.DATA_DIR = process.env.FAKE_DIR;
        process.env.DB_FILE = 'alumni_platform.db';
        process.env.DATABASE_URL = 'postgres://prod.invalid/alumni';
        process.env.TEST_DATABASE_URL = 'postgres://prod.invalid/alumni_test';
        const { dbPath, dataDir } = await import(${url('server/db.js')});
        const out = { dbPath, dataDir, testDir: iso.testDir };
        out.removed = iso.cleanupTestDatabase();
        console.log('RESULT:' + JSON.stringify(out));
      `;
      const r = parseResult(runModule(code, { ...hostile(fake), NODE_TEST_CONTEXT: 'child-v8', FAKE_DIR: fake }));
      const rp = resolveTarget(r.dbPath);
      assert.ok(isInside(rp, tmpRoot), 'test database is in the OS temp directory');
      assert.ok(!isInside(rp, repoRoot), 'test database is outside the repository, so not under data/');
      assert.ok(!isInside(rp, fake) && rp !== resolveTarget(real), 'not the database the environment pointed at');
      assert.equal(r.removed, true, 'cleanup closed the open database and removed the directory');
      assert.equal(fs.existsSync(r.testDir), false);
      assert.deepEqual(snapshotDir(fake), before, 'the decoy database directory is unchanged');
      assert.equal(canaryCount(real), 1);
    });
  });

  test('the isolation setup fails closed in a production environment', async () => {
    await withTempDir((fake) => {
      const real = makeCanaryDb(fake);
      const before = snapshotDir(fake);
      for (const prod of [{ NODE_ENV: 'production' }, { RENDER: 'true' }]) {
        const out = runModule(`import ${url('tests/preload.js')}; import ${url('server/db.js')};`, { ...hostile(fake), ...prod });
        assert.notEqual(out.status, 0);
        assert.match(out.stderr, /Refusing to run tests/);
        assert.deepEqual(snapshotDir(fake), before);
        assert.equal(canaryCount(real), 1);
      }
    });
  });

  test('node --import runs the preload in EVERY test process; each gets its own isolated temporary database', async () => {
    await withTempDir((work) => {
      const fake = path.join(work, 'decoy');
      fs.mkdirSync(fake);
      const real = makeCanaryDb(fake);
      const decoyBefore = snapshotDir(fake);
      const out = path.join(work, 'out');
      fs.mkdirSync(out);
      const files = ['a', 'b', 'c'].map((n) => {
        const f = path.join(work, `${n}.test.js`);
        fs.writeFileSync(f, `
          import { test } from 'node:test';
          import fs from 'node:fs';
          import path from 'node:path';
          import { isTestIsolationActive, getTestLocation } from ${url('server/guard.js')};
          import { dbPath } from ${url('server/db.js')};
          test('probe', () => {
            fs.writeFileSync(path.join(process.env.PROBE_OUT, process.pid + '.json'), JSON.stringify({
              pid: process.pid, active: isTestIsolationActive(), location: getTestLocation(), dbPath,
              dataDirEnv: process.env.DATA_DIR, hasUrl: Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL)
            }));
          });
        `);
        return f;
      });
      const run = spawnSync(process.execPath, ['--import', preloadUrl, '--test', ...files], {
        cwd: repoRoot, env: { ...hostile(fake), PROBE_OUT: out }, encoding: 'utf8', timeout: 120000
      });
      assert.equal(run.status, 0, `probe run failed:\n${run.stdout}\n${run.stderr}`);
      const results = fs.readdirSync(out).map((f) => JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')));
      assert.equal(results.length, 3, 'one result per test file, each from its own process');
      assert.equal(new Set(results.map((r) => r.pid)).size, 3, 'three distinct processes');
      assert.equal(new Set(results.map((r) => r.location.dataDir)).size, 3, 'three distinct temporary directories');
      for (const r of results) {
        assert.equal(r.active, true, 'the preload ran in this test process');
        assert.equal(resolveTarget(r.dbPath), resolveTarget(r.location.dbPath), 'db.js used the isolated location');
        assert.ok(isInside(resolveTarget(r.dbPath), tmpRoot) && !isInside(resolveTarget(r.dbPath), repoRoot));
        assert.ok(!isInside(resolveTarget(r.dbPath), fake));
        assert.equal(r.hasUrl, false);
        assert.equal(fs.existsSync(r.location.dataDir), false, 'each process removed its own directory on exit');
      }
      assert.deepEqual(snapshotDir(fake), decoyBefore, 'the decoy database is unchanged');
      assert.equal(canaryCount(real), 1);
    });
  });

  test('cleanup closes database handles first and is retryable after a failed attempt', async () => {
    const code = `
      import fs from 'node:fs';
      import * as iso from ${url('tests/support/isolation.js')};
      import { db } from ${url('server/db.js')};
      const real = fs.rmSync;
      let calls = 0;
      let closedBeforeDelete = null;
      fs.rmSync = (...a) => {
        calls++;
        if (calls === 1) {
          try { db.prepare('SELECT 1'); closedBeforeDelete = false; } catch { closedBeforeDelete = true; }
          const e = new Error('busy'); e.code = 'EBUSY'; throw e;
        }
        return real(...a);
      };
      const first = iso.cleanupTestDatabase();
      const existsAfterFailure = fs.existsSync(iso.testDir);
      fs.rmSync = real;
      const second = iso.cleanupTestDatabase();
      console.log('RESULT:' + JSON.stringify({ first, closedBeforeDelete, existsAfterFailure, second, existsAfterRetry: fs.existsSync(iso.testDir) }));
    `;
    const r = parseResult(runModule(code, cleanEnv({ NODE_TEST_CONTEXT: 'child-v8' })));
    assert.deepEqual(r, { first: false, closedBeforeDelete: true, existsAfterFailure: true, second: true, existsAfterRetry: false });
  });

  test('SIGTERM removes the temporary directory (POSIX); SIGKILL cannot be handled', { skip: process.platform === 'win32' && 'POSIX signals only' }, async () => {
    const code = `
      import * as iso from ${url('tests/support/isolation.js')};
      import ${url('server/db.js')};
      console.log('READY:' + iso.testDir);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: repoRoot, env: cleanEnv({ NODE_TEST_CONTEXT: 'child-v8' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let dir = null;
    await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; const m = buf.match(/READY:(.+)\n/); if (m) { dir = m[1]; resolve(); } });
      child.on('error', reject);
      child.on('close', () => reject(new Error('child exited before ready')));
    });
    assert.ok(fs.existsSync(dir), 'the temporary directory exists while the process runs');
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve(signal)));
    child.kill('SIGTERM');
    assert.equal(await closed, 'SIGTERM', 'the signal still takes its normal effect');
    assert.equal(fs.existsSync(dir), false, 'the directory was removed on SIGTERM');
  });

  test('rate limiting is bypassed only when test isolation is active, never by NODE_TEST_CONTEXT or a header alone', async () => {
    const probe = (isolated) => `
      ${isolated ? `import ${url('tests/support/isolation.js')};` : ''}
      import { rateLimit } from ${url('server/security.js')};
      const limiter = rateLimit({ windowMs: 60000, max: 1, keyFn: () => 'k' });
      const hit = (headers = {}) => { let code = 'passed'; limiter({ headers }, { setHeader() {}, status(c) { code = c; return this; }, json() {} }, () => {}); return code; };
      console.log('RESULT:' + JSON.stringify({ first: hit(), second: hit(), third: hit(), header1: hit({ 'x-test-rate-limit': '1' }), header2: hit({ 'x-test-rate-limit': '1' }) }));
    `;
    const env = cleanEnv({ NODE_TEST_CONTEXT: 'child-v8' });
    const plain = parseResult(runModule(probe(false), env));
    assert.deepEqual(plain, { first: 'passed', second: 429, third: 429, header1: 429, header2: 429 }, 'NODE_TEST_CONTEXT alone must not disable the limiter');
    const isolated = parseResult(runModule(probe(true), cleanEnv()));
    assert.deepEqual(isolated, { first: 'passed', second: 'passed', third: 'passed', header1: 'passed', header2: 429 }, 'under isolation the limiter is bypassed unless the test opts back in with the header');
  });

  test('running tests/api.test.js directly (without the preload) fails closed and touches nothing', { timeout: 180000 }, async () => {
    await withTempDir((fake) => {
      const real = makeCanaryDb(fake);
      const before = snapshotDir(fake);
      const out = spawnSync(process.execPath, [path.join(repoRoot, 'tests', 'api.test.js')], {
        cwd: repoRoot, env: hostile(fake), encoding: 'utf8', timeout: 170000
      });
      assert.notEqual(out.status, 0, 'a direct run without the preload must not succeed');
      if (fs.existsSync(path.join(repoRoot, 'node_modules'))) {
        // With dependencies installed the failure must be our guard, not an unrelated error.
        assert.match(out.stderr, /test isolation is not active/);
      }
      assert.deepEqual(snapshotDir(fake), before, 'the decoy database directory is unchanged');
      assert.equal(canaryCount(real), 1);
    });
  });
});

// ---------- structure ----------

describe('structure', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const rel = (f) => path.relative(repoRoot, f).split(path.sep).join('/');
  const serverFiles = walk(path.join(repoRoot, 'server')).filter((f) => f.endsWith('.js'));

  test('only the seed CLI can reach the manual-wipe grant, and no server code references the test grant', () => {
    const using = (needle) => serverFiles.filter((f) => fs.readFileSync(f, 'utf8').includes(needle)).map(rel).sort();
    assert.deepEqual(using('authorizeManualWipe'), ['server/guard.js', 'server/seed-cli.js']);
    assert.deepEqual(using('markDisposableTestTarget'), ['server/guard.js']);
    for (const f of serverFiles) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /import[^;\n]*seed-cli|import\(\s*['"][^'"]*seed-cli/, `${rel(f)} must not import the seed CLI`);
    }
  });

  test('modules that must stay side-effect free never import the database layer', () => {
    for (const f of ['server/guard.js', 'server/dblocation.js', 'server/seed-cli.js']) {
      const src = fs.readFileSync(path.join(repoRoot, f), 'utf8');
      const staticImports = src.split('\n').filter((l) => /^\s*import\s/.test(l));
      assert.ok(!staticImports.some((l) => /db\.js|seed\.js|auth\.js/.test(l)), `${f} must not statically import db.js, seed.js or auth.js`);
    }
    assert.ok(!fs.readFileSync(path.join(repoRoot, 'server', 'seed.js'), 'utf8').includes('process.argv'), 'seed.js has no command line of its own');
  });

  test('package.json scripts use the CLI and load the preload in every test process', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    assert.equal(scripts.seed, 'node server/seed-cli.js');
    assert.equal(scripts['seed:sandbox'], 'node server/seed-cli.js --sandbox');
    assert.match(scripts.test, /--import \.\/tests\/preload\.js/);
    assert.match(scripts.test, /--test/);
  });
});
