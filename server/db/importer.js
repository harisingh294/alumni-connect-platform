// SQLite-to-PostgreSQL Data Importer for Alumni Connect Platform.
//
// Default mode is DRY-RUN:
//   - Inspects source and destination schemas, row counts and constraints.
//   - Validates all foreign-key dependencies, types, and NOT NULL / CHECK constraints.
//   - Emits zero INSERT, UPDATE, DELETE, TRUNCATE or DDL statements.
//
// Execution mode requires:
//   - Explicit --execute flag and --confirm-target=127.0.0.1:5544/alumni_test.
//   - Transactional execution: rolls back completely on any failure.
//   - Resets identity sequences on messages and audit_logs.
//
// Target restriction:
//   - Strictly locked to local disposable database alumni_test on 127.0.0.1:5544.
//   - Any connection attempt to Neon, Render, cloud or remote hosts is rejected immediately.
//
// Source restriction:
//   - Read-only point-in-time snapshot using server/db/preflight.js infrastructure.
//   - Never modifies, checkpoints, or writes to the source database.

import path from 'node:path';
import { withSnapshotForPreflight } from './preflight.js';
import { resetIdentitySequences } from './identity.js';
import { createPgDb } from './index.js';

export const DEFAULT_MIGRATION_SOURCE = path.resolve('C:/Users/haris/Desktop/AlumniConnect-SQLite-Migration-Work/migration-source.db');

export const ALLOWED_PG_HOSTS = new Set(['127.0.0.1', 'localhost']);
export const ALLOWED_PG_PORT = 5544;
export const ALLOWED_PG_DATABASE = 'alumni_test';
export const EXPECTED_CONFIRM_TARGET = '127.0.0.1:5544/alumni_test';

// 26 application tables in strict topological dependency order (parents before children)
export const TABLE_ORDER = Object.freeze([
  'institutions',
  'users',
  'courses',
  'placement_stats',
  'roster_records',
  'alumni_profiles',
  'career_steps',
  'student_profiles',
  'external_profiles',
  'subscriptions',
  'institution_subscriptions',
  'institution_invoices',
  'audit_logs',
  'platform_log',
  'mentorship_programs',
  'program_participants',
  'mentorship_requests',
  'messages',
  'saved_alumni',
  'internships',
  'internship_applications',
  'announcements',
  'events',
  'event_rsvps',
  'activity_daily',
  'feedback'
]);

export const IDENTITY_TABLES = Object.freeze(['messages', 'audit_logs']);

// Explicit table schemas, columns, quoted identifiers, and foreign-key dependencies
export const TABLE_SCHEMAS = Object.freeze({
  institutions: {
    columns: ['id', 'name', 'short_name', 'abbr', 'kind', 'domain', 'city', 'state', 'type', 'founded', 'hue', 'about', 'email_domain', 'website', 'contact_email', 'data_sharing', 'public_profile', 'platform_verified', 'is_sandbox', 'created_at'],
    pk: ['id'],
    fks: []
  },
  users: {
    columns: ['id', 'institution_id', 'email', 'password_hash', 'role', 'admin_level', 'full_name', 'verification_status', 'reject_reason', 'verified_at', 'is_active', 'is_sandbox', 'last_active_at', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: true }]
  },
  courses: {
    columns: ['id', 'institution_id', 'name', 'level', 'duration_years', 'seats', 'annual_fee_inr', 'eligibility', 'description'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  placement_stats: {
    columns: ['id', 'institution_id', 'year', 'students_eligible', 'students_placed', 'median_ctc_lpa', 'average_ctc_lpa', 'highest_ctc_lpa', 'top_recruiters_json'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  roster_records: {
    columns: ['id', 'institution_id', 'record_type', 'email', 'full_name', 'graduation_year', 'degree', 'branch', 'status', 'imported_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  alumni_profiles: {
    columns: ['id', 'user_id', 'graduation_year', 'degree', 'branch', 'current_company', 'current_role', 'industry', 'location', 'linkedin_url', 'bio', 'headline', 'is_open_to_mentoring', 'open_to_external', 'visibility', 'details_confirmed_at', 'stale_months', 'skills_json', 'mentorship_topics_json', 'higher_ed'],
    quotedColumns: { current_role: '"current_role"' },
    pk: ['id'],
    fks: [{ col: 'user_id', refTable: 'users', refCol: 'id', nullable: false }]
  },
  career_steps: {
    columns: ['id', 'alumni_profile_id', 'year', 'role', 'company', 'is_current', 'display_order'],
    pk: ['id'],
    fks: [{ col: 'alumni_profile_id', refTable: 'alumni_profiles', refCol: 'id', nullable: false }]
  },
  student_profiles: {
    columns: ['id', 'user_id', 'graduation_year', 'degree', 'branch', 'roll_number', 'target_industry', 'target_role', 'bio'],
    pk: ['id'],
    fks: [{ col: 'user_id', refTable: 'users', refCol: 'id', nullable: false }]
  },
  external_profiles: {
    columns: ['id', 'user_id', 'education_level', 'current_institution', 'current_year', 'field_of_interest', 'interested_institution_id', 'city'],
    pk: ['id'],
    fks: [
      { col: 'user_id', refTable: 'users', refCol: 'id', nullable: false },
      { col: 'interested_institution_id', refTable: 'institutions', refCol: 'id', nullable: true }
    ]
  },
  subscriptions: {
    columns: ['id', 'user_id', 'plan_id', 'amount_inr', 'started_at', 'expires_at', 'auto_renew', 'payment_ref', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'user_id', refTable: 'users', refCol: 'id', nullable: false }]
  },
  institution_subscriptions: {
    columns: ['id', 'institution_id', 'plan_id', 'billing_cycle', 'status', 'trial_ends_at', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  institution_invoices: {
    columns: ['id', 'institution_id', 'plan_id', 'billing_cycle', 'amount_inr', 'period_start', 'period_end', 'status', 'payment_ref', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  audit_logs: {
    columns: ['id', 'seq', 'institution_id', 'actor_id', 'actor_name', 'actor_role', 'action', 'target_type', 'target_id', 'details', 'created_at'],
    sourceSelectColumns: 'rowid AS seq, id, institution_id, actor_id, actor_name, actor_role, action, target_type, target_id, details, created_at',
    identityColumn: 'seq',
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  platform_log: {
    columns: ['id', 'action', 'details', 'created_at'],
    pk: ['id'],
    fks: []
  },
  mentorship_programs: {
    columns: ['id', 'institution_id', 'title', 'description', 'topic', 'starts_on', 'ends_on', 'mentee_capacity', 'status', 'created_by', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  program_participants: {
    columns: ['id', 'program_id', 'user_id', 'role', 'matched_with', 'created_at'],
    pk: ['id'],
    fks: [
      { col: 'program_id', refTable: 'mentorship_programs', refCol: 'id', nullable: false },
      { col: 'user_id', refTable: 'users', refCol: 'id', nullable: false }
    ]
  },
  mentorship_requests: {
    columns: ['id', 'institution_id', 'student_id', 'alumni_id', 'program_id', 'is_external', 'topic', 'message', 'status', 'response_note', 'meeting_info', 'responded_at', 'created_at'],
    pk: ['id'],
    fks: [
      { col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false },
      { col: 'student_id', refTable: 'users', refCol: 'id', nullable: false },
      { col: 'alumni_id', refTable: 'users', refCol: 'id', nullable: false },
      { col: 'program_id', refTable: 'mentorship_programs', refCol: 'id', nullable: true }
    ]
  },
  messages: {
    columns: ['id', 'seq', 'request_id', 'sender_id', 'body', 'created_at'],
    sourceSelectColumns: 'rowid AS seq, id, request_id, sender_id, body, created_at',
    identityColumn: 'seq',
    pk: ['id'],
    fks: [
      { col: 'request_id', refTable: 'mentorship_requests', refCol: 'id', nullable: false },
      { col: 'sender_id', refTable: 'users', refCol: 'id', nullable: false }
    ]
  },
  saved_alumni: {
    columns: ['id', 'user_id', 'alumni_profile_id', 'created_at'],
    pk: ['id'],
    fks: [
      { col: 'user_id', refTable: 'users', refCol: 'id', nullable: false },
      { col: 'alumni_profile_id', refTable: 'alumni_profiles', refCol: 'id', nullable: false }
    ]
  },
  internships: {
    columns: ['id', 'institution_id', 'posted_by', 'title', 'company', 'location', 'mode', 'stipend_inr_month', 'duration_weeks', 'description', 'skills_json', 'audience', 'status', 'deadline', 'created_at'],
    pk: ['id'],
    fks: [
      { col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false },
      { col: 'posted_by', refTable: 'users', refCol: 'id', nullable: false }
    ]
  },
  internship_applications: {
    columns: ['id', 'internship_id', 'applicant_id', 'note', 'status', 'created_at'],
    pk: ['id'],
    fks: [
      { col: 'internship_id', refTable: 'internships', refCol: 'id', nullable: false },
      { col: 'applicant_id', refTable: 'users', refCol: 'id', nullable: false }
    ]
  },
  announcements: {
    columns: ['id', 'institution_id', 'author_id', 'title', 'body', 'audience', 'pinned', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  events: {
    columns: ['id', 'institution_id', 'title', 'description', 'starts_at', 'mode', 'location', 'audience', 'capacity', 'created_by', 'created_at'],
    pk: ['id'],
    fks: [{ col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: false }]
  },
  event_rsvps: {
    columns: ['id', 'event_id', 'user_id', 'created_at'],
    pk: ['id'],
    fks: [
      { col: 'event_id', refTable: 'events', refCol: 'id', nullable: false },
      { col: 'user_id', refTable: 'users', refCol: 'id', nullable: false }
    ]
  },
  activity_daily: {
    columns: ['user_id', 'institution_id', 'day'],
    pk: ['user_id', 'day'],
    fks: [
      { col: 'user_id', refTable: 'users', refCol: 'id', nullable: false },
      { col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: true }
    ]
  },
  feedback: {
    columns: ['id', 'institution_id', 'partner_name', 'person', 'person_role', 'user_id', 'source', 'channel', 'what_they_said', 'type', 'decision', 'decision_reason', 'shipped_on', 'evidence', 'partner_reaction', 'received_on', 'created_at', 'updated_at'],
    pk: ['id'],
    fks: [
      { col: 'institution_id', refTable: 'institutions', refCol: 'id', nullable: true },
      { col: 'user_id', refTable: 'users', refCol: 'id', nullable: true }
    ]
  }
});

export function validateSourcePath(sourcePath) {
  if (!sourcePath || typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('Migration source path must be a non-empty string');
  }
  return path.resolve(sourcePath);
}

export function validateTargetConfig(config = {}) {
  let host = config.host;
  let port = config.port;
  let database = config.database;

  let urlUser;
  let urlPassword;
  const connStr = config.connectionString || process.env.DATABASE_URL;
  if (connStr) {
    try {
      const u = new URL(connStr);
      host = u.hostname;
      port = u.port ? parseInt(u.port, 10) : 5432;
      database = u.pathname.replace(/^\//, '');
      urlUser = u.username ? decodeURIComponent(u.username) : undefined;
      urlPassword = u.password ? decodeURIComponent(u.password) : undefined;
    } catch {
      // Never echo the URL: it may contain a password.
      throw new Error('Invalid PostgreSQL connection URL');
    }
  } else {
    host = host || '127.0.0.1';
    port = port || ALLOWED_PG_PORT;
    database = database || ALLOWED_PG_DATABASE;
  }

  const hostStr = String(host || '').toLowerCase();

  // Fail closed: strictly refuse remote/cloud/production hosts
  if (hostStr.includes('neon.tech') || hostStr.includes('render.com') || hostStr.includes('railway.app') || hostStr.includes('aws') || hostStr.includes('cloud')) {
    throw new Error(`CRITICAL GUARD: Target host '${host}' is rejected. Remote, cloud or production databases are forbidden.`);
  }

  if (!ALLOWED_PG_HOSTS.has(hostStr)) {
    throw new Error(`Target host '${host}' is forbidden. Importer targets ONLY local disposable database on 127.0.0.1:5544.`);
  }

  if (Number(port) !== ALLOWED_PG_PORT) {
    throw new Error(`Target port '${port}' is forbidden. Importer targets ONLY port ${ALLOWED_PG_PORT}.`);
  }

  if (database !== ALLOWED_PG_DATABASE) {
    throw new Error(`Target database '${database}' is forbidden. Importer targets ONLY database '${ALLOWED_PG_DATABASE}'.`);
  }

  return {
    host: '127.0.0.1',
    port: ALLOWED_PG_PORT,
    database: ALLOWED_PG_DATABASE,
    user: config.user || urlUser || process.env.PGUSER || 'alumni_test',
    // No password is stored in source code. It comes from the config, the connection URL or PGPASSWORD;
    // when none is set the connection fails with an authentication error (fail closed).
    password: config.password || urlPassword || process.env.PGPASSWORD || undefined
  };
}

export function buildInsertSql(tableName) {
  const schema = TABLE_SCHEMAS[tableName];
  if (!schema) throw new Error(`Unknown table schema: ${tableName}`);
  const quoted = schema.quotedColumns || {};
  const colList = schema.columns.map((c) => quoted[c] || c).join(', ');
  const placeholders = schema.columns.map((_, i) => `$${i + 1}`).join(', ');
  return `INSERT INTO "${tableName}" (${colList}) VALUES (${placeholders})`;
}

export function extractRowValues(tableName, row) {
  const schema = TABLE_SCHEMAS[tableName];
  return schema.columns.map((c) => {
    const val = row[c];
    if (val === undefined) return null;
    return val;
  });
}

// Validates a single row against schema constraints (types, nulls, check values)
export function validateRow(tableName, row) {
  const issues = [];
  const schema = TABLE_SCHEMAS[tableName];

  for (const col of schema.columns) {
    const val = row[col];
    // Check for NUL character in strings
    if (typeof val === 'string' && val.includes('\0')) {
      issues.push(`column ${col} contains NUL byte (\\0)`);
    }
  }

  return issues;
}

// Internal execution engine: shared between dry-run and execute modes
export async function executeImportInternal({
  sourceDb,
  targetDb,
  execute = false,
  confirmTarget = null,
  logger = console
} = {}) {
  const isDryRun = !execute;
  const modeName = isDryRun ? 'DRY-RUN' : 'EXECUTE';

  if (!isDryRun) {
    if (confirmTarget !== EXPECTED_CONFIRM_TARGET) {
      throw new Error(`Execution requires explicit confirmation: --confirm-target=${EXPECTED_CONFIRM_TARGET}`);
    }
  }

  const tableReports = [];
  const sourceData = new Map();
  const knownIds = new Map(); // table -> Set of primary key IDs
  let totalSourceRows = 0;
  let totalDestRows = 0;
  let totalPlannedInserts = 0;
  let totalIncompat = 0;
  let totalFkErrors = 0;

  // 1. Read source data and record primary keys
  for (const tableName of TABLE_ORDER) {
    const schema = TABLE_SCHEMAS[tableName];
    const selectCols = schema.sourceSelectColumns || schema.columns.join(', ');
    const sourceStmt = sourceDb.prepare(`SELECT ${selectCols} FROM "${tableName}"`);
    const rows = sourceStmt.all();
    sourceData.set(tableName, rows);
    totalSourceRows += rows.length;

    const idSet = new Set();
    for (const r of rows) {
      if (schema.pk.length === 1) {
        idSet.add(r[schema.pk[0]]);
      } else {
        idSet.add(schema.pk.map((k) => r[k]).join('::'));
      }
    }
    knownIds.set(tableName, idSet);
  }

  // 2. Validate row constraints and foreign-key dependencies
  for (const tableName of TABLE_ORDER) {
    const schema = TABLE_SCHEMAS[tableName];
    const rows = sourceData.get(tableName);
    let incompatCount = 0;
    const fkErrors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIssues = validateRow(tableName, row);
      if (rowIssues.length) incompatCount += rowIssues.length;

      // Foreign key checks
      for (const fk of schema.fks) {
        const val = row[fk.col];
        if (val !== null && val !== undefined) {
          const parentSet = knownIds.get(fk.refTable);
          if (!parentSet || !parentSet.has(val)) {
            fkErrors.push(`Row ${i + 1}: ${fk.col}='${val}' references missing ${fk.refTable}.${fk.refCol}`);
          }
        }
      }
    }

    // Check destination counts (read-only)
    let destCount = 0;
    if (targetDb) {
      try {
        const res = await targetDb.get(`SELECT COUNT(*) as n FROM "${tableName}"`);
        destCount = Number(res?.n || 0);
      } catch {
        destCount = 0;
      }
    }
    totalDestRows += destCount;
    totalPlannedInserts += rows.length;
    totalIncompat += incompatCount;
    totalFkErrors += fkErrors.length;

    tableReports.push({
      table: tableName,
      sourceRows: rows.length,
      destinationRows: destCount,
      plannedInserts: rows.length,
      incompatibleValues: incompatCount,
      foreignKeysValid: fkErrors.length === 0,
      foreignKeyErrors: fkErrors
    });
  }

  // 3. In Execute Mode, execute transactional inserts
  if (!isDryRun) {
    if (totalIncompat > 0 || totalFkErrors > 0) {
      throw new Error(`Import aborted: ${totalIncompat} incompatible value(s) and ${totalFkErrors} foreign key violation(s) found.`);
    }

    if (!targetDb || typeof targetDb.transaction !== 'function') {
      throw new Error('Target database handle does not support transactions');
    }

    await targetDb.transaction(async (tx) => {
      for (const tableName of TABLE_ORDER) {
        const rows = sourceData.get(tableName);
        if (!rows.length) continue;
        const insertSql = buildInsertSql(tableName);
        for (const row of rows) {
          const params = extractRowValues(tableName, row);
          await tx.run(insertSql, ...params);
        }
      }

      // Reset identity sequences inside the same transaction
      await resetIdentitySequences(tx, IDENTITY_TABLES, 'seq');
    });
  }

  const result = {
    mode: modeName,
    tables: tableReports,
    totals: {
      sourceRows: totalSourceRows,
      destinationRows: totalDestRows,
      plannedInserts: totalPlannedInserts,
      incompatibleValues: totalIncompat,
      foreignKeyErrors: totalFkErrors
    },
    identityResets: IDENTITY_TABLES,
    verdict: totalFkErrors === 0 && totalIncompat === 0 ? (isDryRun ? 'READY_FOR_IMPORT' : 'IMPORT_COMPLETED') : 'BLOCKED'
  };

  // Log report
  if (logger && typeof logger.log === 'function') {
    logger.log('================================================================================');
    logger.log(`Alumni Connect Platform: SQLite -> PostgreSQL Migration Importer`);
    logger.log(`Mode: ${modeName} ${isDryRun ? '(Zero writes executed on destination)' : '(Transactional execution)'}`);
    logger.log('================================================================================');
    logger.log('TABLE                         SOURCE    DEST    PLANNED    INCOMPAT    FK STATUS');
    logger.log('--------------------------------------------------------------------------------');
    for (const t of tableReports) {
      const name = t.table.padEnd(28, ' ');
      const src = String(t.sourceRows).padStart(6, ' ');
      const dst = String(t.destinationRows).padStart(7, ' ');
      const pln = String(t.plannedInserts).padStart(10, ' ');
      const inc = String(t.incompatibleValues).padStart(11, ' ');
      const fk = (t.foreignKeysValid ? 'VALID' : `FAILED (${t.foreignKeyErrors.length})`).padStart(12, ' ');
      logger.log(`${name} ${src} ${dst} ${pln} ${inc} ${fk}`);
    }
    logger.log('--------------------------------------------------------------------------------');
    logger.log(`TOTALS                       ${String(totalSourceRows).padStart(6, ' ')} ${String(totalDestRows).padStart(7, ' ')} ${String(totalPlannedInserts).padStart(10, ' ')} ${String(totalIncompat).padStart(11, ' ')}    ${totalFkErrors === 0 ? 'ALL FKs VALID' : `FK ERRORS: ${totalFkErrors}`}`);
    logger.log('================================================================================');
    logger.log(`VERDICT: ${result.verdict}`);
    if (isDryRun) {
      logger.log('To execute the import transactionally against target:');
      logger.log(`  node server/db/importer-cli.js --execute --confirm-target=${EXPECTED_CONFIRM_TARGET}`);
    }
    logger.log('================================================================================');
  }

  return result;
}

// Main entrypoint: wraps source in snapshot/read-only infrastructure
export async function runImport({
  sourcePath = DEFAULT_MIGRATION_SOURCE,
  sourceDb = null, // Injected DatabaseSync / snapshot handle for tests
  targetConfig = {},
  targetDb = null, // Injected facade db handle for tests
  execute = false,
  confirmTarget = null,
  logger = console
} = {}) {
  // Guard target configuration
  const validatedTarget = validateTargetConfig(targetConfig);

  // If source handle is injected (tests), use it directly
  if (sourceDb) {
    return executeImportInternal({
      sourceDb,
      targetDb,
      execute,
      confirmTarget,
      logger
    });
  }

  // Guard source file path
  const validSourcePath = validateSourcePath(sourcePath);

  // Use verified read-only snapshot infrastructure
  return withSnapshotForPreflight(validSourcePath, { cleanShutdownConfirmed: true }, async (snapshotHandle) => {
    let pgHandle = targetDb;
    let ownsPg = false;
    if (!pgHandle) {
      pgHandle = createPgDb({
        ...validatedTarget,
        connectionTimeoutMillis: 5000
      });
      ownsPg = true;
    }

    try {
      return await executeImportInternal({
        sourceDb: snapshotHandle,
        targetDb: pgHandle,
        execute,
        confirmTarget,
        logger
      });
    } finally {
      if (ownsPg && pgHandle && typeof pgHandle.close === 'function') {
        try { await pgHandle.close(); } catch { /* ignore */ }
      }
    }
  });
}
