# PostgreSQL migration notes

Status: **preparation only.** Nothing here is applied by the application. Neither migration file has been
run on a real PostgreSQL yet; the tests check them structurally, and check the date-arithmetic algorithm
against SQLite itself. Treat every PostgreSQL behavior below as "expected from the PostgreSQL
documentation, to be verified on a disposable PostgreSQL".

Files:

| File | Purpose |
|---|---|
| `migrations/001_init.sql` | The schema (26 tables, 16 indexes, `schema_migrations`). Plain `CREATE`, so it fails if anything exists. |
| `migrations/002_sqlite_compat_functions.sql` | `app_shift_ts()`, SQLite-compatible month/year arithmetic. |
| `../server/db/preflight.js` | Read-only data checks to run on the SQLite copy before any import. |

Apply both migrations, in order, to an **empty disposable** database, each in one transaction
(`psql -1 -f ...`).

## 1. Dates and times

The app stores timestamps as UTC `TEXT` (`YYYY-MM-DD HH24:MI:SS`) and dates as `TEXT` (`YYYY-MM-DD`) and
compares them as strings. The schema keeps that format.

| SQLite | PostgreSQL used here | Notes |
|---|---|---|
| `datetime('now')`, `date('now')` | `to_char(statement_timestamp() AT TIME ZONE 'UTC', ...)` | `statement_timestamp()` is constant within a statement and advances between statements, like SQLite. `now()` would freeze for the whole transaction and `clock_timestamp()` would change inside one statement, so neither is used. |
| `datetime('now', '-30 days')` and other seconds/minutes/hours/days | plain `timestamp + interval` | Exact. Everything is UTC. |
| `datetime('now', '+1 month')`, `'+1 year'` | `app_shift_ts(ts, interval)` | **SQLite normalizes overflow, PostgreSQL clamps.** `2025-01-31 + 1 month` is `2025-03-03` in SQLite and `2025-02-28` with a plain interval. `app_shift_ts` reproduces SQLite. |
| `datetime('now', ?)` (bound modifier) | `app_shift_ts(..., (?)::interval)` | Use `pgNowPlusBound()`; it composes with `translatePlaceholders`. Bind `sqliteModifierToInterval(modifier)`. |
| `date(col)`, `strftime('%Y-%m', col)` | `substr(col, 1, 10)`, `substr(col, 1, 7)` | **Not identical:** SQLite validates and normalizes the input and returns NULL for invalid text; `substr` does not. |
| `julianday(b) - julianday(a)` | `EXTRACT(EPOCH FROM ...)` | Result is `numeric`, returned as a string by the `pg` driver unless a type parser is registered. |

Known, intentional differences:

- A `weeks` modifier is **rejected**. SQLite has no such unit and returns NULL for it.
- Modifiers other than whole `second|minute|hour|day|month|year` (`start of month`, `weekday N`, `localtime`,
  fractional values) are rejected, not passed through.
- An invalid modifier raises an error here; SQLite returns NULL.
- Ordering of `datetime` text uses the same text format on both sides, so comparisons agree.

The algorithm behind `app_shift_ts` (first day of the target month, plus the original day offset and time,
plus the interval's own days and time) is verified against SQLite's `datetime()` over thousands of dates,
including month ends and leap days, in `tests/sqlite-compat.test.js`. The PostgreSQL transcription of it in
`002_sqlite_compat_functions.sql` still has to be run on PostgreSQL and compared with the same cases.

## 2. Integer sizes and the data preflight

SQLite `INTEGER` is 64-bit; PostgreSQL `INTEGER` is 32-bit (about 2.1 billion). The routes parse user input
with `parseInt` and store the result with no upper bound, so those columns are `BIGINT`:

`institutions.founded`, `courses.seats`, `courses.annual_fee_inr`, `placement_stats.students_eligible`,
`placement_stats.students_placed`, `roster_records.graduation_year`, `alumni_profiles.graduation_year`,
`subscriptions.amount_inr`, `institution_invoices.amount_inr`, `internships.stipend_inr_month`,
`mentorship_programs.mentee_capacity`, `events.capacity`.

Remaining `INTEGER` columns are flags (0/1) and values the app generates or range-checks (`hue`,
`stale_months`, `career_steps.year`, `career_steps.display_order`, `student_profiles.graduation_year`,
`placement_stats.year`, `internships.duration_weeks`).

The `pg` driver returns `BIGINT` as a **string**; register an `int8` type parser (and a `numeric` one) before
the PostgreSQL backend is used.

**Preflight (run before any import, on a snapshot of the SQLite database, never the live file).**
`server/db/preflight.js` generates checks per column, per foreign key and per table.

*The database runs in WAL mode* (`PRAGMA journal_mode = WAL` in `server/db.js`), so **committed data can live in
the `-wal` file, not in the main `.db` file**, until a checkpoint moves it. Copying only the `.db` file can silently
lose committed rows (verified in `tests/db-snapshot.test.js`: a main-file-only copy of a fixture does not even
contain the table). The complete state is the main file plus the valid frames of the `-wal`. The `-shm` file is
only a shared-memory index that SQLite rebuilds from the WAL, so it is deliberately not copied.

*Required source state and procedure.*
1. **Stop the application and every other process that uses the database.** Do not assume that stopping it
   leaves only the `.db` file. SQLite removes `-wal` and `-shm` only when the last connection is closed. Observed
   behavior (an experiment on Node 22.23.4 with the `node:sqlite` driver; other versions are untested): a process that
   ends normally without calling `db.close()` left only the `.db` file, but a process stopped with SIGTERM left both
   `.db-wal` and `.db-shm`. The application has no SIGTERM handler and does not call `db.close()` on shutdown (this
   document does not change that), so a stop by SIGTERM, which is what a host such as Render sends, can leave the
   sidecars. That is expected and handled: the `-wal` is copied together with the main file. Because a `-shm` in the
   source means a process may still have been running, or crashed, the snapshot then reports
   `snapshot:source-shm-present` and the outcome is `needs_review`, not `clear`. For a SIGTERM-stopped application
   that is the correct reading, not a fault; confirm the application is really stopped and review the result.
2. Run the snapshot against the **original location**, not against a hand-made copy of the main file, and
   **always close the handle in a `finally`** (the snapshot is a full copy of the data in a temporary directory):

   ```js
   const db = openSnapshotForPreflight('/path/to/alumni_platform.db');
   try {
     const results = runPreflight(db);
     const summary = summarizePreflight(results);   // outcome: 'blocked' | 'needs_review' | 'clear'
   } finally {
     db.close();                                    // never throws; returns { cleaned, directory, error? }
   }
   // or: withSnapshotForPreflight(path, {}, (db) => summarizePreflight(runPreflight(db)))
   ```

   It never opens the original with SQLite (even a read-only SQLite open of a WAL database creates `-wal`/`-shm`
   files beside it), never checkpoints and never writes there; it only reads the files. `db.snapshot` reports what
   was copied (sizes, SHA-256, WAL frame counts).
3. Only if there is no `-wal` file does it need a statement from you: a main file without its WAL looks exactly
   like a cleanly closed database, and the tool cannot tell them apart. Pass
   `{ cleanShutdownConfirmed: true }` only if you know the database was shut down cleanly. Otherwise it refuses.
   Even then the result carries the warning `snapshot:assumed-clean-shutdown`.

*The main file and its WAL must belong together.* The adjacent `-wal` must belong to the exact database file
being snapshotted. SQLite does not record which database a WAL belongs to: **WAL checksums do not prove which
database a WAL belongs to**; they only prove that the WAL is internally consistent. The dangerous case is
restoring or replacing a `.db` file while leaving an older `-wal` beside it (or pairing a database with the WAL
of another one): SQLite replays the WAL's pages onto the wrong main file, the result is a plausible but incorrect
database, and every check here still passes. (`tests/db-snapshot-trust.test.js` demonstrates this with a WAL from
another database of the same page size.) Therefore: a backup must be restored together with its matching WAL
state, or from a cleanly closed database where the clean-shutdown attestation is justified. When restoring a
`.db` file, delete any `-wal` and `-shm` that belong to the file it replaces.

*Why the snapshot is consistent.* Nothing can lock the source (it is never opened with SQLite), so concurrent
changes are made detectable: main and WAL are hashed while being copied, hashed again afterwards in the opposite
order, and their identity, size and timestamps are compared before and after. Any difference refuses the
snapshot ("the source changed while it was being copied"). Hashes show that nothing changed during the copy; they
do **not** prove the application was stopped, which is why a `-shm` in the source is reported (below). Then:
- every write is checked (short writes are completed; a write that accepts no bytes fails), and the copied main
  file and WAL are re-read from the destination and must equal the source bytes that were copied (size and
  SHA-256), otherwise the snapshot is refused;
- the main-file header (page size, journal mode, in-header page count) and the WAL are parsed from the COPIES,
  not from an earlier read of the source; a header that is malformed, inconsistent with the file size, or
  describes more pages than the file holds is refused;
- the WAL header checksum, page size and frame checksum chain are checked the way SQLite reads them;
- the copy is opened read-only and must pass SQLite's `integrity_check` and report exactly the page count of the
  last committed WAL frame (a cross-check that the WAL was applied; it does not prove no committed transaction
  was lost);
- a direct write probe proves the snapshot connection is read-only (see below).

The snapshot is refused for: a non-empty `-journal` (an interrupted transaction needs recovery, which would write
to the source), a `-shm` without a `-wal`, sidecars on a non-WAL database, sidecars that are symlinks or
directories, unreadable files, a truncated or non-SQLite main file, a WAL with a bad header or page size, and a
damaged WAL frame that is followed by more frames of the same WAL generation (SQLite would silently drop
committed data after it).

*What a snapshot says about itself (these are part of the results and the summary).* Some situations are
tolerated because SQLite itself behaves that way, but they must never read as an unqualified `clear`:

| result id | severity | meaning |
|---|---|---|
| `snapshot:assumed-clean-shutdown` | warning | there was no `-wal`; you attested a clean shutdown. Rows committed only in a missing WAL are absent |
| `snapshot:source-shm-present` | warning | the source had a `-shm`: a process may still have been running, or it crashed |
| `snapshot:wal-tail-ignored` | warning | SQLite ignores the end of the WAL and the last transaction(s) may NOT be in the snapshot: a damaged frame of the current generation, trailing frames that could not be verified as intact leftovers of an older generation (zero-filled, corrupted or unchained), a partial trailing frame, or valid frames with no commit record |
| `database:no-tables` | blocker | there is nothing to migrate: wrong file, or committed data missing (for example a main file taken without its WAL). Never `clear` |
| `snapshot:copy-verified` | ok | the copies match the source bytes (size and SHA-256 re-read from the copy) |

*Trailing frames after the valid chain.* SQLite ignores every frame after the last valid commit. That is harmless
only for leftovers of an **older WAL generation** (frames written before the WAL was restarted, which stay in the
file beyond the new, shorter log). It is not harmless if the trailing frames are a committed transaction that was
zero-filled, corrupted or lost, and the format cannot always tell the two apart, so a trailing frame counts as a
**verifiably intact leftover of an older WAL generation** only on positive evidence: it has a non-zero page number
and non-zero salts and its checksum chains from the previous trailing frame (WAL checksums are cumulative, so an
old tail chains frame to frame). The first frame of such a run has no readable predecessor, so it counts only if
the next frame chains from it. Salts alone prove nothing: they are not covered by the checksum. In addition, a
trailing frame whose checksum chains from the end of the valid chain is current-generation data with damaged salts,
and is reported as damaged, never as stale. Zero-filled, corrupted or unchained trailing frames, isolated frames
with nothing to chain from, and frames with damaged salts therefore all produce `snapshot:wal-tail-ignored` and an
outcome of at least `needs_review`. An isolated single leftover frame is reported even though it may be harmless:
the tool fails conservatively.

*What "verified" means, and what it does not.* The classification above is evidence about the **chain linkage**, not
authentication. WAL checksums are non-cryptographic: they can detect accidental corruption but do not authenticate
frames, salts, or database identity. Three consequences are accepted limitations, not mitigated, and pinned by tests
in `tests/db-snapshot-trust.test.js`:
- **D1, identical constructed salts.** Two or more consecutive trailing frames that carry identical non-zero salts and
  a consistent checksum chain are accepted as an older generation, even if they are really a damaged committed
  transaction that ended up in that shape (for example, both frames given the same salts while the first frame's page
  data is corrupted). The tool does not assume that WAL salts are sequential generation counters, so it applies no
  rule on how an older generation's salts relate to the current ones; it cannot rule such a tail out.
- **D2, the first frame of an older run.** Its predecessor was overwritten, so it counts as verified only because it
  has a non-zero page number and non-zero salts and the next frame chains from its stored checksum. Its own page data
  is not independently verified: corrupting only that frame's page data is not detected. This does not affect
  committed data (SQLite ignores these frames), but it means "verified" is a statement about the chain, not about
  that frame's contents. Frames further along the run are checked individually, and a corrupted one is reported.
- **L1, older contents restored over newer frames.** If older frame contents are written back over newer committed
  frames (stale blocks returning after a crash or restore, or an old copy of part of the file), the result is a
  valid-looking older-generation chain. SQLite reads it the same way and no check here can tell the difference, so a
  committed transaction can be missing while the outcome is `clear`. This is the same family as a WAL cut at a frame
  boundary (next paragraph): both look exactly like a legitimately shorter log.

*A WAL cut exactly at a frame boundary may be undetectable* (and so may older frame contents restored over newer
committed frames, limitation L1 above). If the WAL file was truncated, or the last
transaction is missing, at exactly a frame boundary, what remains is an ordinary valid WAL that is merely shorter:
there are no damaged, partial or uncommitted frames to see, and the format carries no record of how long the WAL
should have been. Such a snapshot is `clear` while a committed transaction is missing. Only the operator can catch
this, by checking that the newest record the application is known to have written is present (see the pairing
checklist). The tool does not and cannot guarantee otherwise. The same limit applies to the main/WAL pairing: WAL
checksums do not prove which database a WAL belongs to.

`summarizePreflight(results).snapshotFindings` lists the `snapshot:` results.

*Read-only, fail closed.* `runPreflight()` only accepts a handle from `openSnapshotForPreflight()` or
`openReadOnlyForPreflight()` (a standalone rollback-journal file; it refuses WAL-mode files and any file with
`-wal`, `-shm` or `-journal` beside it). Both open the file with `readOnly: true`, prove on a throwaway canary path that
this Node.js really honors that option (a writable open would create the canary, and the canary must fail with
"unable to open"), do so before the target is opened, enable `PRAGMA query_only = ON` and read it back, and
return a frozen wrapper that prepares only `SELECT`, `PRAGMA table_info/foreign_key_list` and two read-only
pragmas. They throw `PreflightReadOnlyError` if any of that cannot be guaranteed; there is no writable fallback
and no parameter through which a caller can supply its own opener. A plain `DatabaseSync` is refused. The test
seams (`verifyReadOnlyOpenerForTests`, `verifySnapshotOpenerForTests`, `setSnapshotRemoverForTests`) refuse to run
outside a test process, and return a verdict and never a handle.

**The plain opener is weaker than the snapshot workflow.** `openReadOnlyForPreflight()` gives the guarantees listed
above (read-only open, canary, `query_only`, statement allowlist, refusal of WAL-mode files and of `-wal`, `-shm` and
`-journal` neighbors) and nothing more. It does **not** run SQLite's `integrity_check`, it does **not** perform the
snapshot path's write probe, it does not copy or hash anything, and it does not check that the page count matches a
WAL. Those belong to `openSnapshotForPreflight()`. The plain opener is for a standalone, cleanly closed
rollback-journal copy that you already trust; it is not a substitute for the snapshot workflow and must not be read as
providing the same assurance. Use `openSnapshotForPreflight()` for the application's real (WAL-mode) database.

For the snapshot path the canary is not the only proof. Because the copy is disposable, the opened snapshot is
also probed directly: with the soft `query_only` guard switched off (and read back as `0`, otherwise the probe would not test the
connection itself), a write (inside a transaction that is always
rolled back) must be rejected by the connection itself as a read-only error. If the write succeeds, fails for any
other reason, or `query_only` cannot be switched back on and read back, no handle is issued and the snapshot
directory is removed. The probe only ever touches the snapshot copy, never a source file.

*Cleanup.* The snapshot directory (`preflight-snapshot-*` in the system temp directory, mode 0700) holds a full
copy of the data. It is removed by `close()`, by `withSnapshotForPreflight` (also when the callback throws or
rejects), when a snapshot is refused, and, as a backstop, when the process exits normally. Only directories this
process created, by exact path, are ever deleted; the temp directory is never swept. `close()` never throws: it
returns `{ cleaned, directory }`, and if the directory could not be removed `cleaned` is `false`, `error` says why,
a `PreflightSnapshotCleanupWarning` process warning is emitted, `snapshotCleanupFailures()` lists it and
`retrySnapshotCleanup()` tries again. A killed or crashed process cannot clean up: delete leftover
`preflight-snapshot-*` directories by hand.

*Three kinds of result.* Each result has `severity` and `status`:

| severity | status | meaning |
|---|---|---|
| `blocker` | `found` | the migration must not proceed until fixed |
| `warning` | `found` | needs a human decision; not necessarily wrong |
| `unverifiable` | `unverifiable` | the check could not be performed reliably (`bad` is `null`, `reason` says why) |

`summarizePreflight(results)` returns `outcome`: `blocked` (any blocker), `needs_review` (warnings or
unverifiable checks) or `clear`. Treat `needs_review` as "a person must look", not as a pass.

| Check | Severity | Why / limitation |
|---|---|---|
| INTEGER column holds only whole numbers (`typeof = 'integer'`) | blocker | SQLite stores `1.5` in an INTEGER column as a REAL; PostgreSQL rejects it |
| `BIGINT` columns: whole numbers; `INTEGER` columns: also inside the 32-bit range | blocker | out-of-range rows cannot be imported |
| `BIGINT` columns within +/-(2^53 - 1) | blocker | the app reads integers as JavaScript Numbers; beyond this they silently lose precision |
| flag columns are exactly 0 or 1 | blocker | the app compares `= 1` / `= 0` |
| REAL columns hold numbers | blocker | |
| TEXT columns are text with no NUL byte | blocker | PostgreSQL `TEXT` cannot hold NUL. Skipped in non-UTF-8 databases (see below) |
| TEXT columns are valid UTF-8 (bytes decoded strictly in JavaScript) | blocker | PostgreSQL rejects invalid byte sequences; a lossy decode would insert U+FFFD. Reads every text value, so it is slow on a big database |
| TEXT contains U+FFFD | warning | may be genuine, or the trace of an earlier lossy decode |
| `*_json` columns satisfy `json_valid()` | blocker | the app calls `JSON.parse` on them |
| primary-key columns have no NULL | blocker | SQLite allows NULL in a `TEXT PRIMARY KEY`; PostgreSQL does not |
| existing rows satisfy every `CHECK(...)` | blocker | SQLite does not re-check old rows (and `ignore_check_constraints` skips them). `PRAGMA integrity_check` does NOT detect this (verified), so each expression is extracted from the `CREATE TABLE` text and run as `WHERE NOT (expr)`. A NULL result passes, as in SQLite. If the text cannot be parsed or an expression cannot be evaluated the check is `unverifiable` |
| timestamp columns use one format | warning | rows outside the dominant one of `YYYY-MM-DD HH:MM:SS`, `YYYY-MM-DDTHH:MM...` (ISO) and `YYYY-MM-DD`; unrecognized values always count. Limitations: only columns whose NAME ends in `_at`, `_on`, `_date` (or is `date`/`timestamp`) are examined; a uniform ISO column is not flagged even though the app writes the space format; offsets and fractions are not validated |
| every foreign key points at an existing row | blocker | PostgreSQL always enforces foreign keys. `REFERENCES parent` with no column is resolved to the parent's primary key (matched in key order, composite keys checked as one key; a NULL in any key column satisfies the constraint, as in SQLite). If the parent table is missing, has no primary key, has a different column count, or lacks a named column, the check is `unverifiable` with the reason |
| table or column names differ only by case | blocker | PostgreSQL folds unquoted names |
| uppercase letters in table or column names | warning | the PostgreSQL schema uses lowercase unquoted names |
| column type other than INTEGER/REAL/TEXT | unverifiable | no check exists for it |
| database encoding is not UTF-8 | unverifiable | UTF-8 validation and NUL detection are skipped (UTF-16 text contains 0x00 bytes by design) |

Identifiers may use letters (either case), digits and underscore, not starting with a digit. Every identifier is
emitted double-quoted. Anything else (spaces, quotes, dots, semicolons, non-ASCII) is rejected with an error,
so a name cannot break out of its quotes.

Not verified against any real data: these checks have only run on temporary fixtures (`tests/db-preflight.test.js`, `tests/db-snapshot.test.js`).

Known limitations of the snapshot: the source cannot be locked, so the guarantee relies on the source being stopped (changes during the copy are detected, but a source that is written only before and after the copy window is, by definition, a valid point in time). Only little-endian WAL files (what this platform writes) were exercised; the big-endian checksum path is untested. A rollback journal that needs recovery is refused rather than recovered. File permissions could not be tested as root.

`tests/ddl-parity.test.js` fails if an `INTEGER` column is added to the SQLite schema without being
classified in `preflight.js` (wide, flag or 32-bit), so the list cannot silently go stale.

## 3. Identity columns (`messages.seq`, `audit_logs.seq`)

SQLite code breaks timestamp ties with `rowid`; PostgreSQL has none, so these two tables have
`seq BIGINT GENERATED BY DEFAULT AS IDENTITY`. Orderings become `ORDER BY created_at, seq`.

**Hidden by source, never by name.** The facade does not touch result columns: a column or alias called `seq`
that the application selects on purpose (`SELECT seq ...`, `COUNT(*) AS seq`, `ROW_NUMBER() ... AS seq`) comes
back exactly as the database produced it. `SELECT *` on these tables would add a field the SQLite version never
had, so the PostgreSQL backend (a later phase) hides only result columns that the driver reports as coming from
`messages.seq` or `audit_logs.seq`, using `stripInternalColumns(rows, fields)` from `server/db/internal-columns.js`.
Expressions and columns of any other table are never matched; if a real column and an alias share the name `seq`,
the name is kept. The SQLite backend needs nothing, because the SQLite schema has no `seq`.
Inventory of `SELECT *` on these tables today: `server/routes/admin_institution.js` (institution data export,
`SELECT * FROM audit_logs ...`). The permanent fix is an explicit column list there; that is a route change, so
it is deferred and recorded here. A test fails if a new `SELECT *` on these tables appears.

**Explicit-ID imports need a sequence reset.** `GENERATED BY DEFAULT` accepts explicit `seq` values, but the
sequence does not advance when they are used. Unless the sequence is moved past the largest imported value,
the next ordinary insert reuses a number and collides or mis-orders. Two safe options:

1. Import **without** `seq` and read the SQLite rows `ORDER BY rowid`; the identity assigns increasing values
   in that order, so nothing needs resetting.
2. If explicit values are imported, call `resetIdentitySequences(tx)` (`server/db/identity.js`) **inside the
   same transaction** as the import, using the handle the transaction callback receives:

   ```js
   await db.transaction(async (tx) => {
     /* insert rows with explicit seq values through tx */
     await resetIdentitySequences(tx);          // messages and audit_logs by default
   });
   ```

   For each table it runs, in order: `LOCK TABLE t IN SHARE ROW EXCLUSIVE MODE`, a lookup of
   `pg_get_serial_sequence('t', 'seq')`, and
   `SELECT setval((COALESCE(pg_get_serial_sequence('t','seq'), '<impossible name>'))::regclass, COALESCE((SELECT MAX(seq) FROM t), 0) + 1, false)`
   (statements from `pgLockForResetSql`, `pgIdentitySequenceNameSql`, `pgResetIdentitySql` in `server/db/sql.js`).
   `false` means "the next value handed out is exactly this one" (1 for an empty table).

   **Fails loudly.** `pg_get_serial_sequence` returns NULL when the column has no owned sequence, and `setval`
   with NULL silently does nothing. The helper checks for NULL and throws `IdentityResetError`
   (`code IDENTITY_RESET_FAILED`, with `table` and `column`); the SQL itself also errors on a missing sequence.
   A missing table or column, or a name that is not a plain lowercase identifier, is an error too.

   **Concurrency.** The lock blocks every other session's INSERT/UPDATE/DELETE on the table (reads continue)
   until the transaction ends, so no insert can happen between reading `MAX(seq)` and `setval`. Callers do not
   have to stop the application for correctness, but writers to these tables WAIT (and may time out) until the
   transaction commits, so run imports in a maintenance window. Outside a transaction `LOCK TABLE` fails in
   PostgreSQL, so a forgotten transaction is an error, not a race. `setval` is not transactional: a rollback
   leaves the sequence advanced, which only produces a gap.

   **Transaction ownership.** The helper only uses the handle it is given. It never calls `transaction()`, never
   commits or rolls back, so the caller keeps sole ownership of the transaction.

   Not verified against a real PostgreSQL yet (see the test file header of `tests/db-identity.test.js`).
   Verify afterwards by reading the sequence without consuming it: `SELECT last_value, is_called FROM <sequence
   name from pg_get_serial_sequence>`; `last_value` must be greater than `MAX(seq)` and `is_called` must be `false`.

## 4. Other behavior differences (documented, not changed)

These need explicit decisions and tests when the queries are ported; none are changed here.

- **Collation.** SQLite compares text bytewise. PostgreSQL uses the database locale (for example
  `en_US.UTF-8`), so `ORDER BY name` and string range comparisons can order differently (case, accents,
  punctuation). Where an order is asserted, use `COLLATE "C"` or sort in JavaScript. The date/timestamp text
  columns are digits and punctuation only and sort the same.
- **NULL ordering.** SQLite sorts NULLs **first** in ascending order and **last** in descending order;
  PostgreSQL is the opposite (last ascending, first descending). Every `ORDER BY` on a nullable column needs
  `NULLS FIRST` (ascending) or `NULLS LAST` (descending) to keep SQLite's order.
- **`LIKE` and `LOWER()`.** SQLite's `LIKE` ignores case for ASCII; PostgreSQL's does not. The app lowercases
  both sides, which keeps it correct. SQLite's `LOWER()` changes ASCII letters only; PostgreSQL's handles all
  Unicode letters, so non-ASCII names now match more consistently. Behavior for non-ASCII input changes.
- **`GROUP BY`.** SQLite allows selecting non-grouped columns; PostgreSQL does not.
  `server/routes/admin_community.js` (top mentors) selects `u.full_name` and `ap.current_company` while grouping
  by `r.alumni_id` only, and must be rewritten.
- **Type strictness.** SQLite coerces freely (`'5'` vs `5`); PostgreSQL does not. `COUNT(*)` and `SUM()` return
  `bigint`/`numeric` (strings from `pg`). Booleans are not accepted as parameters (the facade rejects them).
- **Reserved words.** `current_role` must be quoted everywhere (`quoteReservedWords()` helps).
- **`?` placeholders.** Only plain `?` is translated to `$1, $2, ...`. `?NNN`, `:name`, `@name`, backtick and
  `[bracket]` identifiers and `E'...'` strings are rejected by the translator, not guessed at.
- **Error text.** The Express error handler matches the string `UNIQUE constraint failed`; PostgreSQL reports
  SQLSTATE `23505`. Use `classifyDbError()`/`isUniqueViolation()`. Network and timeout failures (`ECONNRESET`,
  `ETIMEDOUT`, `Connection terminated unexpectedly`, SQLSTATE `57014`, ...) classify as `connection` or
  `timeout`; `isRetryableDbError()` is true for those and for serialization failures.

## 5. Transactions in the SQLite backend

`createSqliteBackend` serializes transactions on its single connection and makes a plain statement wait while
another request's transaction is open. See the header of `server/db/sqlite-backend.js` for the rules, the
`DB_LOCK_TIMEOUT` behavior (a timeout on the *waiter*, never a release of the lock) and the transaction-handle
rules (a handle stops working when its transaction finishes).

**Limitation: raw transaction-control SQL bypasses the transaction manager.** The backend does not parse SQL.
Statements such as `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` or `RELEASE` sent through `exec`, `run`, `query`, `get`
or `all` are executed as ordinary statements, so they escape the serialization and the diagnostics described
above. Observed with an in-memory database: `db.exec('BEGIN')` opened a transaction that `diagnostics()` did not
report (`transaction: null`); other callers' plain statements then ran inside it; and a later `transaction()` failed
with SQLite's "cannot start a transaction within a transaction". Callers must use the supported `transaction()` API
and must never issue transaction-control statements directly. This is a documented limitation of the Phase 1a
backend, not something it enforces.

## 6. Node version

The project supports Node `>= 22.13`. `StatementSync.columns()` only exists from 22.16, so `query()` can also
decide whether a statement returns rows by asking SQLite (`EXPLAIN ...`). Both paths are tested against each
other on the available runtime. Node 22.13 itself was **not available** to test; see the verification report.
