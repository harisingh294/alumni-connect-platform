// Member-facing community features: institution feed, events, programs, and
// private mentorship messages.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../app-db.js';
import { requireAuth } from '../auth.js';
import { memberCommunityAccess, sendBlocked } from '../access.js';
import { hasFeature } from '../billing.js';

const router = express.Router();
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireAuth);

const newId = (p) => `${p}_${crypto.randomUUID().slice(0, 10)}`;
const audienceFor = (role) => (role === 'STUDENT' ? 'STUDENTS' : 'ALUMNI');

async function requireMember(req, res, next) {
  try {
    const a = await memberCommunityAccess(req.user);
    if (!a.allowed) return sendBlocked(res, a);
    return next();
  } catch (err) {
    return next(err);
  }
}

// GET /api/community/feed — announcements, upcoming events and open programs of my institution.
router.get('/feed', requireMember, asyncRoute(async (req, res) => {
  const u = req.user;
  const aud = audienceFor(u.role);
  const announcements = await db.all(`
    SELECT id, title, body, audience, pinned, created_at FROM announcements
    WHERE institution_id = ? AND audience IN ('ALL', ?) ORDER BY pinned DESC, created_at DESC LIMIT 10
  `, u.institution_id, aud);

  const events = (await hasFeature(u.institution_id, 'events')) ? await db.all(`
    SELECT e.id, e.title, e.description, e.starts_at, e.mode, e.location, e.capacity,
      (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) as rsvp_count,
      CASE WHEN EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) THEN 1 ELSE 0 END as going
    FROM events e WHERE e.institution_id = ? AND e.audience IN ('ALL', ?) AND e.starts_at >= datetime('now', '-1 day')
    ORDER BY e.starts_at LIMIT 10
  `, u.id, u.institution_id, aud) : [];

  const programs = (await hasFeature(u.institution_id, 'programs')) ? await db.all(`
    SELECT p.id, p.title, p.description, p.topic, p.starts_on, p.ends_on, p.status,
      pp.role as my_role, m.full_name as matched_name
    FROM mentorship_programs p
    LEFT JOIN program_participants pp ON pp.program_id = p.id AND pp.user_id = ?
    LEFT JOIN users m ON m.id = pp.matched_with
    WHERE p.institution_id = ? AND (p.status = 'OPEN' OR pp.user_id IS NOT NULL)
    ORDER BY p.created_at DESC LIMIT 10
  `, u.id, u.institution_id) : [];

  res.json({ announcements, events, programs });
}));

// POST /api/community/events/:id/rsvp — toggle my RSVP.
router.post('/events/:id/rsvp', requireMember, asyncRoute(async (req, res) => {
  const u = req.user;
  const ev = await db.get(`SELECT id, capacity, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = events.id) as taken
    FROM events WHERE id = ? AND institution_id = ? AND audience IN ('ALL', ?)`, req.params.id, u.institution_id, audienceFor(u.role));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const existing = await db.get('SELECT id FROM event_rsvps WHERE event_id = ? AND user_id = ?', ev.id, u.id);
  if (existing) {
    await db.run('DELETE FROM event_rsvps WHERE id = ?', existing.id);
    return res.json({ going: false });
  }
  if (ev.capacity && ev.taken >= ev.capacity) return res.status(409).json({ error: 'This event is full' });
  await db.run('INSERT INTO event_rsvps (id, event_id, user_id) VALUES (?, ?, ?)', newId('rs'), ev.id, u.id);
  res.json({ going: true });
}));

// POST /api/community/programs/:id/join — students join as mentees, verified alumni as mentors.
router.post('/programs/:id/join', requireMember, asyncRoute(async (req, res) => {
  const u = req.user;
  if (u.verification_status !== 'VERIFIED') return res.status(403).json({ error: 'Your account must be verified by your institution first' });
  const p = await db.get(`SELECT id, mentee_capacity, status FROM mentorship_programs WHERE id = ? AND institution_id = ?`, req.params.id, u.institution_id);
  if (!p || p.status !== 'OPEN') return res.status(404).json({ error: 'Program not found or closed' });
  const role = u.role === 'ALUMNI' ? 'MENTOR' : 'MENTEE';
  if (role === 'MENTEE' && p.mentee_capacity) {
    const row = await db.get("SELECT COUNT(*) as n FROM program_participants WHERE program_id = ? AND role = 'MENTEE'", p.id);
    const taken = row?.n ?? 0;
    if (taken >= p.mentee_capacity) return res.status(409).json({ error: 'This program is full' });
  }
  try {
    await db.run('INSERT INTO program_participants (id, program_id, user_id, role) VALUES (?, ?, ?, ?)', newId('pp'), p.id, u.id, role);
  } catch {
    return res.status(409).json({ error: 'You have already joined this program' });
  }
  res.status(201).json({ success: true, role });
}));

router.post('/programs/:id/leave', requireMember, asyncRoute(async (req, res) => {
  const r = await db.run('DELETE FROM program_participants WHERE program_id = ? AND user_id = ? AND matched_with IS NULL', req.params.id, req.user.id);
  if (!r.changes) return res.status(400).json({ error: 'You are not in this program, or you have already been matched' });
  res.json({ success: true });
}));

// ---------- Private messages on an accepted mentorship ----------

async function conversationFor(req) {
  const r = await db.get(`
    SELECT r.id, r.status, r.student_id, r.alumni_id, r.topic, s.full_name as student_name, a.full_name as alumni_name
    FROM mentorship_requests r JOIN users s ON r.student_id = s.id JOIN users a ON r.alumni_id = a.id
    WHERE r.id = ?
  `, req.params.id);
  if (!r || (r.student_id !== req.user.id && r.alumni_id !== req.user.id)) return null;
  return r;
}

router.get('/conversations/:id/messages', asyncRoute(async (req, res) => {
  const c = await conversationFor(req);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const messages = await db.all(`
    SELECT m.id, m.body, m.created_at, m.sender_id, u.full_name as sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.request_id = ? ORDER BY m.created_at, m.rowid
  `, c.id);
  res.json({ conversation: c, messages, can_send: c.status === 'ACCEPTED' });
}));

router.post('/conversations/:id/messages', asyncRoute(async (req, res) => {
  const c = await conversationFor(req);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  if (c.status !== 'ACCEPTED') return res.status(403).json({ error: 'Messages open once the mentorship request is accepted' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
  if (body.length > 2000) return res.status(400).json({ error: 'Please keep messages under 2000 characters' });
  const id = newId('msg');
  await db.run('INSERT INTO messages (id, request_id, sender_id, body) VALUES (?, ?, ?, ?)', id, c.id, req.user.id, body);
  res.status(201).json({ success: true, id });
}));

export default router;
