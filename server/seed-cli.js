// Command line for seeding the database.
//
//   npm run seed -- --confirm-wipe=<exact database path>
//       Wipes and rebuilds the LOCAL database with sample data. Refused in production, always.
//   npm run seed:sandbox -- --confirm-sandbox=<exact database path>
//       Adds the FICTIONAL reviewer institutions, accounts and activity data. In production it is
//       refused unless SANDBOX=on is set, and it always needs the exact path.
//
// Every check below runs BEFORE ./seed.js or ./db.js is loaded. ES module imports are evaluated
// before the importing module's body, so this file statically imports only side-effect-free
// modules (./dblocation.js, ./guard.js) and loads the database code with a dynamic import() after
// the request has been validated. A refusal therefore never creates, opens, initializes or
// changes the database, and never creates a directory.
import { resolveDatabaseLocation } from './dblocation.js';
import { validateWipeConfirmation, validateSandboxConfirmation, authorizeManualWipe } from './guard.js';

const args = process.argv.slice(2);
const sandbox = args.includes('--sandbox');
const { dbPath } = resolveDatabaseLocation(); // pure path computation; same function db.js uses

try {
  if (sandbox) validateSandboxConfirmation(dbPath, args);
  else validateWipeConfirmation(dbPath, args);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

try {
  // Only now is anything that opens the database loaded.
  const { runSeed } = await import('./seed.js');
  if (sandbox) {
    const { db } = await import('./db.js');
    const real = db.prepare('SELECT COUNT(*) AS n FROM institutions WHERE is_sandbox = 0').get().n;
    if (real > 0) {
      console.warn(`Note: this database already holds ${real} real institution(s). The sandbox seed adds fictional ones beside them, and adds synthetic activity rows for external-student accounts.`);
    }
    runSeed({ mode: 'sandbox' });
  } else {
    runSeed({ mode: 'full', authorization: authorizeManualWipe(dbPath) });
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
