// Production start-up tasks:
//  - create the platform-team account from environment variables (no hard-coded password)
//  - optionally load the fictional reviewer sandbox the first time the server starts
import crypto from 'node:crypto';
import { db, databaseEngine } from './app-db.js';
import { hashPassword } from './auth.js';

export async function bootstrap() {
  if (databaseEngine === 'postgres') {
    const { runMigrations } = await import('./db/migrator.js');
    await runMigrations({ db });
  }

  const email = String(process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD || '';
  if (email && password) {
    if (password.length < 12) {
      console.warn('[bootstrap] PLATFORM_ADMIN_PASSWORD must be at least 12 characters; platform account not created.');
    } else {
      const existing = await db.get('SELECT id, role FROM users WHERE LOWER(email) = ?', email);
      if (!existing) {
        await db.run(`INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at)
          VALUES (?, NULL, ?, ?, 'SUPERADMIN', 'Platform Team', 'VERIFIED', date('now'))`,
          'u_platform_' + crypto.randomUUID().slice(0, 8), email, hashPassword(password));
        console.log(`[bootstrap] Platform account created for ${email}`);
      } else if (existing.role === 'SUPERADMIN' && process.env.PLATFORM_ADMIN_RESET_PASSWORD === 'true') {
        await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), existing.id);
        console.log('[bootstrap] Platform account password reset from environment');
      }
    }
  }

  if (process.env.SANDBOX === 'on') {
    if (databaseEngine === 'sqlite') {
      const { runSeed } = await import('./seed.js');
      const hasSandbox = await db.get('SELECT 1 FROM institutions WHERE is_sandbox = 1 LIMIT 1');
      if (!hasSandbox) {
        runSeed({ mode: 'sandbox' });
        console.log('[bootstrap] Reviewer sandbox loaded');
      }
    } else {
      console.warn('[bootstrap] Reviewer sandbox auto-seed is supported for SQLite only; skipping in PostgreSQL mode.');
    }
  }
}
