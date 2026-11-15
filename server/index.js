import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import alumniRoutes from './routes/alumni.js';
import studentRoutes from './routes/student.js';
import discoveryRoutes from './routes/discovery.js';
import institutionRoutes from './routes/institutions.js';
import subscriptionRoutes from './routes/subscriptions.js';
import internshipRoutes from './routes/internships.js';
import adminInstitutionRoutes from './routes/admin_institution.js';
import adminCommunityRoutes from './routes/admin_community.js';
import billingRoutes from './routes/billing.js';
import communityRoutes from './routes/community.js';
import meRoutes from './routes/me.js';
import platformRoutes from './routes/platform.js';
import { feedbackRoutes, platformFeedbackRoutes } from './routes/feedback.js';
import { bootstrap } from './bootstrap.js';
import { authMiddleware } from './auth.js';
import { securityHeaders } from './security.js';
import { isUniqueViolation } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
// Behind a hosting proxy (Render, Railway, Fly), trust the first hop so rate limits see the real client IP.
if (process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Parses the Bearer token (if any) into req.user.
app.use(authMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/admin/institution', adminInstitutionRoutes);
app.use('/api/admin/community', adminCommunityRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/me', meRoutes);
app.use('/api/platform/feedback', platformFeedbackRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/alumni', alumniRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/institutions', institutionRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/internships', internshipRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'AlumVerse', version: process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || 'local', timestamp: new Date().toISOString() });
});

// Unknown API routes return JSON 404 instead of the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// SPA fallback (client uses hash routing, so this only serves the shell).
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That upload is too large. Please split it into smaller files.' });
  }
  if (isUniqueViolation(err)) {
    return res.status(409).json({ error: 'This record already exists.' });
  }
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const isDirectRun = process.argv[1] && (process.argv[1].endsWith('server' + path.sep + 'index.js') || process.argv[1].endsWith('server/index.js'));
if (isDirectRun && process.env.NODE_ENV !== 'test') {
  try {
    await bootstrap();
    app.listen(PORT, () => {
      console.log('====================================================');
      console.log('AlumVerse Server Running');
      console.log(`URL: http://localhost:${PORT}`);
      console.log('====================================================');
    });
  } catch (err) {
    console.error('FATAL: Server bootstrap failed:', err);
    process.exit(1);
  }
}

export default app;
