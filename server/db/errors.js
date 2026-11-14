// Classifies database errors from either engine (and from this facade) into one small vocabulary, so
// callers (for example the Express error handler, which today matches the text "UNIQUE constraint
// failed") do not depend on which database is behind the facade.
//
// Pure: no database access, no side effects.
//
// kind: 'unique' | 'foreign_key' | 'not_null' | 'check' | 'constraint'
//     | 'retryable' (serialization failure, deadlock)
//     | 'connection' (cannot reach, lost or refused by the server: includes network errors)
//     | 'timeout' (connect, query, lock or idle timeouts)
//     | 'auth' | 'tls' | 'other'
// driver: 'sqlite' | 'pg' | 'node' (system/network errno) | 'facade' | 'unknown'

// Errors thrown by the facade itself.
export class DbLockTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DbLockTimeoutError';
    this.code = 'DB_LOCK_TIMEOUT';
    Object.assign(this, details);
  }
}

export class TransactionClosedError extends Error {
  constructor(message = 'This transaction has already finished; it can no longer run statements') {
    super(message);
    this.name = 'TransactionClosedError';
    this.code = 'DB_TRANSACTION_CLOSED';
  }
}

// SQLite extended result codes seen from node:sqlite (err.errcode).
const SQLITE_BASE_CONSTRAINT = 19;
const SQLITE_EXTENDED = {
  1555: 'unique', // SQLITE_CONSTRAINT_PRIMARYKEY
  2067: 'unique', // SQLITE_CONSTRAINT_UNIQUE
  1299: 'not_null', // SQLITE_CONSTRAINT_NOTNULL
  275: 'check', // SQLITE_CONSTRAINT_CHECK
  787: 'foreign_key' // SQLITE_CONSTRAINT_FOREIGNKEY
};

// PostgreSQL SQLSTATE codes (err.code). These never start with the letter E, which keeps them apart
// from Node's system error codes (ECONNRESET, EPIPE, ...).
const PG_CODES = {
  '23505': 'unique',
  '23503': 'foreign_key',
  '23502': 'not_null',
  '23514': 'check',
  '40001': 'retryable', // serialization_failure
  '40P01': 'retryable', // deadlock_detected
  '28000': 'auth', // invalid_authorization_specification
  '28P01': 'auth', // invalid_password
  '57014': 'timeout', // query_canceled (also statement_timeout)
  '25P03': 'timeout', // idle_in_transaction_session_timeout
  '55P03': 'timeout', // lock_not_available (lock_timeout / NOWAIT)
  '53300': 'connection', // too_many_connections
  '57P01': 'connection', // admin_shutdown
  '57P02': 'connection', // crash_shutdown
  '57P03': 'connection' // cannot_connect_now (for example the server is starting up)
};

// Node system errors for sockets and name resolution.
const NODE_CODES = {
  ECONNRESET: 'connection',
  ECONNREFUSED: 'connection',
  ECONNABORTED: 'connection',
  EPIPE: 'connection',
  ENOTFOUND: 'connection',
  EAI_AGAIN: 'connection',
  EHOSTUNREACH: 'connection',
  ENETUNREACH: 'connection',
  ENETDOWN: 'connection',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout'
};
const NODE_CODE_SHAPE = /^E[A-Z0-9_]+$/; // any errno-style code, including ones not listed above
const TLS_CODE_SHAPE = /^(CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH)/;

// Plain-text errors the pg client raises without a code.
const MESSAGE_PATTERNS = [
  [/UNIQUE constraint failed/i, 'unique'],
  [/FOREIGN KEY constraint failed/i, 'foreign_key'],
  [/NOT NULL constraint failed/i, 'not_null'],
  [/CHECK constraint failed/i, 'check'],
  [/timeout exceeded when trying to connect/i, 'timeout'],
  [/connection timeout/i, 'timeout'],
  [/query read timeout/i, 'timeout'],
  [/canceling statement due to (statement|lock) timeout/i, 'timeout'],
  [/connection terminated/i, 'connection'],
  [/connection (?:ended|closed) unexpectedly/i, 'connection'],
  [/server closed the connection unexpectedly/i, 'connection'],
  [/terminating connection due to/i, 'connection'],
  [/client has encountered a connection error/i, 'connection'],
  [/client was closed and is not queryable/i, 'connection']
];

const result = (kind, driver, constraint = null) => ({ kind, driver, constraint });

export function classifyDbError(err, depth = 0) {
  if (!err || typeof err !== 'object') return result('other', 'unknown');
  const message = String(err.message || '');
  const code = err.code;

  // This facade's own errors.
  if (code === 'DB_LOCK_TIMEOUT') return result('timeout', 'facade');
  if (code === 'DB_TRANSACTION_CLOSED') return result('other', 'facade');

  // node:sqlite
  if (code === 'ERR_SQLITE_ERROR') {
    let kind = 'other';
    if (typeof err.errcode === 'number') {
      if (SQLITE_EXTENDED[err.errcode]) kind = SQLITE_EXTENDED[err.errcode];
      else if ((err.errcode & 0xff) === SQLITE_BASE_CONSTRAINT) kind = 'constraint';
    }
    if (kind === 'other') {
      for (const [pattern, k] of MESSAGE_PATTERNS) if (pattern.test(message)) { kind = k; break; }
    }
    const detail = /constraint failed:\s*(.+)$/i.exec(message);
    return result(kind, 'sqlite', detail ? detail[1].trim() : null);
  }

  if (typeof code === 'string') {
    // TLS certificate problems: not retryable without a configuration change.
    if (TLS_CODE_SHAPE.test(code)) return result('tls', 'node');
    // Node system and network errors, listed or not.
    if (NODE_CODE_SHAPE.test(code)) return result(NODE_CODES[code] || 'other', 'node');
    // PostgreSQL SQLSTATE: five characters, digits and capitals.
    if (/^[0-9A-Z]{5}$/.test(code)) {
      let kind = PG_CODES[code] || 'other';
      if (kind === 'other' && code.startsWith('23')) kind = 'constraint';
      if (kind === 'other' && code.startsWith('08')) kind = 'connection';
      return result(kind, 'pg', err.constraint || null);
    }
  }

  // Text patterns (the pg client raises several connection problems with no code at all).
  for (const [pattern, kind] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return result(kind, 'unknown');
  }

  // Wrapped errors, for example AggregateError or `new Error('...', { cause })`.
  if (depth < 3) {
    const inner = err.cause ?? (Array.isArray(err.errors) ? err.errors[0] : null);
    if (inner && inner !== err) {
      const found = classifyDbError(inner, depth + 1);
      if (found.kind !== 'other') return found;
    }
  }
  return result('other', 'unknown');
}

export const isUniqueViolation = (err) => classifyDbError(err).kind === 'unique';

// True when trying again, possibly after a short wait, may succeed. Never true for constraint, auth or TLS errors.
export const isRetryableDbError = (err) => ['retryable', 'connection', 'timeout'].includes(classifyDbError(err).kind);
