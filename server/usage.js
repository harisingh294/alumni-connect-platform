// Usage report for one institution: counts only, never names, emails or message text.
// Built for design-partner usage evidence: account creation date, active users,
// records created, and activity by week for the last 4 weeks.
import { db } from './db.js';

const n = (sql, ...p) => db.prepare(sql).get(...p).n || 0;

// Four rolling 7-day windows ending today, oldest first.
function weekWindows(count = 4) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const end = new Date(Date.now() - i * 7 * 86400000);
    const start = new Date(end.getTime() - 6 * 86400000);
    out.push({ start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
  }
  return out;
}

export function usageReport(instId) {
  const inst = db.prepare('SELECT id, name, short_name, kind, created_at, is_sandbox FROM institutions WHERE id = ?').get(instId);
  if (!inst) return null;

  // Each row of a week: [label, SQL counting rows of that kind between ? and ? (inclusive dates)]
  const WEEKLY = [
    ['active_users', `SELECT COUNT(DISTINCT user_id) as n FROM activity_daily WHERE institution_id = ? AND day BETWEEN ? AND ?`],
    ['new_members', `SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role IN ('STUDENT','ALUMNI') AND date(created_at) BETWEEN ? AND ?`],
    ['members_verified', `SELECT COUNT(*) as n FROM audit_logs WHERE institution_id = ? AND action = 'MEMBER_VERIFIED' AND date(created_at) BETWEEN ? AND ?`],
    ['mentorship_requests', `SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND date(created_at) BETWEEN ? AND ?`],
    ['mentorships_accepted', `SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND status = 'ACCEPTED' AND date(responded_at) BETWEEN ? AND ?`],
    ['messages', `SELECT COUNT(*) as n FROM messages m JOIN mentorship_requests r ON m.request_id = r.id WHERE r.institution_id = ? AND date(m.created_at) BETWEEN ? AND ?`],
    ['internships_posted', `SELECT COUNT(*) as n FROM internships WHERE institution_id = ? AND date(created_at) BETWEEN ? AND ?`],
    ['internship_applications', `SELECT COUNT(*) as n FROM internship_applications a JOIN internships n ON a.internship_id = n.id WHERE n.institution_id = ? AND date(a.created_at) BETWEEN ? AND ?`],
    ['announcements', `SELECT COUNT(*) as n FROM announcements WHERE institution_id = ? AND date(created_at) BETWEEN ? AND ?`],
    ['event_rsvps', `SELECT COUNT(*) as n FROM event_rsvps r JOIN events e ON r.event_id = e.id WHERE e.institution_id = ? AND date(r.created_at) BETWEEN ? AND ?`],
    ['admin_actions', `SELECT COUNT(*) as n FROM audit_logs WHERE institution_id = ? AND date(created_at) BETWEEN ? AND ?`]
  ];

  const weeks = weekWindows(4).map(w => {
    const row = { week_start: w.start, week_end: w.end };
    for (const [key, sql] of WEEKLY) row[key] = n(sql, instId, w.start, w.end);
    row.used = row.active_users > 0 || row.admin_actions > 0 || row.mentorship_requests > 0;
    return row;
  });

  const totals = {
    verified_students: n(`SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'STUDENT' AND verification_status = 'VERIFIED' AND is_active = 1`, instId),
    verified_alumni: n(`SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ALUMNI' AND verification_status = 'VERIFIED' AND is_active = 1`, instId),
    admins: n(`SELECT COUNT(*) as n FROM users WHERE institution_id = ? AND role = 'ADMIN'`, instId),
    active_users_7d: n(`SELECT COUNT(DISTINCT user_id) as n FROM activity_daily WHERE institution_id = ? AND day >= date('now', '-6 days')`, instId),
    active_users_30d: n(`SELECT COUNT(DISTINCT user_id) as n FROM activity_daily WHERE institution_id = ? AND day >= date('now', '-29 days')`, instId),
    roster_records: n('SELECT COUNT(*) as n FROM roster_records WHERE institution_id = ?', instId),
    mentorship_requests: n('SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ?', instId),
    mentorships_accepted: n("SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND status = 'ACCEPTED'", instId),
    messages: n('SELECT COUNT(*) as n FROM messages m JOIN mentorship_requests r ON m.request_id = r.id WHERE r.institution_id = ?', instId),
    internships_posted: n('SELECT COUNT(*) as n FROM internships WHERE institution_id = ?', instId),
    internship_applications: n('SELECT COUNT(*) as n FROM internship_applications a JOIN internships i ON a.internship_id = i.id WHERE i.institution_id = ?', instId),
    announcements: n('SELECT COUNT(*) as n FROM announcements WHERE institution_id = ?', instId),
    events: n('SELECT COUNT(*) as n FROM events WHERE institution_id = ?', instId),
    admin_actions: n('SELECT COUNT(*) as n FROM audit_logs WHERE institution_id = ?', instId)
  };

  const lastActive = db.prepare(`SELECT MAX(last_active_at) as t FROM users WHERE institution_id = ?`).get(instId).t;

  return {
    generated_at: new Date().toISOString(),
    institution: { id: inst.id, name: inst.name, kind: inst.kind, account_created: inst.created_at, sandbox: Boolean(inst.is_sandbox) },
    last_active_at: lastActive,
    weeks_used_of_last_3: weeks.slice(1).filter(w => w.used).length,
    totals,
    weeks
  };
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(header, rows) {
  return [header.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
}

// CSV laid out for the Phase 2 usage-evidence folder: summary block, then one row per week.
export function usageCsv(report) {
  const t = report.totals;
  const summary = toCsv(['Field', 'Value'], [
    ['Institution', report.institution.name],
    ['Account created', report.institution.account_created],
    ['Report generated', report.generated_at],
    ['Last activity', report.last_active_at || 'never'],
    ['Active users (last 7 days)', t.active_users_7d],
    ['Active users (last 30 days)', t.active_users_30d],
    ['Verified students', t.verified_students],
    ['Verified alumni', t.verified_alumni],
    ['Admins', t.admins],
    ['Mentorship requests (all time)', t.mentorship_requests],
    ['Mentorships accepted (all time)', t.mentorships_accepted],
    ['Mentorship messages (all time)', t.messages],
    ['Internships posted (all time)', t.internships_posted],
    ['Internship applications (all time)', t.internship_applications],
    ['Admin actions logged (all time)', t.admin_actions]
  ]);
  const weekly = toCsv(
    ['Week start', 'Week end', 'Active users', 'New members', 'Members verified', 'Mentorship requests', 'Mentorships accepted',
      'Messages', 'Internships posted', 'Internship applications', 'Announcements', 'Event RSVPs', 'Admin actions'],
    report.weeks.map(w => [w.week_start, w.week_end, w.active_users, w.new_members, w.members_verified, w.mentorship_requests,
      w.mentorships_accepted, w.messages, w.internships_posted, w.internship_applications, w.announcements, w.event_rsvps, w.admin_actions])
  );
  return `${summary}\n\nActivity by week (last 4 weeks)\n${weekly}\n\nCounts only. No names, emails or message contents are included.\n`;
}
