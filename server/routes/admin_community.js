// Engagement tools for institution admins: announcements, events, mentorship programs.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth, requireRole } from '../auth.js';
import { requireActiveInstitution, requireFeature } from '../billing.js';
import { audit } from '../audit.js';

const router = express.Router();
router.use(requireAuth, requireRole('ADMIN'));

const instOf = (req) => req.user.institution_id;
const s = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const newId = (p) => `${p}_${crypto.randomUUID().slice(0, 10)}`;
const AUDIENCES = ['ALL', 'STUDENTS', 'ALUMNI'];
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Announcements ----------

router.get('/announcements', asyncRoute(async (req, res) => {
  res.json({ announcements: await db.all(`
    SELECT a.*, u.full_name as author_name FROM announcements a LEFT JOIN users u ON a.author_id = u.id
    WHERE a.institution_id = ? ORDER BY a.pinned DESC, a.created_at DESC LIMIT 100
  `, instOf(req)) });
}));

router.post('/announcements', requireActiveInstitution, asyncRoute(async (req, res) => {
  const title = s(req.body.title, 120);
  const body = s(req.body.body, 3000);
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'ALL';
  if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
  const id = newId('an');
  await db.run('INSERT INTO announcements (id, institution_id, author_id, title, body, audience, pinned) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, instOf(req), req.user.id, title, body, audience, req.body.pinned ? 1 : 0);
  await audit(req, instOf(req), 'ANNOUNCEMENT_POSTED', { targetType: 'announcement', targetId: id, details: { title, audience } });
  res.status(201).json({ success: true, id });
}));

router.delete('/announcements/:id', asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM announcements WHERE id = ? AND institution_id = ?', req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Announcement not found' });
  await audit(req, instOf(req), 'ANNOUNCEMENT_DELETED', { targetType: 'announcement', targetId: req.params.id });
  res.json({ success: true });
}));

// ---------- Events ----------

router.get('/events', asyncRoute(async (req, res) => {
  res.json({ events: await db.all(`
    SELECT e.*, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) as rsvp_count
    FROM events e WHERE e.institution_id = ? ORDER BY e.starts_at DESC LIMIT 100
  `, instOf(req)) });
}));

router.get('/events/:id/rsvps', asyncRoute(async (req, res) => {
  const ev = await db.get('SELECT id FROM events WHERE id = ? AND institution_id = ?', req.params.id, instOf(req));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  res.json({ rsvps: await db.all(`
    SELECT u.full_name, u.email, u.role, r.created_at FROM event_rsvps r JOIN users u ON r.user_id = u.id
    WHERE r.event_id = ? ORDER BY r.created_at, u.full_name, u.email
  `, ev.id) });
}));

router.post('/events', requireFeature('events'), asyncRoute(async (req, res) => {
  const title = s(req.body.title, 120);
  const description = s(req.body.description, 3000);
  const startsAt = String(req.body.starts_at || '');
  const mode = req.body.mode === 'IN_PERSON' ? 'IN_PERSON' : 'ONLINE';
  const audience = AUDIENCES.includes(req.body.audience) ? req.body.audience : 'ALL';
  const capacity = req.body.capacity ? Math.max(1, parseInt(req.body.capacity, 10) || 0) : null;
  if (!title || !description) return res.status(400).json({ error: 'Title and description are required' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startsAt)) return res.status(400).json({ error: 'Please choose a valid date and time' });
  const id = newId('ev');
  await db.run(`INSERT INTO events (id, institution_id, title, description, starts_at, mode, location, audience, capacity, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, instOf(req), title, description, startsAt.slice(0, 16).replace('T', ' '), mode,
    s(req.body.location, 200), audience, capacity, req.user.id);
  await audit(req, instOf(req), 'EVENT_CREATED', { targetType: 'event', targetId: id, details: title });
  res.status(201).json({ success: true, id });
}));

router.delete('/events/:id', asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM events WHERE id = ? AND institution_id = ?', req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Event not found' });
  await audit(req, instOf(req), 'EVENT_DELETED', { targetType: 'event', targetId: req.params.id });
  res.json({ success: true });
}));

// ---------- Mentorship programs ----------

router.get('/programs', asyncRoute(async (req, res) => {
  const programs = await db.all(`
    SELECT p.*,
      (SELECT COUNT(*) FROM program_participants pp WHERE pp.program_id = p.id AND pp.role = 'MENTOR') as mentor_count,
      (SELECT COUNT(*) FROM program_participants pp WHERE pp.program_id = p.id AND pp.role = 'MENTEE') as mentee_count,
      (SELECT COUNT(*) FROM program_participants pp WHERE pp.program_id = p.id AND pp.role = 'MENTEE' AND pp.matched_with IS NOT NULL) as matched_count
    FROM mentorship_programs p WHERE p.institution_id = ? ORDER BY p.created_at DESC
  `, instOf(req));
  res.json({ programs });
}));

router.get('/programs/:id', asyncRoute(async (req, res) => {
  const p = await db.get('SELECT * FROM mentorship_programs WHERE id = ? AND institution_id = ?', req.params.id, instOf(req));
  if (!p) return res.status(404).json({ error: 'Program not found' });
  const participants = await db.all(`
    SELECT pp.user_id, pp.role, pp.matched_with, pp.created_at, u.full_name, m.full_name as matched_name,
           COALESCE(sp.branch, ap.current_company) as detail
    FROM program_participants pp JOIN users u ON pp.user_id = u.id
    LEFT JOIN users m ON pp.matched_with = m.id
    LEFT JOIN student_profiles sp ON sp.user_id = u.id LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
    WHERE pp.program_id = ? ORDER BY pp.role, u.full_name
  `, p.id);
  res.json({ program: p, participants });
}));

router.post('/programs', requireFeature('programs'), asyncRoute(async (req, res) => {
  const title = s(req.body.title, 120);
  const description = s(req.body.description, 2000);
  const topic = s(req.body.topic, 60) || 'Career Guidance';
  if (!title || !description) return res.status(400).json({ error: 'Title and description are required' });
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null);
  const id = newId('mp');
  await db.run(`INSERT INTO mentorship_programs (id, institution_id, title, description, topic, starts_on, ends_on, mentee_capacity, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, instOf(req), title, description, topic, date(req.body.starts_on), date(req.body.ends_on),
    req.body.mentee_capacity ? Math.max(1, parseInt(req.body.mentee_capacity, 10) || 0) : null, req.user.id);
  await audit(req, instOf(req), 'PROGRAM_CREATED', { targetType: 'program', targetId: id, details: title });
  res.status(201).json({ success: true, id });
}));

router.post('/programs/:id/close', asyncRoute(async (req, res) => {
  const r = await db.run("UPDATE mentorship_programs SET status = 'CLOSED' WHERE id = ? AND institution_id = ?", req.params.id, instOf(req));
  if (!r.changes) return res.status(404).json({ error: 'Program not found' });
  await audit(req, instOf(req), 'PROGRAM_CLOSED', { targetType: 'program', targetId: req.params.id });
  res.json({ success: true });
}));

// POST /api/admin/community/programs/:id/match — pair unmatched mentees with the least-loaded mentors.
// Each match opens an accepted mentorship (with private messaging) between the pair.
router.post('/programs/:id/match', requireFeature('programs'), asyncRoute(async (req, res) => {
  const instId = instOf(req);
  const p = await db.get('SELECT * FROM mentorship_programs WHERE id = ? AND institution_id = ?', req.params.id, instId);
  if (!p) return res.status(404).json({ error: 'Program not found' });

  const mentors = await db.all(`
    SELECT pp.user_id, (SELECT COUNT(*) FROM program_participants x WHERE x.program_id = pp.program_id AND x.matched_with = pp.user_id) as load
    FROM program_participants pp WHERE pp.program_id = ? AND pp.role = 'MENTOR'
  `, p.id);
  const mentees = await db.all(`SELECT user_id FROM program_participants WHERE program_id = ? AND role = 'MENTEE' AND matched_with IS NULL ORDER BY created_at`, p.id);
  if (!mentors.length) return res.status(400).json({ error: 'No mentors have joined this program yet' });

  let matched = 0;
  await db.transaction(async (tx) => {
    for (const m of mentees) {
      mentors.sort((a, b) => a.load - b.load);
      const mentor = mentors[0];
      await tx.run('UPDATE program_participants SET matched_with = ? WHERE program_id = ? AND user_id = ?', mentor.user_id, p.id, m.user_id); // mentee -> mentor (a mentor can have several mentees)
      await tx.run(`
        INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, program_id, topic, message, status, response_note, meeting_info, responded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACCEPTED', ?, ?, datetime('now'))
      `, 'req_' + crypto.randomUUID().slice(0, 8), instId, m.user_id, mentor.user_id, p.id, p.topic,
        `Matched through the "${p.title}" mentorship program.`, 'You have been matched through your institution’s program.',
        'Use the private messages on this mentorship to agree a time and channel.');
      mentor.load += 1;
      matched++;
    }
  });
  await audit(req, instId, 'PROGRAM_MATCHED', { targetType: 'program', targetId: p.id, details: { matched } });
  res.json({ success: true, matched });
}));

// ---------- Mentorship overview ----------

router.get('/mentorship', asyncRoute(async (req, res) => {
  const instId = instOf(req);
  const byTopic = await db.all(`SELECT topic, COUNT(*) as count, SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted
    FROM mentorship_requests WHERE institution_id = ? GROUP BY topic ORDER BY count DESC, topic ASC`, instId);
  const topMentors = await db.all(`
    SELECT u.full_name, ap.current_company, COUNT(*) as accepted
    FROM mentorship_requests r JOIN users u ON r.alumni_id = u.id LEFT JOIN alumni_profiles ap ON ap.user_id = u.id
    WHERE r.institution_id = ? AND r.status = 'ACCEPTED' GROUP BY r.alumni_id, u.full_name, ap.current_company ORDER BY accepted DESC, u.full_name ASC, r.alumni_id ASC LIMIT 10
  `, instId);
  const waitingRow = await db.get(`SELECT COUNT(*) as n FROM mentorship_requests WHERE institution_id = ? AND status = 'PENDING' AND created_at < datetime('now', '-7 days')`, instId);
  res.json({ by_topic: byTopic, top_mentors: topMentors, waiting_over_7_days: waitingRow?.n || 0 });
}));

export default router;
