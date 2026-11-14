// Runner-level test isolation: loaded with `node --import ./tests/preload.js` (see the "test" script),
// so it runs in every test process BEFORE any test module can import the app or the database.
import './support/isolation.js';
