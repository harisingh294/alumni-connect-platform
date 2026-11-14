// Safety guard for destructive database operations (dropping tables, full seed) and for the
// seed CLI's confirmations.
//
// Model: destructive functions require an opaque CAPABILITY object. Capabilities cannot be forged
// (they are tracked in a module-private WeakMap) and are bound to one exact database file.
// There is no ambient "this path is allowed" state.
//
// Two ways to obtain a capability:
//   1. authorizeManualWipe(dbPath): only valid when the running process IS the seed CLI
//      (server/seed-cli.js) and its real command line carries --confirm-wipe=<exact resolved path>.
//      The confirmation is read from process.argv, never passed in as a parameter, so ordinary
//      application code inside the web server cannot grant itself a wipe.
//   2. markDisposableTestTarget({ dir, dbPath }): only valid for a brand-new, empty
//      alumni-connect-test-* directory in the OS temp folder outside this repository.
//      It can never authorize a real database. Production images do not ship the tests that call it.
// Production (NODE_ENV=production or RENDER=true) refuses all of it, at grant time and at use time.
//
// HONEST LIMIT: this is in-process JavaScript. Any module can import this file, mutate
// process.argv or process.env, or edit this code. The design makes accidental and casual misuse
// fail loudly and makes deliberate misuse require tampering; it cannot make misuse impossible.
//
// This module must not import ./db.js (db.js imports this module) and must have no import-time I/O.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DISPOSABLE_MARKER = '.alumni-connect-disposable';
export const TEST_DIR_PREFIX = 'alumni-connect-test-';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverDir, '..');
const cliScript = path.join(serverDir, 'seed-cli.js');

const pathKey = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// Production hosting signals. Used only to REFUSE, never to allow.
export function isProductionEnvironment(env = process.env) {
  return env.NODE_ENV === 'production' || env.RENDER === 'true';
}

// Absolute path with symlinks resolved. Works for a file that does not exist yet.
export function resolveTarget(p) {
  const abs = path.resolve(String(p));
  try {
    return fs.realpathSync.native(abs);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

export function isInside(child, parent) {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function refuseProduction(action) {
  throw new Error(`Refusing to ${action}: this is a production environment. Destructive database operations are disabled in production and this cannot be overridden.`);
}

const flagValue = (args, name) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
};

const sameExactPath = (given, target) => path.isAbsolute(given) && pathKey(resolveTarget(given)) === pathKey(target);

/**
 * Builds a guard bound to a source of environment and command-line arguments.
 * The default instance (exported below) reads the real process; tests build their own instances.
 */
export function createGuard({ getEnv = () => process.env, getArgv = () => process.argv } = {}) {
  const capInfo = new WeakMap(); // opaque capability -> { kind, target, dir?, token? }
  const closers = new Set();
  let active = null; // the test isolation registered for this process, if any

  const production = () => isProductionEnvironment(getEnv());

  function newCapability(info) {
    const cap = Object.freeze(Object.create(null));
    capInfo.set(cap, info);
    return cap;
  }

  // CLI confirmation for a full wipe. Pure: touches no database. Throws unless confirmed exactly.
  function validateWipeConfirmation(dbPath, args) {
    if (production()) refuseProduction('wipe the database');
    const target = resolveTarget(dbPath);
    const hint = `Target database: ${target}\nTo wipe exactly this database, re-run with --confirm-wipe=<that exact path>.`;
    const given = flagValue(args, '--confirm-wipe');
    if (!given) throw new Error(`Refusing to wipe the database: no confirmation given.\n${hint}`);
    if (!sameExactPath(given, target)) throw new Error(`Refusing to wipe the database: the confirmation does not match the target.\n${hint}`);
    return target;
  }

  // CLI confirmation for the sandbox seed. It adds fictional institutions, accounts and activity
  // rows, so it is never silent: it needs the exact path, and in production it also needs the
  // explicit SANDBOX=on opt-in that the deployment already uses for the reviewer sandbox.
  function validateSandboxConfirmation(dbPath, args) {
    const target = resolveTarget(dbPath);
    const hint = `Target database: ${target}\nThis adds FICTIONAL institutions, accounts and activity data to it. To proceed, re-run with --confirm-sandbox=<that exact path>.`;
    if (production() && getEnv().SANDBOX !== 'on') {
      throw new Error(`Refusing to seed the sandbox: this is a production environment and SANDBOX=on is not set, so fictional data will not be added.\n${hint}`);
    }
    const given = flagValue(args, '--confirm-sandbox');
    if (!given) throw new Error(`Refusing to seed the sandbox: no confirmation given.\n${hint}`);
    if (!sameExactPath(given, target)) throw new Error(`Refusing to seed the sandbox: the confirmation does not match the target.\n${hint}`);
    return target;
  }

  // Capability for a manual wipe. Valid only inside the seed CLI process, with the confirmation
  // taken from that process's real command line.
  function authorizeManualWipe(dbPath) {
    if (production()) refuseProduction('wipe the database');
    const argv = getArgv();
    if (pathKey(resolveTarget(argv[1] || '')) !== pathKey(resolveTarget(cliScript))) {
      throw new Error('Refusing to wipe the database: only the seed CLI (server/seed-cli.js) can authorize a manual wipe.');
    }
    const target = validateWipeConfirmation(dbPath, argv.slice(2));
    return newCapability({ kind: 'manual', target });
  }

  /**
   * Capability for one database file created fresh for a test run.
   * Proof of "disposable": the directory was created empty a moment ago inside the OS temp folder
   * (outside this repository), has the expected prefix, and holds a random marker only this
   * guard instance knows. With activate: true it also becomes this process's test isolation.
   */
  function markDisposableTestTarget({ dir, dbPath, activate = false }) {
    if (production()) refuseProduction('register a disposable test database');
    const tmpRoot = resolveTarget(os.tmpdir());
    const dirReal = resolveTarget(dir);
    const dbReal = resolveTarget(dbPath);
    if (!isInside(dirReal, tmpRoot)) throw new Error(`Refusing test database: ${dirReal} is not inside the OS temp directory.`);
    if (isInside(dirReal, repoRoot) || pathKey(dirReal) === pathKey(repoRoot)) throw new Error(`Refusing test database: ${dirReal} is inside the repository.`);
    if (!path.basename(dirReal).startsWith(TEST_DIR_PREFIX)) throw new Error('Refusing test database: unexpected directory name.');
    if (pathKey(path.dirname(dbReal)) !== pathKey(dirReal)) throw new Error('Refusing test database: the database file must sit directly in the test directory.');
    if (fs.readdirSync(dirReal).length !== 0) throw new Error('Refusing test database: the test directory must be empty when registered.');
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(path.join(dirReal, DISPOSABLE_MARKER), token, { mode: 0o600 });
    const cap = newCapability({ kind: 'test', target: dbReal, dir: dirReal, token });
    if (activate) active = { dataDir: dirReal, dbFile: path.basename(dbReal), dbPath: dbReal };
    return cap;
  }

  /**
   * Throws unless `capability` authorizes a destructive operation on exactly dbPath, right now.
   * Must run before any destructive SQL.
   */
  function assertDestructiveAllowed(dbPath, action, capability) {
    if (production()) refuseProduction(action);
    const target = resolveTarget(dbPath);
    const info = capability !== null && typeof capability === 'object' ? capInfo.get(capability) : undefined;
    if (!info) {
      throw new Error(`Refusing to ${action} on ${target}: no valid authorization was provided. A wipe must be requested through the seed CLI with --confirm-wipe=<exact path>.`);
    }
    if (pathKey(info.target) !== pathKey(target)) {
      throw new Error(`Refusing to ${action} on ${target}: the authorization is for a different database.`);
    }
    if (info.kind === 'test') {
      // Re-verify at the moment of use, not only at registration.
      let marker = null;
      try { marker = fs.readFileSync(path.join(info.dir, DISPOSABLE_MARKER), 'utf8'); } catch { /* handled below */ }
      const stillSafe = marker === info.token
        && pathKey(path.dirname(target)) === pathKey(info.dir)
        && isInside(info.dir, resolveTarget(os.tmpdir()))
        && !isInside(info.dir, repoRoot);
      if (!stillSafe) throw new Error(`Refusing to ${action} on ${target}: the test database marker is missing or the location is no longer safe.`);
    }
  }

  return {
    validateWipeConfirmation,
    validateSandboxConfirmation,
    authorizeManualWipe,
    markDisposableTestTarget,
    assertDestructiveAllowed,
    isTestIsolationActive: () => active !== null,
    getTestLocation: () => (active ? { ...active } : null),
    registerCloser: (fn) => { closers.add(fn); },
    closeAll: () => { for (const fn of [...closers]) { try { fn(); } catch { /* already closed */ } } }
  };
}

const defaultGuard = createGuard();
export const {
  validateWipeConfirmation,
  validateSandboxConfirmation,
  authorizeManualWipe,
  markDisposableTestTarget,
  assertDestructiveAllowed,
  isTestIsolationActive,
  getTestLocation,
  registerCloser,
  closeAll
} = defaultGuard;
