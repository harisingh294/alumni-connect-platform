// PostgreSQL migration runner for Alumni Connect Platform.
//
// Responsibilities:
// - Discovers migration files in db/migrations/ sorted by version number.
// - Handles initial empty database: checks for schema_migrations safely before querying it.
// - Executes each migration and its schema_migrations record in a single transaction.
// - Acquires and releases a PostgreSQL session advisory lock using the SAME dedicated client.
// - Releases the advisory lock and client in finally blocks even if an error occurs.
// - Supports dry-run and status checks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { resolveSslConfig } from './pg-backend.js';

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

// Safe 64-bit integer advisory lock key dedicated to migration execution.
// Prevents concurrent migration runs across application replicas during deployment.
export const MIGRATION_ADVISORY_LOCK_ID = 8820261115;

/**
 * Validates and parses a migration filename.
 * Expected pattern: NNN_name.sql (e.g. 001_init.sql, 002_sqlite_compat_functions.sql).
 */
export function parseMigrationFilename(filename) {
  if (typeof filename !== 'string') return null;
  const match = /^(\d{3,})_([a-zA-Z0-9_\-]+)\.sql$/.exec(filename);
  if (!match) return null;
  const version = parseInt(match[1], 10);
  if (!Number.isSafeInteger(version) || version <= 0) return null;
  const name = match[2];
  return { version, name, filename };
}

/**
 * Discovers, validates, and loads migration files from the specified directory.
 * Ignores non-sql files (e.g. README.md, .gitkeep).
 * Throws on invalid filenames, duplicate versions, or empty files.
 * Returns migration objects sorted by version ascending.
 */
export function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory does not exist: ${migrationsDir}`);
  }

  const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  const migrations = [];
  const seenVersions = new Map();

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const filename = entry.name;

    // Ignore non-sql files
    if (!filename.endsWith('.sql')) continue;

    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new Error(`Invalid migration filename "${filename}". Migration files must match pattern NNN_name.sql (e.g. 001_init.sql)`);
    }

    if (seenVersions.has(parsed.version)) {
      throw new Error(`Duplicate migration version ${parsed.version}: "${filename}" and "${seenVersions.get(parsed.version)}"`);
    }

    const filepath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filepath, 'utf8');
    if (!sql.trim()) {
      throw new Error(`Migration file "${filename}" is empty`);
    }

    seenVersions.set(parsed.version, filename);
    migrations.push({
      version: parsed.version,
      name: parsed.name,
      filename,
      filepath,
      sql
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

/**
 * Queries applied migration versions from schema_migrations.
 * Safely handles an initial empty database where schema_migrations does not exist yet.
 */
export async function getAppliedVersions(client) {
  const check = await client.query("SELECT to_regclass('schema_migrations') AS tbl");
  const exists = check.rows && check.rows.length > 0 && check.rows[0].tbl !== null;
  if (!exists) {
    return new Set();
  }

  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  return new Set((result.rows || []).map((r) => Number(r.version)));
}

/**
 * Executes a single migration file and records its version in schema_migrations
 * inside one atomic transaction.
 */
export async function applyMigration(client, migration, logger = console) {
  await client.query('BEGIN');
  try {
    // Multi-statement DDL executed via node-postgres simple query protocol (no parameters)
    await client.query(migration.sql);

    // Record the applied version in schema_migrations
    await client.query(
      'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      [migration.version, migration.name]
    );

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger?.warn?.(`[migrator] Rollback warning for ${migration.filename}: ${rollbackErr.message}`);
    }
    throw new Error(`Migration ${migration.filename} failed: ${err.message}`, { cause: err });
  }
}

/**
 * Resolves or establishes a dedicated PostgreSQL client connection based on provided options.
 */
async function resolveClient(options = {}) {
  let client;
  let shouldReleaseClient = false;
  let pool = null;
  let shouldEndPool = false;

  if (options.client) {
    client = options.client;
    shouldReleaseClient = false;
  } else if (options.pool) {
    pool = options.pool;
    client = await pool.connect();
    shouldReleaseClient = true;
  } else if (options.db) {
    if (options.db.kind !== 'postgres') {
      throw new TypeError(`PostgreSQL migration runner cannot run on database engine: '${options.db.kind}'`);
    }
    if (typeof options.db.connect === 'function') {
      client = await options.db.connect();
      shouldReleaseClient = true;
    } else if (options.db.pool && typeof options.db.pool.connect === 'function') {
      client = await options.db.pool.connect();
      shouldReleaseClient = true;
    } else {
      throw new Error('Database handle does not provide a connection method (.connect() or .pool.connect())');
    }
  } else {
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('runMigrations requires a client, pool, db, or connectionString/DATABASE_URL');
    }
    const ssl = resolveSslConfig(connectionString, options.ssl);
    pool = new Pool({
      connectionString,
      ssl,
      max: 2,
      connectionTimeoutMillis: 10000
    });
    shouldEndPool = true;
    client = await pool.connect();
    shouldReleaseClient = true;
  }

  return { client, shouldReleaseClient, pool, shouldEndPool };
}

/**
 * Runs pending PostgreSQL migrations in ascending version order.
 *
 * Options:
 * - client: an existing dedicated pg.Client
 * - pool: a pg.Pool
 * - db: application database facade (createDb)
 * - connectionString: PostgreSQL connection string
 * - migrationsDir: path to migrations directory (defaults to db/migrations)
 * - dryRun: boolean (if true, inspects and returns pending migrations without applying)
 * - logger: custom logger (defaults to console, null or { silent: true } to suppress)
 */
export async function runMigrations(options = {}) {
  const logger = options.silent ? null : (options.logger || console);
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const dryRun = Boolean(options.dryRun);

  const { client, shouldReleaseClient, pool, shouldEndPool } = await resolveClient(options);

  let lockAcquired = false;
  try {
    // 1. Acquire PostgreSQL session advisory lock on the dedicated client
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_ID]);
    lockAcquired = true;

    // 2. Load and validate migration files from disk
    const migrations = loadMigrations(migrationsDir);

    // 3. Query applied versions from database (safe empty DB check)
    const appliedVersions = await getAppliedVersions(client);

    // 4. Determine pending migrations
    const pending = migrations.filter((m) => !appliedVersions.has(m.version));

    if (pending.length === 0) {
      logger?.info?.('[migrator] Schema is up to date. No pending migrations.');
      return {
        applied: [],
        pending: [],
        alreadyApplied: Array.from(appliedVersions),
        dryRun
      };
    }

    if (dryRun) {
      logger?.info?.(`[migrator] DRY-RUN: ${pending.length} migration(s) pending: ${pending.map((m) => m.filename).join(', ')}`);
      return {
        applied: [],
        pending: pending.map((m) => ({ version: m.version, name: m.name, filename: m.filename })),
        alreadyApplied: Array.from(appliedVersions),
        dryRun: true
      };
    }

    logger?.info?.(`[migrator] Applying ${pending.length} pending migration(s)...`);

    // 5. Apply each pending migration sequentially in its own transaction
    const applied = [];
    for (const migration of pending) {
      const startMs = Date.now();
      logger?.info?.(`[migrator] Applying migration ${migration.filename}...`);

      await applyMigration(client, migration, logger);

      const durationMs = Date.now() - startMs;
      logger?.info?.(`[migrator] Applied migration ${migration.filename} in ${durationMs}ms`);
      applied.push({
        version: migration.version,
        name: migration.name,
        filename: migration.filename,
        durationMs
      });
    }

    return {
      applied,
      pending: [],
      alreadyApplied: Array.from(appliedVersions),
      dryRun: false
    };
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_ADVISORY_LOCK_ID]);
      } catch (unlockErr) {
        logger?.warn?.(`[migrator] Warning: failed to release advisory lock: ${unlockErr.message}`);
      }
    }
    if (shouldReleaseClient && typeof client.release === 'function') {
      client.release();
    }
    if (shouldEndPool && typeof pool?.end === 'function') {
      await pool.end();
    }
  }
}

/**
 * Read-only status inspector for migrations.
 */
export async function getMigrationStatus(options = {}) {
  const migrationsDir = options.migrationsDir || DEFAULT_MIGRATIONS_DIR;
  const { client, shouldReleaseClient, pool, shouldEndPool } = await resolveClient(options);

  try {
    const migrations = loadMigrations(migrationsDir);
    const appliedVersions = await getAppliedVersions(client);
    const pending = migrations.filter((m) => !appliedVersions.has(m.version));

    return {
      applied: Array.from(appliedVersions),
      pending: pending.map((m) => ({ version: m.version, name: m.name, filename: m.filename }))
    };
  } finally {
    if (shouldReleaseClient && typeof client.release === 'function') {
      client.release();
    }
    if (shouldEndPool && typeof pool?.end === 'function') {
      await pool.end();
    }
  }
}
