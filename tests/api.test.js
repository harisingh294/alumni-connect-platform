import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../server/index.js';
import { runSeed } from '../server/seed.js';

describe('Alumni Connect Platform MVP - Backend API Test Suite', () => {
  let server;
  let baseUrl;
  let adminToken;
  let alumniToken;
  let studentToken;

  before(async () => {
    // Fresh seed for test run
    runSeed();
    server = app.listen(0);
    const port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(() => {
    if (server) server.close();
  });

  test('GET /api/health returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
  });

  test('POST /api/auth/login authenticates Admin, Alumni and Student', async () => {
    // 1. Admin Login
    const adminRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@iitb.ac.in', password: 'admin123' })
    });
    assert.equal(adminRes.status, 200);
    const adminData = await adminRes.json();
    assert.ok(adminData.token);
    assert.equal(adminData.user.role, 'ADMIN');
    adminToken = adminData.token;

    // 2. Alumni Login
    const alumRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'rohan@example.com', password: 'alumni123' })
    });
    assert.equal(alumRes.status, 200);
    const alumData = await alumRes.json();
    assert.ok(alumData.token);
    assert.equal(alumData.user.role, 'ALUMNI');
    alumniToken = alumData.token;

    // 3. Student Login
    const stuRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ishita@example.com', password: 'student123' })
    });
    assert.equal(stuRes.status, 200);
    const stuData = await stuRes.json();
    assert.ok(stuData.token);
    assert.equal(stuData.user.role, 'STUDENT');
    studentToken = stuData.token;
  });

  test('POST /api/auth/register with roster match auto-verifies account', async () => {
    // Matches pre-seeded roster entry: new.graduate@alumni.iitb.ac.in
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        institution_id: 'iitb',
        email: 'new.graduate@alumni.iitb.ac.in',
        password: 'password123',
        role: 'ALUMNI',
        full_name: 'Siddharth Varma',
        graduation_year: 2024,
        degree: 'B.Tech',
        branch: 'Computer Science',
        current_company: 'Microsoft',
        current_role: 'Software Engineer'
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.user.verification_status, 'VERIFIED');
  });

  test('POST /api/auth/register without roster match enters PENDING verification queue', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        institution_id: 'iitb',
        email: 'unlisted.graduate@gmail.com',
        password: 'password123',
        role: 'ALUMNI',
        full_name: 'Harish Test Alum',
        graduation_year: 2022,
        degree: 'B.Tech',
        branch: 'Electrical',
        current_company: 'Startup Inc',
        current_role: 'Engineer'
      })
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.user.verification_status, 'PENDING');
  });

  test('GET /api/admin/metrics returns real-time institutional KPIs', async () => {
    const res = await fetch(`${baseUrl}/api/admin/metrics`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(res.status, 200);
    const metrics = await res.json();
    assert.ok(metrics.total_alumni > 50);
    assert.ok(metrics.verified_alumni > 40);
    assert.ok(metrics.pending_review >= 5);
    assert.ok(metrics.open_to_mentoring > 10);
    assert.ok(metrics.requests.total >= 3);
  });

  test('POST /api/admin/roster/upload parses and imports CSV records', async () => {
    const csvData = `name,email,batch,degree,branch\nAayush Verma,aayush.v@iitb.ac.in,2023,B.Tech,Mechanical\nKritika Sengupta,kritika.s@iitb.ac.in,2022,M.Tech,CSE`;
    const res = await fetch(`${baseUrl}/api/admin/roster/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ csv_text: csvData })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.imported_count, 2);
  });

  test('GET /api/admin/verification-queue and POST decision approves pending claims', async () => {
    const queueRes = await fetch(`${baseUrl}/api/admin/verification-queue`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.equal(queueRes.status, 200);
    const queue = await queueRes.json();
    assert.ok(queue.pending.length > 0);
    const target = queue.pending[0];

    // Approve claim
    const decideRes = await fetch(`${baseUrl}/api/admin/verification/${target.id}/decide`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ decision: 'VERIFIED' })
    });
    assert.equal(decideRes.status, 200);
    const decision = await decideRes.json();
    assert.equal(decision.verification_status, 'VERIFIED');
  });

  test('GET /api/discovery/alumni filters across 7 dimensions', async () => {
    const res = await fetch(`${baseUrl}/api/discovery/alumni?inst=iitb&mentor_only=1`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.results.length > 0);
    for (const alum of data.results) {
      assert.equal(alum.institution_id, 'iitb');
      assert.equal(alum.is_open_to_mentoring, 1);
      assert.equal(alum.verification_status, 'VERIFIED');
    }
  });

  test('GET /api/discovery/alumni keyword search supports full-name, partial, and combined filters', async () => {
    // 1. Full-name search
    const fullNameRes = await fetch(`${baseUrl}/api/discovery/alumni?q=Harish%20Test%20Alum`);
    assert.equal(fullNameRes.status, 200);
    const fullNameData = await fullNameRes.json();
    assert.ok(fullNameData.results.length >= 1);
    const matchedFull = fullNameData.results.find(a => a.full_name === 'Harish Test Alum');
    assert.ok(matchedFull, 'Should find Harish Test Alum on full-name search');

    // 2. Partial keyword searches: "Harish", "Test", "Alum"
    const part1 = await (await fetch(`${baseUrl}/api/discovery/alumni?q=Harish`)).json();
    assert.ok(part1.results.some(a => a.full_name.includes('Harish')));

    const part2 = await (await fetch(`${baseUrl}/api/discovery/alumni?q=Test`)).json();
    assert.ok(part2.results.some(a => a.full_name.includes('Test')));

    const part3 = await (await fetch(`${baseUrl}/api/discovery/alumni?q=Alum`)).json();
    assert.ok(part3.results.some(a => a.full_name.includes('Alum')));

    // 3. Combined keyword + existing filters
    const combinedRes = await fetch(`${baseUrl}/api/discovery/alumni?q=Harish&company=Google&mentor_only=1`);
    assert.equal(combinedRes.status, 200);
    const combinedData = await combinedRes.json();
    assert.ok(combinedData.results.length >= 1);
    assert.equal(combinedData.results[0].full_name, 'Harish Test Alum');
    assert.equal(combinedData.results[0].current_company, 'Google');
    assert.equal(combinedData.results[0].is_open_to_mentoring, 1);

    // 4. Clearing keyword returns unfiltered directory
    const allRes = await fetch(`${baseUrl}/api/discovery/alumni`);
    const allData = await allRes.json();
    const emptyQRes = await fetch(`${baseUrl}/api/discovery/alumni?q=`);
    const emptyQData = await emptyQRes.json();
    assert.equal(emptyQData.results.length, allData.results.length);
  });

  test('End-to-End Closed Loop: Mentorship Request -> Handshake Accept -> Meeting Info Reveal', async () => {
    // 1. Student sends structured request to Rohan Deshpande
    const reqRes = await fetch(`${baseUrl}/api/student/requests`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${studentToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        alumni_id: 'u_alumni_rohan',
        topic: 'Resume Review',
        message: 'Hello Rohan, could you please review my backend engineering resume for upcoming tech roles? I have 3 open-source projects.'
      })
    });
    assert.equal(reqRes.status, 201);
    const reqData = await reqRes.json();
    assert.equal(reqData.status, 'PENDING');
    const newRequestId = reqData.request_id;

    // 2. Alumnus sees inbound request in inbox
    const inboxRes = await fetch(`${baseUrl}/api/alumni/requests`, {
      headers: { 'Authorization': `Bearer ${alumniToken}` }
    });
    assert.equal(inboxRes.status, 200);
    const inbox = await inboxRes.json();
    const found = inbox.requests.find(r => r.id === newRequestId);
    assert.ok(found);
    assert.equal(found.status, 'PENDING');

    // 3. Alumnus accepts request and provides meeting coordinates
    const meetingDetails = 'Google Meet: https://meet.google.com/test-e2e-slot | Friday 5:00 PM IST';
    const acceptRes = await fetch(`${baseUrl}/api/alumni/requests/${newRequestId}/respond`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${alumniToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status: 'ACCEPTED',
        response_note: 'Looking forward to reviewing your resume!',
        meeting_info: meetingDetails
      })
    });
    assert.equal(acceptRes.status, 200);

    // 4. Student checks their requests and verifies unlocked meeting info
    const myReqsRes = await fetch(`${baseUrl}/api/student/requests`, {
      headers: { 'Authorization': `Bearer ${studentToken}` }
    });
    assert.equal(myReqsRes.status, 200);
    const myReqs = await myReqsRes.json();
    const resolvedReq = myReqs.requests.find(r => r.id === newRequestId);
    assert.ok(resolvedReq);
    assert.equal(resolvedReq.status, 'ACCEPTED');
    assert.equal(resolvedReq.meeting_info, meetingDetails);
  });
});
