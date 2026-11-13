// Audit trail of every administrative action on an institution's data.
// Institutions can read and export their own log; it is deleted with the institution.
import crypto from 'node:crypto';
import { db } from './db.js';

export function audit(req, institutionId, action, { targetType = null, targetId = null, details = null } = {}) {
  if (!institutionId) return;
  const u = req?.user;
  db.prepare(`
    INSERT INTO audit_logs (id, institution_id, actor_id, actor_name, actor_role, action, target_type, target_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'al_' + crypto.randomUUID().slice(0, 12), institutionId,
    u?.id || null, u?.full_name || 'System', u ? (u.admin_level ? `${u.role}:${u.admin_level}` : u.role) : 'SYSTEM',
    action, targetType, targetId, details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)).slice(0, 2000)
  );
}

export function platformLog(action, details) {
  db.prepare('INSERT INTO platform_log (id, action, details) VALUES (?, ?, ?)')
    .run('pl_' + crypto.randomUUID().slice(0, 12), action, details ? JSON.stringify(details) : null);
}
