// Member-facing community features: institution feed, events, programs, and
// private mentorship messages.
import express from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import { memberCommunityAccess, sendBlocked } from '../access.js';
import { hasFeature } from '../billing.js';

const router = express.Router();
router.use(requireAuth);

const newId = (p) => `${p}_${crypto.randomUUID().slice(0, 10)}`;
const audienceFor = (role) => (role === 'STUDENT' ? 'STUDENTS' : 'ALUMNI');

function requireMember(req, res, next) {
  const a = memberCommunityAccess(req.user);
  if (!a.allowed) return sendBlocked(res, a);
  next();
}

// GET /api/community/feed — announcements, upcoming events and open programs of my institution.
router.get('/feed', requireMember, (req, res) => {
  const u = req.user;
  const aud = audienceFor(u.role);
  const announcements = db.prepare(`
    SELECT id, title, body, audience, pinned, created_at FROM announcements
    WHERE institution_id = ? AND audience IN ('ALL', ?) ORDER BY pinned DESC, created_at DESC LIMIT 10
  `).all(u.institution_id, aud);

  const events = hasFeature(u.institution_id, 'events') ? db.prepare(`
    SELECT e.id, e.title, e.description, e.starts_at, e.mode, e.location, e.capacity,
      (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) as rsvp_count,
      EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) as going
    FROM events e WHERE e.institution_id = ? AND e.audience IN ('ALL', ?) AND e.starts_at >= datetime('now', '-1 day')
    ORDER BY e.starts_at LIMIT 10
  `).all(u.id, u.institution_id, aud) : [];

  const programs = hasFeature(u.institution_id, 'programs') ? db.prepare(`
    SELECT p.id, p.title, p.description, p.topic, p.starts_on, p.ends_on, p.status,
      pp.role as my_role, m.full_name as matched_name
    FROM mentorship_programs p
    LEFT JOIN program_participants pp ON pp.program_id = p.id AND pp.user_id = ?
    LEFT JOIN users m ON m.id = pp.matched_with
    WHERE p.institution_id = ? AND (p.status = 'OPEN' OR pp.user_id IS NOT NULL)
    ORDER BY p.created_at DESC LIMIT 10
  `).all(u.id, u.institution_id) : [];

  res.json({ announcements, events, programs });
});

// POST /api/community/events/:id/rsvp — toggle my RSVP.
router.post('/events/:id/rsvp', requireMember, (req, res) => {
  const u = req.user;
  const ev = db.prepare(`SELECT id, capacity, (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = events.id) as taken
    FROM events WHERE id = ? AND institution_id = ? AND audience IN ('ALL', ?)`).get(req.params.id, u.institution_id, audienceFor(u.role));
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  const existing = db.prepare('SELECT id FROM event_rsvps WHERE event_id = ? AND user_id = ?').get(ev.id, u.id);
  if (existing) {
    db.prepare('DELETE FROM event_rsvps WHERE id = ?').run(existing.id);
    return res.json({ going: false });
  }
  if (ev.capacity && ev.taken >= ev.capacity) return res.status(409).json({ error: 'This event is full' });
  db.prepare('INSERT INTO event_rsvps (id, event_id, user_id) VALUES (?, ?, ?)').run(newId('rs'), ev.id, u.id);
  res.json({ going: true });
});

// POST /api/community/programs/:id/join — students join as mentees, verified alumni as mentors.
router.post('/programs/:id/join', requireMember, (req, res) => {
  const u = req.user;
  if (u.verification_status !== 'VERIFIED') return res.status(403).json({ error: 'Your account must be verified by your institution first' });
  const p = db.prepare(`SELECT id, mentee_capacity, status FROM mentorship_programs WHERE id = ? AND institution_id = ?`).get(req.params.id, u.institution_id);
  if (!p || p.status !== 'OPEN') return res.status(404).json({ error: 'Program not found or closed' });
  const role = u.role === 'ALUMNI' ? 'MENTOR' : 'MENTEE';
  if (role === 'MENTEE' && p.mentee_capacity) {
    const taken = db.prepare("SELECT COUNT(*) as n FROM program_participants WHERE program_id = ? AND role = 'MENTEE'").get(p.id).n;
    if (taken >= p.mentee_capacity) return res.status(409).json({ error: 'This program is full' });
  }
  try {
    db.prepare('INSERT INTO program_participants (id, program_id, user_id, role) VALUES (?, ?, ?, ?)').run(newId('pp'), p.id, u.id, role);
  } catch {
    return res.status(409).json({ error: 'You have already joined this program' });
  }
  res.status(201).json({ success: true, role });
});

router.post('/programs/:id/leave', requireMember, (req, res) => {
  const r = db.prepare('DELETE FROM program_participants WHERE program_id = ? AND user_id = ? AND matched_with IS NULL').run(req.params.id, req.user.id);
  if (!r.changes) return res.status(400).json({ error: 'You are not in this program, or you have already been matched' });
  res.json({ success: true });
});

// ---------- Private messages on an accepted mentorship ----------

function conversationFor(req) {
  const r = db.prepare(`
    SELECT r.id, r.status, r.student_id, r.alumni_id, r.topic, s.full_name as student_name, a.full_name as alumni_name
    FROM mentorship_requests r JOIN users s ON r.student_id = s.id JOIN users a ON r.alumni_id = a.id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!r || (r.student_id !== req.user.id && r.alumni_id !== req.user.id)) return null;
  return r;
}

router.get('/conversations/:id/messages', (req, res) => {
  const c = conversationFor(req);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  const messages = db.prepare(`
    SELECT m.id, m.body, m.created_at, m.sender_id, u.full_name as sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.request_id = ? ORDER BY m.created_at, m.rowid
  `).all(c.id);
  res.json({ conversation: c, messages, can_send: c.status === 'ACCEPTED' });
});

router.post('/conversations/:id/messages', (req, res) => {
  const c = conversationFor(req);
  if (!c) return res.status(404).json({ error: 'Conversation not found' });
  if (c.status !== 'ACCEPTED') return res.status(403).json({ error: 'Messages open once the mentorship request is accepted' });
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty' });
  if (body.length > 2000) return res.status(400).json({ error: 'Please keep messages under 2000 characters' });
  const id = newId('msg');
  db.prepare('INSERT INTO messages (id, request_id, sender_id, body) VALUES (?, ?, ?, ?)').run(id, c.id, req.user.id, body);
  res.status(201).json({ success: true, id });
});

export default router;
