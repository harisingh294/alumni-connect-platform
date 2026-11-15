import {
  createUnifiedDb,
  createSqliteDb,
  resolveDatabaseEngine
} from './db/index.js';

// SQLite remains the safe default for existing local deployments.
// PostgreSQL requires an explicit DATABASE_ENGINE or DB_ENGINE setting.
const requestedEngine =
  process.env.DATABASE_ENGINE ||
  process.env.DB_ENGINE ||
  'sqlite';

export const databaseEngine = resolveDatabaseEngine({
  engine: requestedEngine
});

let database;

if (databaseEngine === 'sqlite') {
  // Import the legacy SQLite module only in SQLite mode.
  // This preserves its existing guard, schema initialization and DB location.
  const sqliteModule = await import('./db.js');
  database = createSqliteDb(sqliteModule.db);
} else {
  // PostgreSQL mode must never import server/db.js.
  // The unified factory validates DATABASE_URL before creating the pool.
  database = createUnifiedDb(
    { engine: databaseEngine },
    process.env
  );
}

export const db = database;
export default db;