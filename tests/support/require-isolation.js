// Import this FIRST in any test file that loads the app or the database. It does not create
// anything. It only throws, before any later import is evaluated, when the runner-level preload
// did not run (for example when the file is executed directly with plain `node`).
// server/db.js enforces the same rule on its own, so forgetting this import is still safe.
import { isTestIsolationActive } from '../../server/guard.js';

if (!isTestIsolationActive()) {
  throw new Error('Refusing to run: test isolation is not active. Run the tests with "npm test", or run one file with "node --import ./tests/preload.js <test file>".');
}
