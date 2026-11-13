import crypto from 'node:crypto';
import { db } from './db.js';

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required.');
}

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

export function verifyPassword(password, storedHash) {
  const [salt, key] = String(storedHash || '').split(':');
  if (!salt || !key) return false;
  const derivedKey = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey);
}

export function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// Prepared lazily so importing this module never fails on an outdated database
// (npm run seed imports it before rebuilding the schema).
let touchStmt = null;
let dayStmt = null;
const touchActive = {
  run: (user) => {
    touchStmt ??= db.prepare(`
      UPDATE users SET last_active_at = datetime('now')
      WHERE id = ? AND (last_active_at IS NULL OR last_active_at < datetime('now', '-10 minutes'))
    `);
    // Record one row per user per day of use (feeds weekly active-user evidence).
    dayStmt ??= db.prepare(`INSERT OR IGNORE INTO activity_daily (user_id, institution_id, day) VALUES (?, ?, date('now'))`);
    dayStmt.run(user.id, user.institution_id || null); // no-op after the first request of the day
    return touchStmt.run(user.id);
  }
};

// Loads the user on every request, so deactivating or deleting an account
// takes effect immediately even if the token has not expired.
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  req.user = null;
  if (!token) return next();

  const payload = verifyToken(token);
  if (!payload || !payload.id) return next();

  const user = db.prepare(`
    SELECT id, institution_id, email, role, admin_level, full_name, verification_status, is_active, is_sandbox
    FROM users WHERE id = ?
  `).get(payload.id);
  if (user && user.is_active) {
    req.user = user;
    touchActive.run(user);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

// No role bypasses this check: platform staff (SUPERADMIN) are deliberately
// kept out of institution and member routes.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have access to this section' });
    }
    next();
  };
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== 'ADMIN' || req.user.admin_level !== 'OWNER') {
    return res.status(403).json({ error: 'Only the institution owner can do this' });
  }
  next();
}

// Demo persona switching hands out tokens without a password, so it is disabled
// when NODE_ENV=production unless ENABLE_DEMO_LOGIN=true is set explicitly.
export function demoLoginEnabled() {
  if (process.env.ENABLE_DEMO_LOGIN === 'true') return true;
  if (process.env.ENABLE_DEMO_LOGIN === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
