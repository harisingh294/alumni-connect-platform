import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';
import { touchActive, currentDay } from '../server/auth.js';
import { prepareSql } from '../server/db/pg-backend.js';

describe('touchActive: engine-neutral activity tracking', () => {
  const testInstId1 = 'inst_act_test_1';
  const testInstId2 = 'inst_act_test_2';
  const testUserId1 = 'usr_act_1';
  const testUserId2 = 'usr_act_2';

  before(() => {
    // Insert valid institutions
    const insertInst = db.prepare(`
      INSERT INTO institutions (id, name, short_name, abbr, domain, city, state, type, founded)
      VALUES (?, 'Activity Inst', 'ActInst', 'AI', 'act.example', 'City', 'State', 'Government', 2000)
    `);
    insertInst.run(testInstId1);
    insertInst.run(testInstId2);

    // Insert valid users (admin_level is NULL for students)
    const insertUser = db.prepare(`
      INSERT INTO users (id, institution_id, email, password_hash, role, admin_level, full_name, verification_status, is_active)
      VALUES (?, ?, ?, 'hash:dummy', 'STUDENT', NULL, ?, 'VERIFIED', 1)
    `);
    insertUser.run(testUserId1, testInstId1, 'act1@act.example', 'Activity User 1');
    insertUser.run(testUserId2, testInstId1, 'act2@act.example', 'Activity User 2');
  });

  test('currentDay produces UTC YYYY-MM-DD date string', () => {
    const day = currentDay();
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD format');
    assert.equal(day, new Date().toISOString().slice(0, 10), 'must match UTC ISO date');
  });

  test('first activity insert creates a new activity_daily record', () => {
    const user1 = { id: testUserId1, institution_id: testInstId1 };
    touchActive.run(user1, '2026-11-01');

    const row = db.prepare('SELECT * FROM activity_daily WHERE user_id = ? AND day = ?').get(testUserId1, '2026-11-01');
    assert.ok(row, 'activity record must be created');
    assert.equal(row.user_id, testUserId1);
    assert.equal(row.institution_id, testInstId1);
    assert.equal(row.day, '2026-11-01');
  });

  test('repeated activity on the same day is a no-op (does not duplicate or throw)', () => {
    const user1 = { id: testUserId1, institution_id: testInstId1 };
    touchActive.run(user1, '2026-11-01');
    touchActive.run(user1, '2026-11-01');

    const count = db.prepare('SELECT COUNT(*) as n FROM activity_daily WHERE user_id = ? AND day = ?').get(testUserId1, '2026-11-01').n;
    assert.equal(count, 1, 'must have exactly one row per user per day');
  });

  test('repeated activity does not overwrite existing data', () => {
    // Attempt insert with different valid institution_id on the same day
    const userDifferentInst = { id: testUserId1, institution_id: testInstId2 };
    touchActive.run(userDifferentInst, '2026-11-01');

    const row = db.prepare('SELECT * FROM activity_daily WHERE user_id = ? AND day = ?').get(testUserId1, '2026-11-01');
    assert.equal(row.institution_id, testInstId1, 'existing record must NOT be overwritten on conflict');
  });

  test('activity on a different day creates a distinct record', () => {
    const user1 = { id: testUserId1, institution_id: testInstId1 };
    touchActive.run(user1, '2026-11-02');

    const rows = db.prepare('SELECT * FROM activity_daily WHERE user_id = ? ORDER BY day ASC').all(testUserId1);
    assert.equal(rows.length, 2, 'user must now have 2 distinct daily records');
    assert.equal(rows[0].day, '2026-11-01');
    assert.equal(rows[1].day, '2026-11-02');
  });

  test('default invocation without date parameter uses currentDay()', () => {
    const user2 = { id: testUserId2, institution_id: testInstId1 };
    touchActive.run(user2);

    const todayStr = currentDay();
    const row = db.prepare('SELECT * FROM activity_daily WHERE user_id = ? AND day = ?').get(testUserId2, todayStr);
    assert.ok(row, 'record with today date must exist');
    assert.equal(row.day, todayStr);
  });

  test('activity_daily SQL translates to valid PostgreSQL parameter syntax', () => {
    const rawSql = `
      INSERT INTO activity_daily (user_id, institution_id, day)
      VALUES (?, ?, ?)
      ON CONFLICT (user_id, day) DO NOTHING
    `;
    const pgSql = prepareSql(rawSql);
    assert.ok(pgSql.includes('VALUES ($1, $2, $3)'));
    assert.ok(pgSql.includes('ON CONFLICT (user_id, day) DO NOTHING'));
  });
});
