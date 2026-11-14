-- Alumni Connect Platform: PostgreSQL migration 002, SQLite-compatible date arithmetic.
--
-- NOT applied by the application yet. Checked structurally by tests/ddl-parity.test.js; the ALGORITHM is
-- checked against SQLite itself by tests/sqlite-compat.test.js. This file has not been run on a real
-- PostgreSQL, which is the job of the phase that adds a disposable PostgreSQL.
--
-- Why it exists: SQLite normalizes month and year overflow (datetime('2025-01-31', '+1 month') is
-- 2025-03-03) while a plain PostgreSQL interval clamps to month end (2025-02-28). The app computes
-- subscription and billing period ends with '+1 month' and '+1 year', so the difference would change
-- real dates. app_shift_ts(ts, iv) reproduces SQLite's result:
--
--     first day of the target month  +  (the original day of month - 1) days  +  the original time of day
--
-- plus the interval's own days and time. Because the month step always starts from day 1, it can never
-- clamp, and the day offset then overflows into the following month exactly as SQLite's does.
-- Seconds, minutes, hours and days need no help (plain interval addition is exact, everything is UTC).
--
-- Plain CREATE FUNCTION on purpose: it fails if a function of this name already exists.
-- Run it in one transaction, for example: psql -1 -f 002_sqlite_compat_functions.sql

CREATE FUNCTION app_shift_ts(ts timestamp, iv interval) RETURNS timestamp
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT date_trunc('month', ts)
       + (((EXTRACT(YEAR FROM iv) * 12 + EXTRACT(MONTH FROM iv))::double precision) * interval '1 month')
       + (ts - date_trunc('month', ts))
       + (iv - (((EXTRACT(YEAR FROM iv) * 12 + EXTRACT(MONTH FROM iv))::double precision) * interval '1 month'))
$$;
