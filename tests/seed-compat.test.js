import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { prepareSql } from '../server/db/pg-backend.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('seed SQL PostgreSQL and engine-neutral compatibility (Batch 4 untargeted)', () => {
  test('seed.js contains zero SQLite-specific INSERT OR IGNORE / REPLACE statements', () => {
    const seedSrc = fs.readFileSync(path.join(repoRoot, 'server', 'seed.js'), 'utf8');
    const matches = [...seedSrc.matchAll(/\bINSERT\s+OR\s+(?:IGNORE|REPLACE)\b/gi)];
    assert.equal(matches.length, 0, `Expected 0 INSERT OR IGNORE/REPLACE, found ${matches.length}`);
  });

  test('seed.js uses untargeted ON CONFLICT DO NOTHING across all five seed statements', () => {
    const seedSrc = fs.readFileSync(path.join(repoRoot, 'server', 'seed.js'), 'utf8');
    const targetedMatches = [...seedSrc.matchAll(/\bON\s+CONFLICT\s*\([^)]+\)\s+DO\s+NOTHING\b/gi)];
    assert.equal(targetedMatches.length, 0, `Expected 0 targeted ON CONFLICT, found ${targetedMatches.length}`);

    const untargetedMatches = [...seedSrc.matchAll(/\bON\s+CONFLICT\s+DO\s+NOTHING\b/gi)];
    assert.equal(untargetedMatches.length, 5, `Expected 5 untargeted ON CONFLICT DO NOTHING statements, found ${untargetedMatches.length}`);
  });

  describe('in-memory SQLite conflict behavior verification (untargeted ON CONFLICT DO NOTHING)', () => {
    function setupMemoryDb({ foreignKeys = true } = {}) {
      const db = new DatabaseSync(':memory:');
      if (foreignKeys) {
        db.exec('PRAGMA foreign_keys = ON;');
      }
      db.exec(`
        CREATE TABLE institutions (
          id TEXT PRIMARY KEY
        );

        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          institution_id TEXT REFERENCES institutions(id)
        );

        CREATE TABLE internships (
          id TEXT PRIMARY KEY,
          institution_id TEXT REFERENCES institutions(id)
        );

        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          institution_id TEXT REFERENCES institutions(id)
        );

        CREATE TABLE mentorship_programs (
          id TEXT PRIMARY KEY,
          institution_id TEXT REFERENCES institutions(id)
        );

        CREATE TABLE activity_daily (
          user_id TEXT NOT NULL,
          institution_id TEXT,
          day TEXT NOT NULL,
          PRIMARY KEY (user_id, day),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (institution_id) REFERENCES institutions(id) ON DELETE CASCADE
        );

        CREATE TABLE internship_applications (
          id TEXT PRIMARY KEY,
          internship_id TEXT NOT NULL,
          applicant_id TEXT NOT NULL,
          note TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'APPLIED' CHECK(status IN ('APPLIED', 'SHORTLISTED', 'REJECTED')),
          created_at TEXT NOT NULL,
          UNIQUE(internship_id, applicant_id),
          FOREIGN KEY (internship_id) REFERENCES internships(id) ON DELETE CASCADE,
          FOREIGN KEY (applicant_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE event_rsvps (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(event_id, user_id),
          FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE program_participants (
          id TEXT PRIMARY KEY,
          program_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('MENTOR', 'MENTEE')),
          created_at TEXT NOT NULL,
          UNIQUE(program_id, user_id),
          FOREIGN KEY (program_id) REFERENCES mentorship_programs(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      // Seed parent records for valid FK operations
      db.exec(`
        INSERT INTO institutions (id) VALUES ('inst_1'), ('inst_2');
        INSERT INTO users (id, institution_id) VALUES ('u_1', 'inst_1'), ('u_2', 'inst_1'), ('u_3', 'inst_2');
        INSERT INTO internships (id, institution_id) VALUES ('int_1', 'inst_1'), ('int_2', 'inst_1');
        INSERT INTO events (id, institution_id) VALUES ('ev_1', 'inst_1'), ('ev_2', 'inst_1');
        INSERT INTO mentorship_programs (id, institution_id) VALUES ('prog_1', 'inst_1'), ('prog_2', 'inst_1');
      `);

      return db;
    }

    test('activity_daily: ignores composite PK duplicates and preserves initial row', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO activity_daily (user_id, institution_id, day) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial insert
      const res1 = ins.run('u_1', 'inst_1', '2026-11-15');
      assert.equal(res1.changes, 1);

      // Duplicate attempt with different institution_id
      const res2 = ins.run('u_1', 'inst_2', '2026-11-15');
      assert.equal(res2.changes, 0);

      // Verify row was not overwritten
      const row = db.prepare('SELECT * FROM activity_daily WHERE user_id = ? AND day = ?').get('u_1', '2026-11-15');
      assert.equal(row.institution_id, 'inst_1');

      // Non-conflicting insert on another day succeeds
      const res3 = ins.run('u_1', 'inst_2', '2026-11-16');
      assert.equal(res3.changes, 1);
      db.close();
    });

    test('internship_applications: ignores composite UNIQUE conflict and preserves initial row', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial application
      const res1 = ins.run('ia_1', 'int_1', 'u_1', 'Initial note', 'APPLIED', '2026-09-01');
      assert.equal(res1.changes, 1);

      // Duplicate on composite UNIQUE(internship_id, applicant_id) with different id
      const res2 = ins.run('ia_2', 'int_1', 'u_1', 'Second note', 'SHORTLISTED', '2026-09-02');
      assert.equal(res2.changes, 0);

      // Verify initial application is preserved
      const rows = db.prepare('SELECT * FROM internship_applications WHERE internship_id = ? AND applicant_id = ?').all('int_1', 'u_1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'ia_1');
      assert.equal(rows[0].status, 'APPLIED');
      assert.equal(rows[0].note, 'Initial note');
      db.close();
    });

    test('internship_applications: ignores PRIMARY KEY conflict with different composite key', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial application
      ins.run('ia_1', 'int_1', 'u_1', 'Initial note', 'APPLIED', '2026-09-01');

      // Duplicate on PRIMARY KEY 'ia_1' with different (internship_id, applicant_id)
      const res = ins.run('ia_1', 'int_2', 'u_2', 'Different pair', 'SHORTLISTED', '2026-09-02');
      assert.equal(res.changes, 0);

      // Verify table still has only 1 row
      const rows = db.prepare('SELECT * FROM internship_applications').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'ia_1');
      assert.equal(rows[0].internship_id, 'int_1');
      db.close();
    });

    test('event_rsvps: ignores composite UNIQUE conflict and preserves initial RSVP', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO event_rsvps (id, event_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial RSVP
      const res1 = ins.run('rs_1', 'ev_1', 'u_1', '2026-10-01');
      assert.equal(res1.changes, 1);

      // Duplicate RSVP for same event and user with different id
      const res2 = ins.run('rs_2', 'ev_1', 'u_1', '2026-10-02');
      assert.equal(res2.changes, 0);

      // Verify only initial RSVP exists
      const rows = db.prepare('SELECT * FROM event_rsvps WHERE event_id = ? AND user_id = ?').all('ev_1', 'u_1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'rs_1');
      assert.equal(rows[0].created_at, '2026-10-01');
      db.close();
    });

    test('event_rsvps: ignores PRIMARY KEY conflict with different composite key', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO event_rsvps (id, event_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial RSVP
      ins.run('rs_1', 'ev_1', 'u_1', '2026-10-01');

      // Duplicate on PK 'rs_1' with different (event_id, user_id)
      const res = ins.run('rs_1', 'ev_2', 'u_2', '2026-10-02');
      assert.equal(res.changes, 0);

      // Verify table still has only 1 row
      const rows = db.prepare('SELECT * FROM event_rsvps').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'rs_1');
      assert.equal(rows[0].event_id, 'ev_1');
      db.close();
    });

    test('program_participants: ignores composite UNIQUE conflict and preserves initial participation', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO program_participants (id, program_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial participant as MENTOR
      const res1 = ins.run('pp_1', 'prog_1', 'u_1', 'MENTOR', '2026-08-01');
      assert.equal(res1.changes, 1);

      // Duplicate insert attempting role change to MENTEE with different id
      const res2 = ins.run('pp_2', 'prog_1', 'u_1', 'MENTEE', '2026-08-02');
      assert.equal(res2.changes, 0);

      // Verify initial participation is preserved
      const rows = db.prepare('SELECT * FROM program_participants WHERE program_id = ? AND user_id = ?').all('prog_1', 'u_1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'pp_1');
      assert.equal(rows[0].role, 'MENTOR');
      db.close();
    });

    test('program_participants: ignores PRIMARY KEY conflict with different composite key', () => {
      const db = setupMemoryDb();
      const ins = db.prepare('INSERT INTO program_participants (id, program_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Initial participant
      ins.run('pp_1', 'prog_1', 'u_1', 'MENTOR', '2026-08-01');

      // Duplicate on PK 'pp_1' with different (program_id, user_id)
      const res = ins.run('pp_1', 'prog_2', 'u_2', 'MENTEE', '2026-08-02');
      assert.equal(res.changes, 0);

      // Verify table still has only 1 row
      const rows = db.prepare('SELECT * FROM program_participants').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'pp_1');
      assert.equal(rows[0].program_id, 'prog_1');
      db.close();
    });

    test('foreign-key violations still fail (not suppressed by ON CONFLICT DO NOTHING)', () => {
      const db = setupMemoryDb();
      const insApp = db.prepare('INSERT INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Non-existent applicant_id
      assert.throws(() => {
        insApp.run('ia_err', 'int_1', 'nonexistent_user', 'Note', 'APPLIED', '2026-09-01');
      }, /FOREIGN KEY constraint failed/);

      // Non-existent internship_id
      assert.throws(() => {
        insApp.run('ia_err2', 'nonexistent_intern', 'u_1', 'Note', 'APPLIED', '2026-09-01');
      }, /FOREIGN KEY constraint failed/);

      db.close();
    });

    test('CHECK and NOT NULL violations fail in SQLite ON CONFLICT DO NOTHING (unlike old INSERT OR IGNORE)', () => {
      const db = setupMemoryDb();
      const insApp = db.prepare('INSERT INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');

      // Invalid CHECK constraint status (fails fast as standard SQL requires)
      assert.throws(() => {
        insApp.run('ia_bad', 'int_1', 'u_1', 'Note', 'INVALID_STATUS', '2026-09-01');
      }, /CHECK constraint failed/);

      // NOT NULL constraint violation (note is NOT NULL)
      assert.throws(() => {
        insApp.run('ia_null', 'int_1', 'u_1', null, 'APPLIED', '2026-09-01');
      }, /NOT NULL constraint failed/);

      db.close();
    });
  });

  describe('PostgreSQL parameter translation for untargeted ON CONFLICT DO NOTHING statements', () => {
    test('activity_daily SQL translates to parameterized PostgreSQL syntax preserving ON CONFLICT DO NOTHING', () => {
      const sql = 'INSERT INTO activity_daily (user_id, institution_id, day) VALUES (?, ?, ?) ON CONFLICT DO NOTHING';
      const prepared = prepareSql(sql);
      assert.equal(prepared, 'INSERT INTO activity_daily (user_id, institution_id, day) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING');
    });

    test('internship_applications SQL translates to parameterized PostgreSQL syntax preserving ON CONFLICT DO NOTHING', () => {
      const sql = 'INSERT INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING';
      const prepared = prepareSql(sql);
      assert.equal(prepared, 'INSERT INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING');
    });

    test('event_rsvps SQL translates to parameterized PostgreSQL syntax preserving ON CONFLICT DO NOTHING', () => {
      const sql = 'INSERT INTO event_rsvps (id, event_id, user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING';
      const prepared = prepareSql(sql);
      assert.equal(prepared, 'INSERT INTO event_rsvps (id, event_id, user_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING');
    });

    test('program_participants SQL translates to parameterized PostgreSQL syntax preserving ON CONFLICT DO NOTHING', () => {
      const sql = 'INSERT INTO program_participants (id, program_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING';
      const prepared = prepareSql(sql);
      assert.equal(prepared, 'INSERT INTO program_participants (id, program_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING');
    });
  });

  describe('Batch 5: scalar comparisons and per-row random jitter compatibility', () => {
    function setupSeedDb() {
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE institutions (id TEXT PRIMARY KEY, created_at TEXT);
        CREATE TABLE users (id TEXT PRIMARY KEY, institution_id TEXT, created_at TEXT NOT NULL, last_active_at TEXT);
        CREATE TABLE mentorship_requests (id TEXT PRIMARY KEY, institution_id TEXT, created_at TEXT NOT NULL, responded_at TEXT, status TEXT, response_note TEXT, meeting_info TEXT);
        CREATE TABLE messages (id TEXT PRIMARY KEY, request_id TEXT, created_at TEXT NOT NULL);
      `);
      return db;
    }

    function testAgo(days, hours = 0) {
      const d = new Date(Date.now() - days * 86400000 - hours * 3600000);
      return d.toISOString().slice(0, 19).replace('T', ' ');
    }

    test('Case 1: users created_at bump updates older accounts, preserves newer ones and preserves WHERE', () => {
      const db = setupSeedDb();
      const created = testAgo(230);
      db.prepare('INSERT INTO institutions (id, created_at) VALUES (?, ?)').run('inst_a', created);
      db.prepare('INSERT INTO users (id, institution_id, created_at) VALUES (?, ?, ?)').run('u1', 'inst_a', testAgo(250)); // older
      db.prepare('INSERT INTO users (id, institution_id, created_at) VALUES (?, ?, ?)').run('u2', 'inst_a', testAgo(100)); // newer
      db.prepare('INSERT INTO users (id, institution_id, created_at) VALUES (?, ?, ?)').run('u3', 'inst_b', testAgo(250)); // other inst

      const stmt = db.prepare('UPDATE users SET created_at = ? WHERE institution_id = ? AND created_at < ?');
      stmt.run(created, 'inst_a', created);

      assert.equal(db.prepare('SELECT created_at FROM users WHERE id = ?').get('u1').created_at, created);
      assert.equal(db.prepare('SELECT created_at FROM users WHERE id = ?').get('u2').created_at, testAgo(100));
      assert.equal(db.prepare('SELECT created_at FROM users WHERE id = ?').get('u3').created_at, testAgo(250));

      // Translation test
      const pgSql = prepareSql('UPDATE users SET created_at = ? WHERE institution_id = ? AND created_at < ?');
      assert.equal(pgSql, 'UPDATE users SET created_at = $1 WHERE institution_id = $2 AND created_at < $3');
      db.close();
    });

    test('Case 2: Meridian requests shift preserves NULL responded_at and shifts non-null responses', () => {
      const db = setupSeedDb();
      db.prepare('INSERT INTO mentorship_requests (id, institution_id, created_at, responded_at, status) VALUES (?, ?, ?, ?, ?)').run(
        'mr_null', 'meridian', testAgo(10), null, 'PENDING'
      );
      db.prepare('INSERT INTO mentorship_requests (id, institution_id, created_at, responded_at, status) VALUES (?, ?, ?, ?, ?)').run(
        'mr_resp', 'meridian', testAgo(10), testAgo(9), 'ACCEPTED'
      );

      const sql = `UPDATE mentorship_requests SET created_at = datetime(created_at, '+7 days'),
          responded_at = CASE
            WHEN responded_at IS NULL THEN NULL
            WHEN datetime(responded_at, '+7 days') > datetime('now', '-1 hour') THEN datetime('now', '-1 hour')
            ELSE datetime(responded_at, '+7 days')
          END
        WHERE institution_id = 'meridian' AND created_at BETWEEN datetime('now', '-14 days') AND datetime('now', '-7 days')`;
      db.prepare(sql).run();

      const rNull = db.prepare('SELECT created_at, responded_at FROM mentorship_requests WHERE id = ?').get('mr_null');
      assert.equal(rNull.responded_at, null); // NULL behavior strictly preserved
      assert.equal(rNull.created_at, testAgo(3));

      const rResp = db.prepare('SELECT created_at, responded_at FROM mentorship_requests WHERE id = ?').get('mr_resp');
      assert.equal(rResp.created_at, testAgo(3));
      assert.equal(rResp.responded_at, testAgo(2));

      // Translation test
      const pgSql = prepareSql(sql);
      assert.ok(!pgSql.includes('MIN('), 'Must not contain scalar MIN()');
      assert.ok(pgSql.includes('to_char'), 'Must translate datetime expressions');
      db.close();
    });

    test('Case 3: Response clamp ensures reply is never before request nor in future', () => {
      const db = setupSeedDb();
      db.prepare('INSERT INTO mentorship_requests (id, institution_id, created_at, responded_at, status) VALUES (?, ?, ?, ?, ?)').run(
        'mr_bad', 'test', testAgo(5), testAgo(6), 'ACCEPTED'
      );

      const sql = `UPDATE mentorship_requests SET responded_at = CASE
          WHEN datetime(created_at, '+2 hours') > datetime('now', '-5 minutes') THEN datetime('now', '-5 minutes')
          ELSE datetime(created_at, '+2 hours')
        END
        WHERE responded_at IS NOT NULL AND responded_at < created_at`;
      db.prepare(sql).run();

      const res = db.prepare('SELECT created_at, responded_at FROM mentorship_requests WHERE id = ?').get('mr_bad');
      assert.equal(res.responded_at, testAgo(5, -2));

      // Translation test
      const pgSql = prepareSql(sql);
      assert.ok(!pgSql.includes('MIN('), 'Must not contain scalar MIN()');
      db.close();
    });

    test('Case 4: Messages clamps prevent messages before request and in the future', () => {
      const db = setupSeedDb();
      db.prepare('INSERT INTO mentorship_requests (id, created_at) VALUES (?, ?)').run('req_1', testAgo(5));
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_old', 'req_1', testAgo(7));
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_ok', 'req_1', testAgo(4));
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_fut', 'req_1', '2099-01-01 00:00:00');

      const sql4a = `UPDATE messages SET created_at = (SELECT r.created_at FROM mentorship_requests r WHERE r.id = messages.request_id)
        WHERE created_at < (SELECT r.created_at FROM mentorship_requests r WHERE r.id = messages.request_id)`;
      const selectCutoffSql = "SELECT datetime('now', '-30 minutes') AS cutoff";
      const updateCutoffSql = 'UPDATE messages SET created_at = ? WHERE created_at > ?';

      db.prepare(sql4a).run();
      const messageCutoff = db.prepare(selectCutoffSql).get().cutoff;
      db.prepare(updateCutoffSql).run(messageCutoff, messageCutoff);

      assert.equal(db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_old').created_at, testAgo(5));
      assert.equal(db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_ok').created_at, testAgo(4));
      assert.equal(db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_fut').created_at, messageCutoff);

      // Translation tests
      assert.ok(!prepareSql(sql4a).includes('MAX('));
      assert.equal(prepareSql(selectCutoffSql), "SELECT to_char(((statement_timestamp() AT TIME ZONE 'UTC') + interval '-30 minutes'), 'YYYY-MM-DD HH24:MI:SS') AS cutoff");
      assert.equal(prepareSql(updateCutoffSql), 'UPDATE messages SET created_at = $1 WHERE created_at > $2');
      db.close();
    });

    test('Case 4 boundary: Stable single-cutoff evaluation across exact, before, after, and future boundaries', () => {
      const db = setupSeedDb();
      const selectCutoffSql = "SELECT datetime('now', '-30 minutes') AS cutoff";
      const updateCutoffSql = 'UPDATE messages SET created_at = ? WHERE created_at > ?';
      const sql4a = `UPDATE messages SET created_at = (SELECT r.created_at FROM mentorship_requests r WHERE r.id = messages.request_id)
        WHERE created_at < (SELECT r.created_at FROM mentorship_requests r WHERE r.id = messages.request_id)`;

      const cutoff = db.prepare(selectCutoffSql).get().cutoff;
      assert.match(cutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

      const cutoffDate = new Date(cutoff.replace(' ', 'T') + 'Z');
      const oneSecBefore = new Date(cutoffDate.getTime() - 1000).toISOString().slice(0, 19).replace('T', ' ');
      const exactCutoff = cutoff;
      const oneSecAfter = new Date(cutoffDate.getTime() + 1000).toISOString().slice(0, 19).replace('T', ' ');
      const farFuture = '2099-01-01 12:00:00';

      db.prepare('INSERT INTO mentorship_requests (id, created_at) VALUES (?, ?)').run('req_norm', testAgo(10));
      db.prepare('INSERT INTO mentorship_requests (id, created_at) VALUES (?, ?)').run('req_fut', farFuture);

      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_before', 'req_norm', oneSecBefore);
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_exact', 'req_norm', exactCutoff);
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_after', 'req_norm', oneSecAfter);
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_far', 'req_norm', farFuture);
      db.prepare('INSERT INTO messages (id, request_id, created_at) VALUES (?, ?, ?)').run('m_bumped_fut', 'req_fut', testAgo(1));

      // Execute sequence: 4a then 4b with bound cutoff
      db.prepare(sql4a).run();
      db.prepare(updateCutoffSql).run(cutoff, cutoff);

      const resBefore = db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_before').created_at;
      const resExact = db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_exact').created_at;
      const resAfter = db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_after').created_at;
      const resFar = db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_far').created_at;
      const resBumpedFut = db.prepare('SELECT created_at FROM messages WHERE id = ?').get('m_bumped_fut').created_at;

      // 1. One second before cutoff: strictly untouched
      assert.equal(resBefore, oneSecBefore);
      // 2. Exact cutoff: untouched because condition is created_at > cutoff
      assert.equal(resExact, exactCutoff);
      // 3. One second after cutoff: clamped to cutoff
      assert.equal(resAfter, cutoff);
      // 4. Far future: clamped to cutoff
      assert.equal(resFar, cutoff);
      // 5. Bumped to request created_at (which was in future), then clamped to cutoff
      assert.equal(resBumpedFut, cutoff);
      // 6. All clamped rows share the exact identical cutoff value
      assert.equal(resAfter, resFar);
      assert.equal(resFar, resBumpedFut);

      db.close();
    });

    test('Case 5: Greenfield requests per-row random jitter assigns independent timestamps', () => {
      const db = setupSeedDb();
      db.prepare('INSERT INTO mentorship_requests (id, institution_id, created_at, status) VALUES (?, ?, ?, ?)').run('r1', 'greenfield', testAgo(2), 'ACCEPTED');
      db.prepare('INSERT INTO mentorship_requests (id, institution_id, created_at, status) VALUES (?, ?, ?, ?)').run('r2', 'greenfield', testAgo(3), 'ACCEPTED');
      db.prepare('INSERT INTO mentorship_requests (id, institution_id, created_at, status) VALUES (?, ?, ?, ?)').run('r3', 'other', testAgo(2), 'ACCEPTED');

      const selectSql = `SELECT id FROM mentorship_requests WHERE institution_id = 'greenfield' AND created_at > datetime('now', '-21 days')`;
      const updateSql = `UPDATE mentorship_requests SET created_at = ?, responded_at = NULL, status = 'PENDING', response_note = NULL, meeting_info = NULL WHERE id = ?`;

      const gfReqs = db.prepare(selectSql).all();
      assert.equal(gfReqs.length, 2);

      let seq = 0;
      const testInt = () => 21 + (seq++ % 10); // deterministic independent offsets 21 and 22
      const updateStmt = db.prepare(updateSql);
      for (const r of gfReqs) {
        updateStmt.run(testAgo(testInt()), r.id);
      }

      const resR1 = db.prepare('SELECT created_at, status FROM mentorship_requests WHERE id = ?').get('r1');
      const resR2 = db.prepare('SELECT created_at, status FROM mentorship_requests WHERE id = ?').get('r2');
      const resR3 = db.prepare('SELECT created_at, status FROM mentorship_requests WHERE id = ?').get('r3');

      assert.equal(resR1.status, 'PENDING');
      assert.equal(resR2.status, 'PENDING');
      assert.equal(resR3.status, 'ACCEPTED'); // untouched
      assert.notEqual(resR1.created_at, resR2.created_at, 'Each row must receive independent random jitter');

      // Translation tests
      assert.ok(prepareSql(selectSql).includes('to_char'));
      assert.equal(prepareSql(updateSql), 'UPDATE mentorship_requests SET created_at = $1, responded_at = NULL, status = \'PENDING\', response_note = NULL, meeting_info = NULL WHERE id = $2');
      db.close();
    });

    test('Case 6: Greenfield users per-row random jitter assigns independent timestamps', () => {
      const db = setupSeedDb();
      db.prepare('INSERT INTO users (id, institution_id, created_at, last_active_at) VALUES (?, ?, ?, ?)').run('u1', 'greenfield', testAgo(50), testAgo(2));
      db.prepare('INSERT INTO users (id, institution_id, created_at, last_active_at) VALUES (?, ?, ?, ?)').run('u2', 'greenfield', testAgo(50), testAgo(3));

      const selectSql = `SELECT id FROM users WHERE institution_id = 'greenfield' AND last_active_at > datetime('now', '-21 days')`;
      const updateSql = `UPDATE users SET last_active_at = ? WHERE id = ?`;

      const gfUsers = db.prepare(selectSql).all();
      assert.equal(gfUsers.length, 2);

      let seq = 0;
      const testInt = () => 21 + (seq++ % 10);
      const updateStmt = db.prepare(updateSql);
      for (const u of gfUsers) {
        updateStmt.run(testAgo(testInt()), u.id);
      }

      const resU1 = db.prepare('SELECT last_active_at FROM users WHERE id = ?').get('u1');
      const resU2 = db.prepare('SELECT last_active_at FROM users WHERE id = ?').get('u2');
      assert.notEqual(resU1.last_active_at, resU2.last_active_at, 'Each user must receive independent random jitter');

      // Translation tests
      assert.ok(prepareSql(selectSql).includes('to_char'));
      assert.equal(prepareSql(updateSql), 'UPDATE users SET last_active_at = $1 WHERE id = $2');
      db.close();
    });
  });
});
