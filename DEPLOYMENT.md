# Deploying AlumVerse

The Phase 2 rules need a public link that keeps working until **31 March 2027**. The demo cannot be recorded on localhost. This guide deploys the app to Render (free web service) with a managed PostgreSQL database (Neon). State lives in PostgreSQL, so no persistent disk is needed.

SQLite is still the default for local development (`DATABASE_ENGINE` unset or `sqlite`). Production uses `DATABASE_ENGINE=postgres`.

## What you need

- A GitHub repository with this folder pushed to it. Your faculty mentor needs read access, so add them as a collaborator.
- A Render account (the free web service is enough).
- A managed PostgreSQL database, for example a Neon project. Copy its connection string **with `?sslmode=require`**. Never commit it.
- A strong `PLATFORM_ADMIN_PASSWORD` of 12 or more characters, kept in a password manager. Never commit it.

## Steps

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint** and pick the repository. Render reads `render.yaml` and creates the web service from the `Dockerfile`. `JWT_SECRET` is generated randomly by Render.
3. When Render asks, set:
   - `DATABASE_URL` to the PostgreSQL connection string (`postgres://…?sslmode=require`).
   - `PLATFORM_ADMIN_EMAIL` to the team's shared ops address.
   - `PLATFORM_ADMIN_PASSWORD` to the strong password.
4. Deploy (`autoDeploy` is off, so deploys are manual). On first start the server applies the schema migrations itself, then creates the platform account. The logs should show:
   ```
   [migrator] Applying 2 pending migration(s)...
   [migrator] Applied migration 001_init.sql in …ms
   [migrator] Applied migration 002_sqlite_compat_functions.sql in …ms
   [bootstrap] Platform account created for <your email>
   AlumVerse Server Running
   ```
   On every later start it prints `[migrator] Schema is up to date. No pending migrations.`
5. Smoke test the Render URL in a fresh incognito window: `GET /api/health`, platform login, register an institution, verify it from the platform console, sign up an alumnus and a student, send and accept a mentorship request, download the CSV exports.
6. Only after the Render URL works, add the custom domain under Render → Settings → Custom Domains and verify DNS and HTTPS.

## Database migrations

- Migrations live in `db/migrations/NNN_name.sql`. Each one runs in its own transaction together with its `schema_migrations` row, under a PostgreSQL advisory lock, so two instances starting at once cannot both apply it.
- The server runs pending migrations on start. To check or apply them by hand (for example from your laptop before a deploy):
  ```
  DATABASE_ENGINE=postgres DATABASE_URL=… npm run migrate -- --status
  DATABASE_ENGINE=postgres DATABASE_URL=… npm run migrate -- --dry-run
  DATABASE_ENGINE=postgres DATABASE_URL=… npm run migrate
  ```
- **Before any migration on a database that holds real data, take a backup** (next section).

## Backups and recovery

`npm run backup` is SQLite-only and refuses to run in PostgreSQL mode. For PostgreSQL:

- **Managed backups:** use the provider's point-in-time restore (Neon: restore a branch to an earlier time). Check the retention window of your plan.
- **Your own copy (recommended weekly and before every migration):**
  ```
  pg_dump "$DATABASE_URL" -Fc -f alumverse-YYYYMMDD.dump
  ```
  Use a `pg_dump` whose major version is the same as or newer than the server's.
- **Restore** into an empty database:
  ```
  createdb … && pg_restore --no-owner -d "<target url>" alumverse-YYYYMMDD.dump
  ```
  A dump/restore round trip was verified locally: every row, all 36 foreign keys and the `schema_migrations` history came back identical.

## Reviewer sandbox

The fictional reviewer sandbox (auto-load with `SANDBOX=on`, and **Rebuild sandbox now** in the platform console) is **SQLite-only**. In PostgreSQL mode the server skips it with a warning and the rebuild endpoint returns 503. A fresh PostgreSQL deployment therefore starts with no institutions: the public institution list stays empty until a real institution registers and the platform team verifies it.

## Moving existing SQLite data to PostgreSQL

`server/db/importer.js` copies a SQLite database into PostgreSQL (dry-run by default, transactional, checks every foreign key). It is **deliberately locked to a local disposable database** (`127.0.0.1:5544/alumni_test`) and refuses Neon, Render and other remote hosts. Copying real data into the production database needs a separate, reviewed procedure; it is not automated.

## Running it day to day

| Task | How |
| :--- | :--- |
| Back up the database | `pg_dump` as above, or the provider's point-in-time restore |
| See usage evidence for a partner | Platform console → Usage evidence → **Download CSV** |
| Export the feedback log | Platform console → Feedback log → **Download for Google Sheets**, then in Sheets use File → Import |
| Health check | `GET /api/health` returns `{"status":"ok","service":"AlumVerse",…}`. It does not query the database, so check the logs for database errors. |

## Safety rails already in the code

- **The full reset (`npm run seed`) refuses to run in production, unconditionally**, and both seed commands refuse to run with `DATABASE_ENGINE=postgres`.
- **The server fails fast.** Without `JWT_SECRET`, without `DATABASE_URL` in PostgreSQL mode, or when the database cannot be reached or a migration fails, it exits with an error instead of serving requests.
- **TLS to the database is verified** (`rejectUnauthorized: true`) for Neon and for any URL with `sslmode=require`.
- **One-click demo login is disabled in production.**
- **The platform account comes from environment variables.** No platform password is stored in the code.

## Environment variables

| Variable | Required | Meaning |
| :--- | :--- | :--- |
| `NODE_ENV` | Yes | `production` on the host. |
| `DATABASE_ENGINE` | Yes | `postgres` on the host. Unset or `sqlite` for local development. |
| `DATABASE_URL` | Yes (PostgreSQL) | PostgreSQL connection string with `?sslmode=require`. Secret. |
| `JWT_SECRET` | Yes | Signs login sessions. The server refuses to start without it. Render generates it. |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | Yes | Creates the platform-team login on first start. Password: 12+ characters. |
| `SANDBOX` | No | `off` in PostgreSQL mode (the sandbox is SQLite-only). |
| `PLATFORM_ADMIN_RESET_PASSWORD` | No | `true` resets the platform password from the environment once. Remove it afterwards. |
| `ENABLE_DEMO_LOGIN` | No | Leave unset in production. |
| `DATA_DIR`, `DB_FILE` | SQLite only | Where the SQLite database lives. Not used in PostgreSQL mode. |
