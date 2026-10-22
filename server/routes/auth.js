import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { hashPassword, verifyPassword, createToken, requireAuth } from '../auth.js';

const router = express.Router();

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = db.prepare(`
    SELECT u.id, u.institution_id, u.email, u.password_hash, u.role, u.full_name,
           u.verification_status, u.reject_reason, i.name as institution_name, i.short_name as institution_short
    FROM users u
    JOIN institutions i ON u.institution_id = i.id
    WHERE LOWER(u.email) = LOWER(?)
  `).get(email.trim());

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = createToken({ id: user.id, email: user.email, role: user.role });
  const { password_hash, ...safeUser } = user;

  res.json({ token, user: safeUser });
});

// POST /api/auth/register
// Hybrid auto-matching: If email is in roster_records, auto-verifies as VERIFIED.
// Otherwise, marked as PENDING for admin review.
router.post('/register', (req, res) => {
  const { institution_id, email, password, role, full_name, graduation_year, degree, branch, current_company, current_role } = req.body;

  if (!institution_id || !email || !password || !role || !full_name) {
    return res.status(400).json({ error: 'Institution, email, password, role, and full name are required' });
  }

  const validRoles = ['ALUMNI', 'STUDENT', 'ADMIN'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid user role' });
  }

  const cleanEmail = email.trim().toLowerCase();

  // Check if user already exists
  const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(cleanEmail);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  // Check roster for pre-verification match
  let verificationStatus = 'PENDING';
  let verifiedAt = null;

  const rosterRecord = db.prepare(`
    SELECT id FROM roster_records
    WHERE institution_id = ? AND LOWER(email) = ? AND status = 'UNCLAIMED'
  `).get(institution_id, cleanEmail);

  if (rosterRecord) {
    verificationStatus = 'VERIFIED';
    verifiedAt = new Date().toISOString().slice(0, 10);
    db.prepare("UPDATE roster_records SET status = 'CLAIMED' WHERE id = ?").run(rosterRecord.id);
  } else if (role === 'STUDENT') {
    // Current students registered with institution domain default to VERIFIED in MVP
    verificationStatus = 'VERIFIED';
    verifiedAt = new Date().toISOString().slice(0, 10);
  }

  const userId = 'u_' + crypto.randomUUID().slice(0, 8);
  const pwHash = hashPassword(password);

  db.prepare(`
    INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, institution_id, cleanEmail, pwHash, role, full_name.trim(), verificationStatus, verifiedAt);

  // Initialize specific profile
  const year = parseInt(graduation_year, 10) || (role === 'STUDENT' ? 2027 : 2023);
  const deg = degree || 'B.Tech';
  const br = branch || 'General';

  if (role === 'ALUMNI') {
    const profId = 'ap_' + crypto.randomUUID().slice(0, 8);
    const co = current_company || 'Independent';
    const r = current_role || 'Software Engineer';
    db.prepare(`
      INSERT INTO alumni_profiles (
        id, user_id, graduation_year, degree, branch, current_company, current_role,
        industry, location, is_open_to_mentoring, visibility, details_confirmed_at, stale_months
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'PUBLIC', datetime('now'), 0)
    `).run(profId, userId, year, deg, br, co, r, 'Technology', 'Bengaluru');

    // Add graduation step
    db.prepare(`
      INSERT INTO career_steps (id, alumni_profile_id, year, role, company, is_current, display_order)
      VALUES (?, ?, ?, ?, ?, 0, 1)
    `).run('cs_' + crypto.randomUUID().slice(0, 8), profId, year, `Graduated · ${deg}`, 'Institution');

    db.prepare(`
      INSERT INTO career_steps (id, alumni_profile_id, year, role, company, is_current, display_order)
      VALUES (?, ?, ?, ?, ?, 1, 2)
    `).run('cs_' + crypto.randomUUID().slice(0, 8), profId, 2026, r, co);
  } else if (role === 'STUDENT') {
    const sProfId = 'sp_' + crypto.randomUUID().slice(0, 8);
    db.prepare(`
      INSERT INTO student_profiles (id, user_id, graduation_year, degree, branch)
      VALUES (?, ?, ?, ?, ?)
    `).run(sProfId, userId, year, deg, br);
  }

  const token = createToken({ id: userId, email: cleanEmail, role });
  const inst = db.prepare('SELECT name, short_name FROM institutions WHERE id = ?').get(institution_id);

  res.status(201).json({
    token,
    user: {
      id: userId,
      institution_id,
      email: cleanEmail,
      role,
      full_name: full_name.trim(),
      verification_status: verificationStatus,
      institution_name: inst?.name,
      institution_short: inst?.short_name
    }
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.institution_id, u.email, u.role, u.full_name, u.verification_status, u.reject_reason,
           i.name as institution_name, i.short_name as institution_short, i.abbr as institution_abbr, i.hue as institution_hue
    FROM users u
    JOIN institutions i ON u.institution_id = i.id
    WHERE u.id = ?
  `).get(req.user.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  let profile = null;
  if (user.role === 'ALUMNI') {
    profile = db.prepare('SELECT * FROM alumni_profiles WHERE user_id = ?').get(user.id);
    if (profile) {
      profile.skills = JSON.parse(profile.skills_json || '[]');
      profile.mentorship_topics = JSON.parse(profile.mentorship_topics_json || '[]');
      profile.career_steps = db.prepare('SELECT * FROM career_steps WHERE alumni_profile_id = ? ORDER BY display_order ASC, year ASC').all(profile.id);
    }
  } else if (user.role === 'STUDENT') {
    profile = db.prepare('SELECT * FROM student_profiles WHERE user_id = ?').get(user.id);
  }

  res.json({ user, profile });
});

// POST /api/auth/demo-switch (Quick persona switch for testing/evaluating MVP user journeys)
router.post('/demo-switch', (req, res) => {
  const { persona } = req.body;
  let targetEmail = null;

  switch (persona) {
    case 'admin':
      targetEmail = 'admin@iitb.ac.in';
      break;
    case 'alumni':
      targetEmail = 'rohan@example.com';
      break;
    case 'student':
      targetEmail = 'ishita@example.com';
      break;
    case 'superadmin':
      targetEmail = 'superadmin@alumniplatform.com';
      break;
    default:
      return res.status(400).json({ error: 'Unknown persona' });
  }

  const user = db.prepare(`
    SELECT u.id, u.institution_id, u.email, u.role, u.full_name, u.verification_status,
           i.name as institution_name, i.short_name as institution_short, i.abbr as institution_abbr, i.hue as institution_hue
    FROM users u
    JOIN institutions i ON u.institution_id = i.id
    WHERE u.email = ?
  `).get(targetEmail);

  if (!user) {
    return res.status(404).json({ error: 'Persona account not found' });
  }

  const token = createToken({ id: user.id, email: user.email, role: user.role });
  res.json({ token, user });
});

export default router;
