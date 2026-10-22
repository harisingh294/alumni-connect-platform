import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import alumniRoutes from './routes/alumni.js';
import studentRoutes from './routes/student.js';
import { authMiddleware } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global authentication parsing middleware
app.use(authMiddleware);

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/alumni', alumniRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/discovery', studentRoutes); // Discovery endpoints shared with student router

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Alumni Connect Platform MVP',
    timestamp: new Date().toISOString()
  });
});

// Serve frontend static files
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Fallback to index.html for SPA client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Start server only when executed directly, not when imported by test runner
const isDirectRun = process.argv[1] && (process.argv[1].endsWith('server' + path.sep + 'index.js') || process.argv[1].endsWith('server/index.js'));
if (isDirectRun && process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`Alumni Connect Platform MVP Server Running`);
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`====================================================`);
  });
}

export default app;
