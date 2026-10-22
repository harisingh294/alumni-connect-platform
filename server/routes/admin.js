import express from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { db } from '../db.js';
import { requireAuth, requireRole } from '../auth.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Require ADMIN or SUPERADMIN for all admin routes
router.use(requireAuth, requireRole('ADMIN', 'SUPERADMIN'));

// Helper: resolve effective institution ID for admin
function getAdminInst(req) {
  if (req.user.role === 'SUPERADMIN' && req.query.inst) {
    return req.query.inst;
  }
  return req.user.institution_id;
}

// GET /api/admin/metrics
router.get('/metrics', (req, res) => {
  const instId = getAdminInst(req);

  // Total alumni for this institution
  const totalAlumni = db.prepare(`
    SELECT COUNT(*) as count FROM users WHERE institution_id = ? AND role = 'ALUMNI'
  `).get(instId).count;

  // Verified alumni
  const verifiedAlumni = db.prepare(`
    SELECT COUNT(*) as count FROM users WHERE institution_id = ? AND role = 'ALUMNI' AND verification_status = 'VERIFIED'
  `).get(instId).count;

  // Pending verification queue
  const pendingReview = db.prepare(`
    SELECT COUNT(*) as count FROM users WHERE institution_id = ? AND role = 'ALUMNI' AND verification_status = 'PENDING'
  `).get(instId).count;

  // Alumni open to mentoring (verified only)
  const openToMentoring = db.prepare(`
    SELECT COUNT(*) as count
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND ap.is_open_to_mentoring = 1
  `).get(instId).count;

  // Mentorship request breakdown
  const reqCounts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'ACCEPTED' THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'DECLINED' THEN 1 ELSE 0 END) as declined
    FROM mentorship_requests
    WHERE institution_id = ?
  `).get(instId);

  // Roster stats
  const rosterStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'CLAIMED' THEN 1 ELSE 0 END) as claimed
    FROM roster_records
    WHERE institution_id = ?
  `).get(instId);

  res.json({
    institution_id: instId,
    total_alumni: totalAlumni,
    verified_alumni: verifiedAlumni,
    pending_review: pendingReview,
    open_to_mentoring: openToMentoring,
    requests: {
      total: reqCounts.total || 0,
      accepted: reqCounts.accepted || 0,
      pending: reqCounts.pending || 0,
      declined: reqCounts.declined || 0
    },
    roster: {
      total: rosterStats.total || 0,
      claimed: rosterStats.claimed || 0
    }
  });
});

// GET /api/admin/directory
router.get('/directory', (req, res) => {
  const instId = getAdminInst(req);
  const q = (req.query.q || '').trim().toLowerCase();
  const status = (req.query.status || '').trim().toUpperCase();

  let query = `
    SELECT u.id, u.full_name, u.email, u.verification_status, u.reject_reason, u.verified_at,
           ap.graduation_year, ap.degree, ap.branch, ap.current_company, ap.current_role,
           ap.industry, ap.location, ap.is_open_to_mentoring, ap.visibility, ap.stale_months
    FROM users u
    LEFT JOIN alumni_profiles ap ON u.id = ap.user_id
    WHERE u.institution_id = ? AND u.role = 'ALUMNI'
  `;
  const params = [instId];

  if (status && ['VERIFIED', 'PENDING', 'REJECTED'].includes(status)) {
    query += ` AND u.verification_status = ?`;
    params.push(status);
  }

  if (q) {
    query += ` AND (LOWER(u.full_name) LIKE ? OR LOWER(ap.current_company) LIKE ? OR LOWER(ap.current_role) LIKE ? OR CAST(ap.graduation_year AS TEXT) LIKE ?)`;
    const searchPattern = `%${q}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  query += ` ORDER BY ap.graduation_year DESC, u.full_name ASC LIMIT 100`;

  const rows = db.prepare(query).all(...params);
  res.json({ rows, count: rows.length });
});

// GET /api/admin/verification-queue
router.get('/verification-queue', (req, res) => {
  const instId = getAdminInst(req);

  const pending = db.prepare(`
    SELECT u.id, u.full_name, u.email, u.created_at,
           ap.graduation_year, ap.degree, ap.branch, ap.current_company, ap.current_role,
           ap.industry, ap.location, ap.linkedin_url, ap.bio
    FROM users u
    JOIN alumni_profiles ap ON u.id = ap.user_id
    WHERE u.institution_id = ? AND u.role = 'ALUMNI' AND u.verification_status = 'PENDING'
    ORDER BY u.created_at ASC
  `).all(instId);

  const recentDecisions = db.prepare(`
    SELECT u.id, u.full_name, u.verification_status, u.verified_at, u.reject_reason,
           ap.graduation_year, ap.degree, ap.current_company
    FROM users u
    JOIN alumni_profiles ap ON u.id = ap.user_id
    WHERE u.institution_id = ? AND u.role = 'ALUMNI' AND u.verification_status IN ('VERIFIED', 'REJECTED')
    ORDER BY u.verified_at DESC LIMIT 10
  `).all(instId);

  res.json({ pending, recent_decisions: recentDecisions });
});

// POST /api/admin/verification/:id/decide
router.post('/verification/:id/decide', (req, res) => {
  const instId = getAdminInst(req);
  const targetUserId = req.params.id;
  const { decision, reject_reason } = req.body;

  if (!['VERIFIED', 'REJECTED'].includes(decision)) {
    return res.status(400).json({ error: "Decision must be 'VERIFIED' or 'REJECTED'" });
  }

  if (decision === 'REJECTED' && (!reject_reason || reject_reason.trim().length < 5)) {
    return res.status(400).json({ error: 'A specific reason is required to reject (at least 5 characters)' });
  }

  const user = db.prepare('SELECT id, institution_id, role, verification_status FROM users WHERE id = ?').get(targetUserId);
  if (!user || user.institution_id !== instId || user.role !== 'ALUMNI') {
    return res.status(404).json({ error: 'Alumnus not found in your institution' });
  }

  const now = new Date().toISOString().slice(0, 10);

  if (decision === 'VERIFIED') {
    db.prepare(`
      UPDATE users
      SET verification_status = 'VERIFIED', verified_at = ?, reject_reason = NULL
      WHERE id = ?
    `).run(now, targetUserId);
  } else {
    db.prepare(`
      UPDATE users
      SET verification_status = 'REJECTED', verified_at = ?, reject_reason = ?
      WHERE id = ?
    `).run(now, reject_reason.trim(), targetUserId);
  }

  res.json({
    success: true,
    user_id: targetUserId,
    verification_status: decision,
    verified_at: now
  });
});

// POST /api/admin/roster/upload (CSV Roster Upload)
router.post('/roster/upload', upload.single('file'), (req, res) => {
  const instId = getAdminInst(req);

  let csvContent = '';
  if (req.file) {
    csvContent = req.file.buffer.toString('utf8');
  } else if (req.body.csv_text) {
    csvContent = req.body.csv_text;
  } else {
    return res.status(400).json({ error: 'Please upload a CSV file or provide csv_text' });
  }

  const lines = csvContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return res.status(400).json({ error: 'CSV file must contain a header line and at least one data row' });
  }

  // Parse Header: name, email, batch (or graduation_year), degree, branch
  const header = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));
  const nameIdx = header.findIndex(h => h.includes('name'));
  const emailIdx = header.findIndex(h => h.includes('email'));
  const batchIdx = header.findIndex(h => h.includes('batch') || h.includes('year'));
  const degreeIdx = header.findIndex(h => h.includes('degree'));
  const branchIdx = header.findIndex(h => h.includes('branch') || h.includes('major'));

  if (nameIdx === -1 || emailIdx === -1) {
    return res.status(400).json({
      error: 'CSV must contain at least "name" and "email" columns (e.g. name, email, batch, degree, branch)'
    });
  }

  const insertRoster = db.prepare(`
    INSERT INTO roster_records (id, institution_id, email, full_name, graduation_year, degree, branch, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'UNCLAIMED')
  `);

  const checkExisting = db.prepare(`
    SELECT id FROM roster_records WHERE institution_id = ? AND LOWER(email) = ?
  `);

  let imported = 0;
  let skipped = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const rawCols = lines[i].split(',').map(c => c.trim().replace(/^["']|["']$/g, ''));
    const fullName = rawCols[nameIdx];
    const email = (rawCols[emailIdx] || '').toLowerCase();
    const batch = batchIdx !== -1 ? parseInt(rawCols[batchIdx], 10) || 2024 : 2024;
    const degree = degreeIdx !== -1 && rawCols[degreeIdx] ? rawCols[degreeIdx] : 'B.Tech';
    const branch = branchIdx !== -1 && rawCols[branchIdx] ? rawCols[branchIdx] : 'General';

    if (!fullName || !email || !email.includes('@')) {
      errors.push(`Row ${i + 1}: Invalid name or email`);
      continue;
    }

    if (checkExisting.get(instId, email)) {
      skipped++;
      continue;
    }

    try {
      insertRoster.run('rr_' + crypto.randomUUID().slice(0, 8), instId, email, fullName, batch, degree, branch);
      imported++;
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  }

  res.json({
    success: true,
    total_rows: lines.length - 1,
    imported_count: imported,
    skipped_duplicates: skipped,
    errors
  });
});

// GET /api/admin/roster
router.get('/roster', (req, res) => {
  const instId = getAdminInst(req);
  const records = db.prepare(`
    SELECT id, email, full_name, graduation_year, degree, branch, status, imported_at
    FROM roster_records
    WHERE institution_id = ?
    ORDER BY imported_at DESC LIMIT 100
  `).all(instId);

  res.json({ records, count: records.length });
});

// GET /api/admin/analytics
router.get('/analytics', (req, res) => {
  const instId = getAdminInst(req);

  // 1. By Graduating Batch
  const byBatch = db.prepare(`
    SELECT ap.graduation_year as batch, COUNT(*) as count
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED'
    GROUP BY ap.graduation_year
    ORDER BY ap.graduation_year DESC
  `).all(instId);

  // 2. Top Employers
  const byEmployer = db.prepare(`
    SELECT ap.current_company as company, COUNT(*) as count
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND ap.current_company != ''
    GROUP BY ap.current_company
    ORDER BY count DESC LIMIT 8
  `).all(instId);

  // 3. Top Industries
  const byIndustry = db.prepare(`
    SELECT ap.industry, COUNT(*) as count
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND ap.industry != ''
    GROUP BY ap.industry
    ORDER BY count DESC LIMIT 8
  `).all(instId);

  // 4. Top Locations / Cities
  const byLocation = db.prepare(`
    SELECT ap.location, COUNT(*) as count
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND ap.location != ''
    GROUP BY ap.location
    ORDER BY count DESC LIMIT 8
  `).all(instId);

  // 5. Mentorship by Batch
  const mentorByBatch = db.prepare(`
    SELECT ap.graduation_year as batch, COUNT(*) as count
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND ap.is_open_to_mentoring = 1
    GROUP BY ap.graduation_year
    ORDER BY ap.graduation_year DESC
  `).all(instId);

  // 6. Data Freshness Panel
  const freshnessBuckets = db.prepare(`
    SELECT
      SUM(CASE WHEN ap.stale_months < 12 THEN 1 ELSE 0 END) as fresh,
      SUM(CASE WHEN ap.stale_months >= 12 AND ap.stale_months < 24 THEN 1 ELSE 0 END) as aging,
      SUM(CASE WHEN ap.stale_months >= 24 THEN 1 ELSE 0 END) as stale,
      COUNT(*) as total
    FROM alumni_profiles ap
    JOIN users u ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED'
  `).get(instId);

  res.json({
    by_batch: byBatch,
    by_employer: byEmployer,
    by_industry: byIndustry,
    by_location: byLocation,
    mentor_by_batch: mentorByBatch,
    freshness: freshnessBuckets
  });
});

export default router;
