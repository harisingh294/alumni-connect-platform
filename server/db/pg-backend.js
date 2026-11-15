// PostgreSQL async backend implementation using pg.Pool.
//
// Conforms to the backend contract expected by server/db/index.js (createDb):
//   get(sql, params)   -> Promise<row | undefined>
//   all(sql, params)   -> Promise<row[]>
//   run(sql, params)   -> Promise<{ changes }>
//   query(sql, params) -> Promise<{ rows, rowCount }>
//   exec(sql)          -> Promise<void>
//   transaction(fn)    -> Promise<result of fn>
//   diagnostics()      -> { kind: 'postgres', pool: { total, idle, waiting } }
//   close()            -> Promise<void>
//
// Safe pooling configuration:
//   max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000.
//
// Safe type parsers:
//   INT8 (20) parsed to Number when safe, BigInt when outside safe bounds.
//   NUMERIC (1700) parsed to Number when safe, raw string when precision would be lost.
//
// Neon SSL support:
//   Enforces certificate verification ({ rejectUnauthorized: true }) without weakening security.
//
// Testable / Mockable:
//   Accepts an injected pool in options.pool for isolated unit testing without a real database.

import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { translatePlaceholders, translateSqlForPostgres } from './sql.js';
import { classifyDbError, TransactionClosedError } from './errors.js';
import { stripInternalColumns } from './internal-columns.js';

const { Pool, types } = pg;

export const DEFAULT_POOL_CONFIG = Object.freeze({
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// Safe parsing for 64-bit BIGINT integers (PostgreSQL OID 20).
// Preserves precision: returns Number if within [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
// otherwise returns BigInt.
export function parseBigInt(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  const num = Number(str);
  if (Number.isSafeInteger(num)) return num;
  try {
    return BigInt(str);
  } catch {
    return str;
  }
}

// Safe parsing for arbitrary precision NUMERIC / DECIMAL (PostgreSQL OID 1700).
// Returns Number if the conversion does not lose precision, otherwise preserves the exact string.
export function parseNumeric(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).trim();
  const num = Number(str);
  if (!Number.isFinite(num)) return str;

  // Check integer part bounds
  const intPart = str.split('.')[0].replace(/^[+-]/, '');
  if (intPart.length > 15) {
    try {
      const b = BigInt(str.split('.')[0]);
      if (b < BigInt(Number.MIN_SAFE_INTEGER) || b > BigInt(Number.MAX_SAFE_INTEGER)) {
        return str;
      }
    } catch {
      return str;
    }
  }

  // Check whether float representation matches original text (accounting for trailing zeroes)
  const normalizedStr = str.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  if (String(num) === str || String(num) === normalizedStr) {
    return num;
  }
  return str;
}

let parsersConfigured = false;
export function configureTypeParsers(typesRegistry = types) {
  if (parsersConfigured && typesRegistry === types) return;
  if (!typesRegistry || typeof typesRegistry.setTypeParser !== 'function') return;

  typesRegistry.setTypeParser(20, parseBigInt); // INT8 / BIGINT
  typesRegistry.setTypeParser(1700, parseNumeric); // NUMERIC / DECIMAL
  if (typesRegistry === types) parsersConfigured = true;
}

// Automatically configure global pg types on import
configureTypeParsers();

// Resolves SSL configuration for Neon and PostgreSQL cloud providers.
// Never sets rejectUnauthorized: false.
export function resolveSslConfig(connectionString, userSsl) {
  if (userSsl !== undefined) return userSsl;
  if (!connectionString || typeof connectionString !== 'string') return undefined;

  const isNeon = /neon\.tech/i.test(connectionString);
  const requiresSsl = /[?&]sslmode=(?:require|verify-ca|verify-full)\b/i.test(connectionString)
    || /[?&]ssl=true\b/i.test(connectionString);

  if (isNeon || requiresSsl) {
    return { rejectUnauthorized: true };
  }
  return undefined;
}

// Prepares SQL for PostgreSQL execution:
// 1. Applies dialect translation (datetime, date, rowid, current_role).
// 2. Translates `?` placeholders to `$1, $2, ...` if present.
export function prepareSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) {
    throw new TypeError('SQL must be a non-empty string');
  }
  const translated = translateSqlForPostgres(sql);
  if (translated.includes('?')) {
    return translatePlaceholders(translated).text;
  }
  return translated;
}

export function createPgBackend(options = {}) {
  const context = new AsyncLocalStorage();
  let pool;
  let ownsPool = false;
  let closed = false;

  if (options.pool) {
    pool = options.pool;
  } else {
    const connectionString = options.connectionString || process.env.DATABASE_URL;
    const ssl = resolveSslConfig(connectionString, options.ssl);
    const poolConfig = {
      ...DEFAULT_POOL_CONFIG,
      ...options,
      connectionString,
      ssl
    };
    pool = new Pool(poolConfig);
    ownsPool = true;
  }

  if (typeof pool.on === 'function') {
    pool.on('error', (err) => {
      // Prevent idle client errors from crashing the process
      const classified = classifyDbError(err);
      if (typeof options.onError === 'function') {
        options.onError(err, classified);
      }
    });
  }

  // Wraps an underlying result, applying internal column filtering if field metadata is present
  function resolveFieldMetadata(rawFields) {
    if (!rawFields || !Array.isArray(rawFields)) return null;
    return rawFields.map((f) => {
      if (f.table && f.column) return f;
      if (typeof options.resolveField === 'function') return options.resolveField(f);
      if (options.tableOidMap instanceof Map || (options.tableOidMap && typeof options.tableOidMap.get === 'function')) {
        const tableName = options.tableOidMap.get(f.tableID);
        const columnName = options.columnOidMap ? options.columnOidMap.get(`${f.tableID}.${f.columnID}`) : f.name;
        return { name: f.name, table: tableName, column: columnName };
      }
      return f;
    });
  }

  function formatResult(res) {
    const rawRows = (res.rows || []).map((row) => ({ ...row }));
    const resolvedFields = res.fields ? resolveFieldMetadata(res.fields) : null;
    const rows = resolvedFields ? stripInternalColumns(rawRows, resolvedFields) : rawRows;
    const rowCount = typeof res.rowCount === 'number' ? res.rowCount : rows.length;
    return { rows, rowCount };
  }

  const ops = {
    async query(sql, params = []) {
      const prepared = prepareSql(sql);
      const res = await pool.query(prepared, params);
      return formatResult(res);
    },
    async run(sql, params = []) {
      const prepared = prepareSql(sql);
      const res = await pool.query(prepared, params);
      return { changes: typeof res.rowCount === 'number' ? res.rowCount : 0 };
    },
    async get(sql, params = []) {
      const { rows } = await this.query(sql, params);
      return rows.length > 0 ? rows[0] : undefined;
    },
    async all(sql, params = []) {
      const { rows } = await this.query(sql, params);
      return rows;
    },
    async exec(sql) {
      if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL must be a non-empty string');
      await pool.query(sql);
    }
  };

  // Transaction handle handed to fn(tx)
  function transactionOps(handle) {
    const assertOpen = () => {
      if (handle.finished) throw new TransactionClosedError();
    };

    return {
      assertOpen,
      async query(sql, params = []) {
        assertOpen();
        const prepared = prepareSql(sql);
        const res = await handle.client.query(prepared, params);
        return formatResult(res);
      },
      async run(sql, params = []) {
        assertOpen();
        const prepared = prepareSql(sql);
        const res = await handle.client.query(prepared, params);
        return { changes: typeof res.rowCount === 'number' ? res.rowCount : 0 };
      },
      async get(sql, params = []) {
        const { rows } = await this.query(sql, params);
        return rows.length > 0 ? rows[0] : undefined;
      },
      async all(sql, params = []) {
        const { rows } = await this.query(sql, params);
        return rows;
      },
      async exec(sql) {
        assertOpen();
        if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL must be a non-empty string');
        await handle.client.query(sql);
      }
    };
  }

  async function transaction(fn) {
    // Nested transaction: join active outer transaction
    const activeTx = context.getStore();
    if (activeTx && !activeTx.finished) {
      return fn(activeTx.ops);
    }

    // Checkout dedicated single client from pool for the transaction
    const client = await pool.connect();
    const handle = {
      finished: false,
      client,
      startedAt: Date.now()
    };
    handle.ops = transactionOps(handle);

    try {
      await client.query('BEGIN');
      try {
        const result = await context.run(handle, () => fn(handle.ops));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback failure if connection was lost
        }
        throw err;
      }
    } finally {
      handle.finished = true;
      if (typeof client.release === 'function') {
        client.release();
      }
    }
  }

  // When called outside transaction, if AsyncLocalStorage has an active transaction,
  // route operations to that transaction client automatically
  const dispatch = (name) => async (...args) => {
    const activeTx = context.getStore();
    if (activeTx && !activeTx.finished) {
      return activeTx.ops[name](...args);
    }
    return ops[name](...args);
  };

  const backendObj = {
    kind: 'postgres',
    get: dispatch('get'),
    all: dispatch('all'),
    run: dispatch('run'),
    query: dispatch('query'),
    exec: dispatch('exec'),
    transaction,
    diagnostics() {
      return {
        kind: 'postgres',
        pool: {
          totalCount: pool.totalCount ?? 0,
          idleCount: pool.idleCount ?? 0,
          waitingCount: pool.waitingCount ?? 0
        }
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (ownsPool && typeof pool.end === 'function') {
        await pool.end();
      } else if (options.closeInjectedPool && typeof pool.end === 'function') {
        await pool.end();
      }
    }
  };

  Object.defineProperties(backendObj, {
    pool: { value: pool, writable: true, configurable: true, enumerable: false },
    connect: { value: () => pool.connect(), writable: true, configurable: true, enumerable: false }
  });

  return backendObj;
}
