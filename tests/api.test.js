// Runs against a dedicated temporary database created per test process by tests/preload.js
// (node --import, see the "test" script) in the OS temp directory. The repository's data/ folder
// and any real database are never touched. Run one file with:
//   node --import ./tests/preload.js tests/api.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import './support/require-isolation.js'; // throws before the app loads if the preload did not run
import { testDbPath, testGrant, cleanupTestDatabase } from './support/isolation.js';
import app from '../server/index.js';
import { dbPath } from '../server/db.js';
import { runSeed } from '../server/seed.js';

describe('Alumni Connect Platform API', () => {
  let server;
  let baseUrl;
  const tokens = {};

  const call = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  const login = async (email, password, portal) => call('POST', '/api/auth/login', { body: { email, password, portal } });

  before(async () => {
    // Fail closed: never seed unless the app is bound to the temporary database.
    assert.equal(path.resolve(dbPath), path.resolve(testDbPath), 'tests must run on the temporary database');
    runSeed({ mode: 'full', authorization: testGrant });
    server = app.listen(0);
    baseUrl = `http://localhost:${server.address().port}`;
  });

  after(() => {
    server?.close();
    cleanupTestDatabase(); // closes the database handle first, then removes the temporary directory
  });

  test('health check', async () => {
    const { status, data } = await call('GET', '/api/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
  });

  test('each portal logs in its own role', async () => {
    const cases = [
      ['admin@westbridge.example', 'Sandbox@2026', 'admin', 'ADMIN', 'admin'],
      ['rohan@example.com', 'Sandbox@2026', 'alumni', 'ALUMNI', 'alumni'],
      ['ishita@example.com', 'Sandbox@2026', 'student', 'STUDENT', 'student'],
      ['aarav.school@example.com', 'Sandbox@2026', 'external', 'EXTERNAL', 'external'],
      ['meera.premium@example.com', 'Sandbox@2026', 'external', 'EXTERNAL', 'premium'],
      ['superadmin@alumniplatform.com', 'superadmin123', 'platform', 'SUPERADMIN', 'superadmin'],
      ['admin@lakeview.example', 'Sandbox@2026', 'admin', 'ADMIN', 'bitsAdmin'],
      ['principal@greenfield.example', 'Sandbox@2026', 'admin', 'ADMIN', 'schoolAdmin']
    ];
    for (const [email, pw, portal, role, key] of cases) {
      const { status, data } = await login(email, pw, portal);
      assert.equal(status, 200, `${email} should log in`);
      assert.equal(data.user.role, role);
      tokens[key] = data.token;
    }
  });

  test('Phase 2 test data: realistic creation dates and every "weeks used" case', async () => {
    const expected = { westbridge: 3, lakeview: 3, meridian: 2, greenfield: 0 };
    for (const [id, weeks] of Object.entries(expected)) {
      const { data } = await call('GET', `/api/platform/institutions/${id}/usage`, { token: tokens.superadmin });
      assert.equal(data.weeks_used_of_last_3, weeks, `${id} should show ${weeks} of the last 3 weeks used`);
      assert.ok(new Date(data.institution.account_created.replace(' ', 'T') + 'Z') < new Date(Date.now() - 7 * 86400000), `${id} joined more than a week ago`);
    }
    const { data: empty } = await call('GET', '/api/platform/institutions/northgate/usage', { token: tokens.superadmin });
    assert.equal(empty.totals.verified_students + empty.totals.verified_alumni, 0);
    const northgate = await login('principal@northgate.example', 'Sandbox@2026', 'admin');
    const ov = await call('GET', '/api/admin/overview', { token: northgate.data.token });
    assert.equal(ov.data.subscription.state, 'TRIAL');
    assert.equal(ov.data.checklist.filter(c => c.done).length, 0, 'brand-new institution has an empty checklist');
  });

  test('Phase 2 test data: sandbox feedback log covers every decision and is labelled in exports', async () => {
    const hidden = await call('GET', '/api/platform/feedback', { token: tokens.superadmin });
    assert.equal(hidden.data.feedback.length, 0, 'sandbox feedback is not real evidence and is hidden by default');
    const all = await call('GET', '/api/platform/feedback?include_sandbox=1', { token: tokens.superadmin });
    const decisions = new Set(all.data.feedback.map(f => f.decision));
    for (const d of ['New', 'Shipped', 'In progress', 'Planned', "Won't do"]) assert.ok(decisions.has(d), `has a ${d} entry`);
    for (const p of ['Westbridge Institute of Technology', 'Lakeview College of Engineering', 'Meridian College of Commerce', 'Greenfield Public School, Lucknow']) {
      assert.ok(all.data.by_partner.find(x => x.partner === p).entries >= 2, `${p} has at least two entries`);
    }
    assert.ok(all.data.feedback.filter(f => f.decision === 'Shipped').every(f => f.shipped_on && f.evidence));
    const csv = await (await fetch(`${baseUrl}/api/platform/feedback.csv?include_sandbox=1`, { headers: { Authorization: `Bearer ${tokens.superadmin}` } })).text();
    const rows = csv.split('\n').slice(1);
    assert.ok(rows.every(r => r.includes('[SANDBOX TEST DATA]')), 'every sandbox row is labelled in the CSV');
  });

  test('login through the wrong portal is refused with a pointer to the right one', async () => {
    const { status, data } = await login('rohan@example.com', 'Sandbox@2026', 'student');
    assert.equal(status, 403);
    assert.equal(data.code, 'WRONG_PORTAL');
    assert.equal(data.correct_portal, 'alumni');
  });

  test('admin accounts cannot self-register', async () => {
    const { status } = await call('POST', '/api/auth/register', {
      body: { role: 'ADMIN', institution_id: 'westbridge', email: 'evil@x.com', password: 'password123', full_name: 'Evil' }
    });
    assert.equal(status, 400);
  });

  test('alumni signup: roster match auto-verifies, otherwise pending', async () => {
    const base = { institution_id: 'westbridge', password: 'password123', graduation_year: 2022, degree: 'B.Tech', branch: 'CSE' };
    const matched = await call('POST', '/api/auth/register/alumni', {
      body: { ...base, email: 'new.graduate@alumni.westbridge.example', full_name: 'Siddharth Varma', current_company: 'Microsoft', current_role: 'SDE' }
    });
    assert.equal(matched.status, 201);
    assert.equal(matched.data.user.verification_status, 'VERIFIED');

    const unmatched = await call('POST', '/api/auth/register/alumni', {
      body: { ...base, email: 'unlisted.graduate@gmail.com', full_name: 'Unlisted Grad' }
    });
    assert.equal(unmatched.status, 201);
    assert.equal(unmatched.data.user.verification_status, 'PENDING');
  });

  test('student signup: college email verifies instantly, other email waits and cannot request mentorship', async () => {
    const base = { institution_id: 'westbridge', password: 'password123', graduation_year: 2028, degree: 'B.Tech', branch: 'EE', roll_number: '24B0001' };
    const college = await call('POST', '/api/auth/register/student', { body: { ...base, email: 'kiran@westbridge.example', full_name: 'Kiran Rao' } });
    assert.equal(college.status, 201);
    assert.equal(college.data.user.verification_status, 'VERIFIED');

    const gmail = await call('POST', '/api/auth/register/student', { body: { ...base, email: 'kiran.r@gmail.com', full_name: 'Kiran R' } });
    assert.equal(gmail.data.user.verification_status, 'PENDING');

    const blocked = await call('POST', '/api/student/requests', {
      token: gmail.data.token,
      body: { alumni_id: 'u_alumni_rohan', topic: 'Resume Review', message: 'Could you please review my resume for the internship season this year?' }
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'STUDENT_UNVERIFIED');
  });

  test('visiting student signup needs no verification; sandbox visitors can read college details', async () => {
    const reg = await call('POST', '/api/auth/register/external', {
      body: { email: 'zoya@school.in', password: 'password123', full_name: 'Zoya Ali', education_level: 'SCHOOL', current_institution: 'Sunrise Public School', interested_institution_id: 'lakeview' }
    });
    assert.equal(reg.status, 201);
    assert.equal(reg.data.user.role, 'EXTERNAL');
    assert.equal(reg.data.user.institution_id, null);
    assert.equal(reg.data.user.is_premium, false);
    assert.equal(reg.data.user.is_sandbox, 0);

    // The sandbox reviewer account (Meera) sees the fictional college's courses, placements and outcomes.
    const detail = await call('GET', '/api/institutions/lakeview', { token: tokens.premium });
    assert.equal(detail.status, 200);
    assert.ok(detail.data.courses.length > 0);
    assert.ok(detail.data.placements.length > 0);
    assert.ok(detail.data.network.verified_alumni > 0);
  });

  test('sandbox and real worlds never mix', async () => {
    const zoya = await login('zoya@school.in', 'password123', 'external');
    // A real visitor never sees the fictional sandbox colleges...
    assert.equal((await call('GET', '/api/institutions/lakeview', { token: zoya.data.token })).status, 404);
    const list = await call('GET', '/api/institutions', { token: zoya.data.token });
    assert.ok(list.data.institutions.every(i => !i.is_sandbox));
    const guestList = await call('GET', '/api/institutions');
    assert.ok(guestList.data.institutions.every(i => !i.is_sandbox));
    const dir = await call('GET', '/api/discovery/alumni', { token: zoya.data.token });
    assert.equal(dir.data.results.length, 0);
    // ...while the sandbox reviewer account sees only sandbox colleges.
    const sandboxList = await call('GET', '/api/institutions', { token: tokens.premium });
    assert.ok(sandboxList.data.institutions.length >= 3);
    assert.ok(sandboxList.data.institutions.every(i => i.is_sandbox));
  });

  test('guests cannot browse the alumni network or college details', async () => {
    assert.equal((await call('GET', '/api/discovery/alumni')).status, 401);
    assert.equal((await call('GET', '/api/institutions/westbridge')).status, 401);
    assert.equal((await call('GET', '/api/institutions')).status, 200);
  });

  test('admin metrics include students and external engagement', async () => {
    const { status, data } = await call('GET', '/api/admin/metrics', { token: tokens.admin });
    assert.equal(status, 200);
    assert.ok(data.total_alumni > 50);
    assert.ok(data.verified_alumni > 40);
    assert.ok(data.pending_review >= 5);
    assert.ok(data.pending_students >= 2);
    assert.ok(data.external_requests >= 2);
    assert.ok(data.requests.total >= 3);
  });

  test('CSV roster import', async () => {
    const csv = 'name,email,batch,degree,branch\nAayush Verma,aayush.v@westbridge.example,2023,B.Tech,Mechanical\nKritika Sengupta,kritika.s@westbridge.example,2022,M.Tech,CSE';
    const { status, data } = await call('POST', '/api/admin/roster/upload', { token: tokens.admin, body: { csv_text: csv } });
    assert.equal(status, 200);
    assert.equal(data.imported_count, 2);
  });

  test('verification queue covers students and alumni, and approval works', async () => {
    const { data: queue } = await call('GET', '/api/admin/verification-queue', { token: tokens.admin });
    const student = queue.pending.find(p => p.role === 'STUDENT');
    const alum = queue.pending.find(p => p.role === 'ALUMNI');
    assert.ok(student && alum);

    for (const target of [student, alum]) {
      const res = await call('POST', `/api/admin/verification/${target.id}/decide`, { token: tokens.admin, body: { decision: 'VERIFIED' } });
      assert.equal(res.status, 200);
      assert.equal(res.data.verification_status, 'VERIFIED');
    }
  });

  test('directory filters and keyword search', async () => {
    const { data } = await call('GET', '/api/discovery/alumni?inst=westbridge&mentor_only=1', { token: tokens.student });
    assert.ok(data.results.length > 0);
    for (const a of data.results) {
      assert.equal(a.institution_id, 'westbridge');
      assert.equal(a.is_open_to_mentoring, 1);
      assert.equal(a.verification_status, 'VERIFIED');
      assert.equal(a.can_request, true);
    }

    const combined = await call('GET', '/api/discovery/alumni?q=Harish&company=Google&mentor_only=1', { token: tokens.student });
    assert.equal(combined.data.results[0].full_name, 'Harish Test Alum');

    const all = await call('GET', '/api/discovery/alumni', { token: tokens.student });
    const emptyQ = await call('GET', '/api/discovery/alumni?q=', { token: tokens.student });
    assert.equal(emptyQ.data.results.length, all.data.results.length);
  });

  test('current student: free mentorship from own college, closed loop to contact reveal', async () => {
    const sent = await call('POST', '/api/student/requests', {
      token: tokens.student,
      body: { alumni_id: 'u_alumni_rohan', topic: 'Resume Review', message: 'Hello Rohan, could you please review my backend engineering resume for upcoming tech roles?' }
    });
    assert.equal(sent.status, 201);

    const inbox = await call('GET', '/api/alumni/requests', { token: tokens.alumni });
    assert.ok(inbox.data.requests.find(r => r.id === sent.data.request_id));

    const meeting = 'Google Meet: https://meet.google.com/test-e2e-slot | Friday 5:00 PM IST';
    const accepted = await call('POST', `/api/alumni/requests/${sent.data.request_id}/respond`, {
      token: tokens.alumni, body: { status: 'ACCEPTED', meeting_info: meeting }
    });
    assert.equal(accepted.status, 200);

    const mine = await call('GET', '/api/student/requests', { token: tokens.student });
    const resolved = mine.data.requests.find(r => r.id === sent.data.request_id);
    assert.equal(resolved.status, 'ACCEPTED');
    assert.equal(resolved.meeting_info, meeting);
  });

  test('current student cannot request alumni of another college', async () => {
    const { data } = await call('GET', '/api/discovery/alumni?inst=lakeview&mentor_only=1', { token: tokens.student });
    const target = data.results[0];
    assert.ok(target);
    assert.equal(target.can_request, false);
    const res = await call('POST', '/api/student/requests', {
      token: tokens.student,
      body: { alumni_id: target.user_id, topic: target.mentorship_topics[0], message: 'I would love to hear about your journey after graduating from Lakeview Engineering.' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'OTHER_COLLEGE');
  });

  test('visiting student: Premium unlocks mentorship and internships', async () => {
    const msg = { alumni_id: 'u_alumni_rohan', topic: 'Career Guidance', message: 'Hi Rohan, I am in Class 12 and deciding between CS programmes. What should I consider?' };

    const freeReq = await call('POST', '/api/student/requests', { token: tokens.external, body: msg });
    assert.equal(freeReq.status, 402);
    assert.equal(freeReq.data.code, 'PREMIUM_REQUIRED');

    const freeIntern = await call('GET', '/api/internships', { token: tokens.external });
    assert.equal(freeIntern.status, 402);

    const profile = await call('GET', '/api/discovery/alumni/u_alumni_rohan', { token: tokens.external });
    assert.equal(profile.data.linkedin_url, null);
    assert.equal(profile.data.access.code, 'PREMIUM_REQUIRED');

    const checkout = await call('POST', '/api/subscriptions/checkout', { token: tokens.external, body: { plan_id: 'premium_monthly' } });
    assert.equal(checkout.status, 201);
    assert.ok(checkout.data.subscription.payment_ref.startsWith('DEMO-'));

    const again = await call('POST', '/api/subscriptions/checkout', { token: tokens.external, body: { plan_id: 'premium_monthly' } });
    assert.equal(again.status, 409);

    const me = await call('GET', '/api/auth/me', { token: tokens.external });
    assert.equal(me.data.user.is_premium, true);

    const paidReq = await call('POST', '/api/student/requests', { token: tokens.external, body: msg });
    assert.equal(paidReq.status, 201);

    const list = await call('GET', '/api/internships', { token: tokens.external });
    assert.equal(list.status, 200);
    assert.ok(list.data.internships.length > 0);
    assert.ok(list.data.internships.every(i => i.audience === 'ALL'));
  });

  test('Premium students can only request alumni who opted in to mentor other colleges', async () => {
    const { data } = await call('GET', '/api/discovery/alumni?mentor_only=1', { token: tokens.premium });
    const closed = data.results.find(a => !a.open_to_external);
    assert.ok(closed);
    const res = await call('POST', '/api/student/requests', {
      token: tokens.premium,
      body: { alumni_id: closed.user_id, topic: closed.mentorship_topics[0], message: 'Hello, I would really value your perspective on choosing a specialisation.' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'NOT_OPEN_TO_EXTERNAL');
  });

  test('internships: alumni post, audience rules apply, students apply, poster sees applicants', async () => {
    const post = await call('POST', '/api/internships', {
      token: tokens.alumni,
      body: { title: 'Data Intern', company: 'Stripe', location: 'Bengaluru', mode: 'REMOTE', description: 'Help build risk dashboards and analyse payment flows with the data team.', audience: 'OWN_COLLEGE', skills: ['SQL'] }
    });
    assert.equal(post.status, 201);

    const studentList = await call('GET', '/api/internships', { token: tokens.student });
    assert.ok(studentList.data.internships.find(i => i.id === post.data.id));

    const premiumList = await call('GET', '/api/internships', { token: tokens.premium });
    assert.ok(!premiumList.data.internships.find(i => i.id === post.data.id));
    const premiumApply = await call('POST', `/api/internships/${post.data.id}/apply`, { token: tokens.premium, body: { note: 'I would love to work on risk dashboards.' } });
    assert.equal(premiumApply.status, 404);

    const apply = await call('POST', `/api/internships/${post.data.id}/apply`, { token: tokens.student, body: { note: 'I have built SQL dashboards for my college fest finances.' } });
    assert.equal(apply.status, 201);

    const posted = await call('GET', '/api/internships/posted', { token: tokens.alumni });
    const mine = posted.data.internships.find(i => i.id === post.data.id);
    assert.equal(mine.applications.length, 1);
    assert.equal(mine.applications[0].applicant_name, 'Ishita Rao');
  });

  test('hidden profiles are not visible to other users', async () => {
    const { data: harish } = await login('harish.test.alum@example.com', 'Sandbox@2026', 'alumni');
    await call('PUT', '/api/alumni/profile', { token: harish.token, body: { visibility: 'HIDDEN' } });
    assert.equal((await call('GET', '/api/discovery/alumni/u_alumni_harish', { token: tokens.student })).status, 404);
    assert.equal((await call('GET', '/api/discovery/alumni/u_alumni_harish', { token: harish.token })).status, 200);
    await call('PUT', '/api/alumni/profile', { token: harish.token, body: { visibility: 'PUBLIC' } });
    assert.equal((await call('GET', '/api/discovery/alumni/u_alumni_harish', { token: tokens.student })).status, 200);
  });

  test('revenue is visible to the platform team only', async () => {
    assert.equal((await call('GET', '/api/platform/revenue', { token: tokens.admin })).status, 403);
    const { status, data } = await call('GET', '/api/platform/revenue', { token: tokens.superadmin });
    assert.equal(status, 200);
    // Sandbox institutions and sandbox visiting students are excluded from revenue.
    assert.equal(data.b2c.gross_inr, 0);
    assert.equal(data.b2b.mrr_inr, 0);
    assert.ok(data.institutions.sandbox >= 4);
  });

  // ---------------- Institution SaaS: registration, billing, isolation, privacy ----------------

  const newInst = {};

  test('a college can self-register, starts a private 30-day trial, and is not listed until verified', async () => {
    const base = {
      name: 'Riverside Institute of Technology', short_name: 'RIT', kind: 'COLLEGE', type: 'Autonomous College',
      city: 'Nagpur', state: 'Maharashtra', founded: 2001, email_domain: 'rit.edu.in',
      admin_name: 'Meena Rao', password: 'password123', plan_id: 'growth', accept_terms: true
    };
    const wrongDomain = await call('POST', '/api/auth/register/institution', { body: { ...base, admin_email: 'meena@gmail.com' } });
    assert.equal(wrongDomain.status, 400);
    const noTerms = await call('POST', '/api/auth/register/institution', { body: { ...base, admin_email: 'meena@rit.edu.in', accept_terms: false } });
    assert.equal(noTerms.status, 400);

    const ok = await call('POST', '/api/auth/register/institution', { body: { ...base, admin_email: 'meena@rit.edu.in' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.user.role, 'ADMIN');
    assert.equal(ok.data.user.admin_level, 'OWNER');
    assert.equal(ok.data.institution.data_sharing, 'PRIVATE');
    assert.equal(ok.data.institution.subscription.state, 'TRIAL');
    assert.equal(ok.data.institution.subscription.days_left, 30);
    newInst.id = ok.data.user.institution_id;
    newInst.owner = ok.data.token;

    const dup = await call('POST', '/api/auth/register/institution', { body: { ...base, admin_email: 'other@rit.edu.in' } });
    assert.equal(dup.status, 409);

    const list = await call('GET', '/api/institutions');
    assert.ok(!list.data.institutions.find(i => i.id === newInst.id));
    const joinable = await call('GET', '/api/institutions/joinable');
    assert.ok(joinable.data.institutions.find(i => i.id === newInst.id));
  });

  test('a private institution’s community is invisible to other institutions and visiting students', async () => {
    const alum = await call('POST', '/api/auth/register/alumni', {
      body: { institution_id: newInst.id, email: 'grad@rit-alumni.com', password: 'password123', full_name: 'Rit Grad', graduation_year: 2020, degree: 'B.E.', branch: 'IT' }
    });
    assert.equal(alum.data.user.verification_status, 'PENDING');
    const { data: q } = await call('GET', '/api/admin/verification-queue', { token: newInst.owner });
    const target = q.pending.find(p => p.email === 'grad@rit-alumni.com');
    assert.equal((await call('POST', `/api/admin/verification/${target.id}/decide`, { token: newInst.owner, body: { decision: 'VERIFIED' } })).status, 200);

    const student = await call('POST', '/api/auth/register/student', {
      body: { institution_id: newInst.id, email: 'kid@rit.edu.in', password: 'password123', full_name: 'Rit Student', graduation_year: 2028, degree: 'B.E.', branch: 'IT', roll_number: 'R1' }
    });
    assert.equal(student.data.user.verification_status, 'VERIFIED');

    const own = await call('GET', `/api/discovery/alumni?inst=${newInst.id}`, { token: student.data.token });
    assert.equal(own.data.results.length, 1);
    const fromIitb = await call('GET', `/api/discovery/alumni?inst=${newInst.id}`, { token: tokens.student });
    assert.equal(fromIitb.data.results.length, 0);
    const fromPremium = await call('GET', `/api/discovery/alumni?inst=${newInst.id}`, { token: tokens.premium });
    assert.equal(fromPremium.data.results.length, 0);
    assert.equal((await call('GET', `/api/discovery/alumni/${target.id}`, { token: tokens.student })).status, 404);
  });

  test('admins are strictly scoped to their own institution', async () => {
    const { data } = await call('GET', '/api/admin/members?type=STUDENT', { token: tokens.bitsAdmin });
    assert.ok(data.rows.length > 0);
    const bitsStudent = data.rows[0];
    // Westbridge Tech admin cannot touch a Lakeview member
    assert.equal((await call('POST', `/api/admin/members/${bitsStudent.id}/deactivate`, { token: tokens.admin })).status, 404);
    assert.equal((await call('PATCH', `/api/admin/members/${bitsStudent.id}`, { token: tokens.admin, body: { degree: 'X' } })).status, 404);
    assert.equal((await call('POST', `/api/admin/verification/${bitsStudent.id}/decide`, { token: tokens.admin, body: { decision: 'VERIFIED' } })).status, 404);
    // An admin browsing the network sees only their own institution
    const dir = await call('GET', '/api/discovery/alumni', { token: tokens.admin });
    assert.ok(dir.data.results.every(r => r.institution_id === 'westbridge'));
    // Admin portal can no longer pick another institution via a query parameter
    const m = await call('GET', '/api/admin/metrics?inst=lakeview', { token: tokens.admin });
    assert.equal(m.data.institution_id, 'westbridge');
  });

  test('platform staff see billing and counts only, never member data', async () => {
    for (const path of ['/api/admin/metrics', '/api/admin/members', '/api/discovery/alumni', '/api/internships', '/api/admin/institution/export']) {
      const r = await call('GET', path, { token: tokens.superadmin });
      assert.ok([401, 403].includes(r.status), `${path} should be blocked for platform staff (got ${r.status})`);
    }
    const { status, data } = await call('GET', '/api/platform/institutions', { token: tokens.superadmin });
    assert.equal(status, 200);
    const westbridge = data.institutions.find(i => i.id === 'westbridge');
    assert.equal(typeof westbridge.members, 'number');
    assert.ok(!('users' in westbridge) && !('students' in westbridge));
  });

  test('platform verification makes a new institution publicly listed', async () => {
    assert.equal((await call('POST', `/api/platform/institutions/${newInst.id}/verify`, { token: tokens.superadmin, body: {} })).status, 200);
    const list = await call('GET', '/api/institutions');
    assert.ok(list.data.institutions.find(i => i.id === newInst.id));
  });

  test('revenue counts real institutions only', async () => {
    const pay = await call('POST', '/api/billing/checkout', { token: newInst.owner, body: { plan_id: 'growth', billing_cycle: 'MONTHLY' } });
    assert.equal(pay.status, 201);
    const { data } = await call('GET', '/api/platform/revenue', { token: tokens.superadmin });
    assert.equal(data.b2b.mrr_inr, 12999);
  });

  test('usage evidence: weekly activity, counts only, for platform and for the institution itself', async () => {
    await call('GET', '/api/auth/me', { token: tokens.student }); // records today's activity
    const { status, data } = await call('GET', '/api/platform/institutions/westbridge/usage', { token: tokens.superadmin });
    assert.equal(status, 200);
    assert.equal(data.weeks.length, 4);
    assert.ok(data.weeks[3].active_users >= 1);
    assert.ok(data.institution.account_created);
    assert.ok(data.totals.mentorship_requests > 0);

    const csvRes = await fetch(`${baseUrl}/api/platform/institutions/westbridge/usage.csv`, { headers: { Authorization: `Bearer ${tokens.superadmin}` } });
    const csv = await csvRes.text();
    assert.ok(csv.includes('Activity by week (last 4 weeks)'));
    assert.ok(!/@/.test(csv), 'usage CSV must not contain email addresses');

    const own = await fetch(`${baseUrl}/api/admin/usage.csv`, { headers: { Authorization: `Bearer ${tokens.admin}` } });
    assert.equal(own.status, 200);
    // Another institution's usage is not available to an admin.
    assert.equal((await call('GET', '/api/platform/institutions/westbridge/usage', { token: tokens.admin })).status, 403);
  });

  test('feedback log: in-app and team-logged entries, decision rules, Phase 2 CSV columns', async () => {
    const fromPartner = await call('POST', '/api/feedback', { token: newInst.owner, body: { type: 'Feature', message: 'Can we bulk-approve students from a roster?' } });
    assert.equal(fromPartner.status, 201);
    const fromSandbox = await call('POST', '/api/feedback', { token: tokens.student, body: { type: 'Bug', message: 'Reviewer testing the feedback form' } });
    assert.equal(fromSandbox.status, 201);
    assert.equal((await call('POST', '/api/feedback', { token: tokens.student, body: { type: 'Nope', message: 'x' } })).status, 400);

    const logged = await call('POST', '/api/platform/feedback', {
      token: tokens.superadmin,
      body: { institution_id: newInst.id, person: 'Meena Rao', person_role: 'Principal', channel: 'Phone call', type: 'Pricing or business', what_they_said: 'We budget per academic year, not per month.', received_on: '2026-11-02' }
    });
    assert.equal(logged.status, 201);

    const list = await call('GET', '/api/platform/feedback', { token: tokens.superadmin });
    assert.ok(list.data.feedback.find(f => f.id === fromPartner.data.id));
    assert.ok(!list.data.feedback.find(f => f.id === fromSandbox.data.id), 'sandbox feedback is hidden by default');

    const noEvidence = await call('PATCH', `/api/platform/feedback/${fromPartner.data.id}`, { token: tokens.superadmin, body: { decision: 'Shipped', shipped_on: '2026-11-05' } });
    assert.equal(noEvidence.status, 400);
    const shipped = await call('PATCH', `/api/platform/feedback/${fromPartner.data.id}`, {
      token: tokens.superadmin, body: { decision: 'Shipped', shipped_on: '2026-11-05', evidence: 'https://github.com/example/commit/abc123', partner_reaction: 'Used it the same day' }
    });
    assert.equal(shipped.status, 200);
    assert.equal((await call('PATCH', `/api/platform/feedback/${logged.data.id}`, { token: tokens.superadmin, body: { decision: "Won't do" } })).status, 400);

    const mine = await call('GET', '/api/feedback/mine', { token: newInst.owner });
    assert.equal(mine.data.feedback[0].decision, 'Shipped');

    const csv = await (await fetch(`${baseUrl}/api/platform/feedback.csv`, { headers: { Authorization: `Bearer ${tokens.superadmin}` } })).text();
    const [header, first] = csv.split('\n');
    assert.equal(header, "Date,Partner and person,What they said (their words),Type,Decision,Shipped on,Evidence,Partner's reaction");
    assert.ok(first.includes('Riverside Institute of Technology'), 'newest entry first');
    assert.equal((await call('GET', '/api/platform/feedback', { token: tokens.admin })).status, 403);
  });

  test('lapsed subscription: community tools pause, export still works, paying restores access', async () => {
    const ov = await call('GET', '/api/admin/overview', { token: tokens.schoolAdmin });
    assert.equal(ov.data.subscription.state, 'EXPIRED');
    const blocked = await call('POST', '/api/admin/community/announcements', { token: tokens.schoolAdmin, body: { title: 'Hi', body: 'Hello all' } });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.data.code, 'INSTITUTION_INACTIVE');

    const exp = await call('GET', '/api/admin/institution/export', { token: tokens.schoolAdmin });
    assert.equal(exp.status, 200);
    assert.ok(exp.data.users.length > 0);
    assert.ok(exp.data.users.every(u => !('password_hash' in u)));

    // Its students can no longer sign up while lapsed
    const signup = await call('POST', '/api/auth/register/student', {
      body: { institution_id: 'greenfield', email: 'new@greenfield.example', password: 'password123', full_name: 'New Kid', graduation_year: 2028, degree: 'Class 11', branch: 'Science', roll_number: 'G1' }
    });
    assert.equal(signup.status, 403);

    const pay = await call('POST', '/api/billing/checkout', { token: tokens.schoolAdmin, body: { plan_id: 'starter', billing_cycle: 'MONTHLY' } });
    assert.equal(pay.status, 201);
    assert.equal(pay.data.amount_inr, Math.round(4999 * 0.6)); // school pricing
    assert.equal((await call('POST', '/api/admin/community/announcements', { token: tokens.schoolAdmin, body: { title: 'Hi', body: 'Hello all' } })).status, 201);

    const bill = await call('GET', '/api/billing', { token: tokens.schoolAdmin });
    assert.equal(bill.data.state, 'ACTIVE');
    assert.equal(bill.data.invoices.length, 1);
  });

  test('only the owner can manage billing and the admin team; seats are limited by plan', async () => {
    const { data: second } = await login('alumni.office@westbridge.example', 'Sandbox@2026', 'admin');
    assert.equal((await call('POST', '/api/billing/checkout', { token: second.token, body: { plan_id: 'starter' } })).status, 403);
    assert.equal((await call('POST', '/api/admin/institution/team', { token: second.token, body: {} })).status, 403);

    const wrongDomain = await call('POST', '/api/admin/institution/team', { token: tokens.admin, body: { full_name: 'X', email: 'x@gmail.com', password: 'password1234' } });
    assert.equal(wrongDomain.status, 400);
    const added = await call('POST', '/api/admin/institution/team', { token: tokens.admin, body: { full_name: 'New Admin', email: 'new.admin@westbridge.example', password: 'password1234' } });
    assert.equal(added.status, 201);

    const downgrade = await call('POST', '/api/billing/checkout', { token: tokens.bitsAdmin, body: { plan_id: 'starter' } });
    assert.equal(downgrade.status, 201);
  });

  test('plan features: Starter cannot create events or see the value report; Growth can', async () => {
    const ev = await call('POST', '/api/admin/community/events', { token: tokens.bitsAdmin, body: { title: 'Meetup', description: 'Alumni meetup', starts_at: '2026-12-01T18:00' } });
    assert.equal(ev.status, 402);
    assert.equal(ev.data.code, 'PLAN_UPGRADE_REQUIRED');
    assert.equal((await call('GET', '/api/admin/value-report', { token: tokens.bitsAdmin })).status, 402);

    const vr = await call('GET', '/api/admin/value-report', { token: tokens.admin });
    assert.equal(vr.status, 200);
    assert.equal(vr.data.months.length, 6);
    assert.ok(vr.data.series.mentorship_requests.reduce((a, b) => a + b, 0) > 0);
    assert.ok(vr.data.health.score >= 0 && vr.data.health.score <= 100);
  });

  test('mentorship program: members join, admin matches, matched pair can message privately', async () => {
    const st = await call('POST', '/api/auth/register/student', {
      body: { institution_id: 'westbridge', email: 'prog.kid@westbridge.example', password: 'password123', full_name: 'Program Kid', graduation_year: 2027, degree: 'B.Tech', branch: 'CSE', roll_number: 'P1' }
    });
    const join = await call('POST', '/api/community/programs/mp_1/join', { token: st.data.token });
    assert.equal(join.status, 201);
    assert.equal(join.data.role, 'MENTEE');

    const match = await call('POST', '/api/admin/community/programs/mp_1/match', { token: tokens.admin });
    assert.equal(match.status, 200);
    assert.ok(match.data.matched >= 1);

    const mine = await call('GET', '/api/student/requests', { token: st.data.token });
    const conv = mine.data.requests.find(r => r.program_id === 'mp_1');
    assert.ok(conv && conv.status === 'ACCEPTED');

    const send = await call('POST', `/api/community/conversations/${conv.id}/messages`, { token: st.data.token, body: { body: 'Hello mentor!' } });
    assert.equal(send.status, 201);
    const read = await call('GET', `/api/community/conversations/${conv.id}/messages`, { token: st.data.token });
    assert.equal(read.data.messages.at(-1).body, 'Hello mentor!');
    // A different student cannot read it
    assert.equal((await call('GET', `/api/community/conversations/${conv.id}/messages`, { token: tokens.student })).status, 404);
  });

  test('events: members RSVP from their feed', async () => {
    const feed = await call('GET', '/api/community/feed', { token: tokens.student });
    assert.equal(feed.status, 200);
    assert.ok(feed.data.announcements.length > 0);
    const ev = feed.data.events[0];
    const r1 = await call('POST', `/api/community/events/${ev.id}/rsvp`, { token: tokens.student });
    assert.equal(typeof r1.data.going, 'boolean');
  });

  test('deactivated members lose access immediately', async () => {
    const st = await call('POST', '/api/auth/register/student', {
      body: { institution_id: 'westbridge', email: 'temp.kid@westbridge.example', password: 'password123', full_name: 'Temp Kid', graduation_year: 2027, degree: 'B.Tech', branch: 'CSE', roll_number: 'T1' }
    });
    assert.equal((await call('POST', `/api/admin/members/${st.data.user.id}/deactivate`, { token: tokens.admin })).status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: st.data.token })).status, 401);
    const relog = await login('temp.kid@westbridge.example', 'password123', 'student');
    assert.equal(relog.status, 403);
    assert.equal(relog.data.code, 'DEACTIVATED');
    assert.equal((await call('POST', `/api/admin/members/${st.data.user.id}/reactivate`, { token: tokens.admin })).status, 200);
    assert.equal((await login('temp.kid@westbridge.example', 'password123', 'student')).status, 200);
  });

  test('student roster import auto-verifies non-domain emails; CSV handles quoted fields', async () => {
    const csv = 'name,email,batch,degree,branch\n"Rao, Anil",anil.rao.x@gmail.com,2028,B.Tech,"Engineering Physics"';
    const up = await call('POST', '/api/admin/roster/upload', { token: tokens.admin, body: { csv_text: csv, record_type: 'STUDENT' } });
    assert.equal(up.data.imported_count, 1);
    const reg = await call('POST', '/api/auth/register/student', {
      body: { institution_id: 'westbridge', email: 'anil.rao.x@gmail.com', password: 'password123', full_name: 'Anil Rao', graduation_year: 2028, degree: 'B.Tech', branch: 'EP', roll_number: 'A1' }
    });
    assert.equal(reg.data.user.verification_status, 'VERIFIED');
  });

  test('institution sharing setting controls what visiting students see', async () => {
    assert.equal((await call('PUT', '/api/admin/institution/settings', { token: tokens.admin, body: { data_sharing: 'PRIVATE' } })).status, 200);
    const hidden = await call('GET', '/api/discovery/alumni?inst=westbridge', { token: tokens.premium });
    assert.equal(hidden.data.results.length, 0);
    const req = await call('POST', '/api/student/requests', {
      token: tokens.premium, body: { alumni_id: 'u_alumni_rohan', topic: 'Resume Review', message: 'Could you review my resume for data science internships please?' }
    });
    assert.ok([403, 404].includes(req.status));
    await call('PUT', '/api/admin/institution/settings', { token: tokens.admin, body: { data_sharing: 'PLATFORM' } });
    const back = await call('GET', '/api/discovery/alumni?inst=westbridge', { token: tokens.premium });
    assert.ok(back.data.results.length > 0);
  });

  test('audit log records admin actions', async () => {
    const { data } = await call('GET', '/api/admin/institution/audit', { token: tokens.admin });
    const actions = data.entries.map(e => e.action);
    for (const a of ['SETTINGS_UPDATED', 'ROSTER_IMPORTED', 'MEMBER_DEACTIVATED', 'PROGRAM_MATCHED', 'ADMIN_ADDED']) {
      assert.ok(actions.includes(a), `audit log should contain ${a}`);
    }
  });

  test('members can export and delete their own data', async () => {
    const st = await call('POST', '/api/auth/register/student', {
      body: { institution_id: 'westbridge', email: 'leaving@westbridge.example', password: 'password123', full_name: 'Leaving Kid', graduation_year: 2027, degree: 'B.Tech', branch: 'CSE', roll_number: 'L1' }
    });
    const exp = await call('GET', '/api/me/export', { token: st.data.token });
    assert.equal(exp.data.account.email, 'leaving@westbridge.example');
    assert.equal((await call('POST', '/api/me/delete', { token: st.data.token, body: { password: 'wrong' } })).status, 403);
    assert.equal((await call('POST', '/api/me/delete', { token: st.data.token, body: { password: 'password123' } })).status, 200);
    assert.equal((await login('leaving@westbridge.example', 'password123', 'student')).status, 401);
  });

  test('an owner can permanently delete their institution and all of its data', async () => {
    const bad = await call('POST', '/api/admin/institution/delete', { token: newInst.owner, body: { confirm_name: 'RIT', password: 'password123' } });
    assert.equal(bad.status, 400);
    const ok = await call('POST', '/api/admin/institution/delete', { token: newInst.owner, body: { confirm_name: 'Riverside Institute of Technology', password: 'password123' } });
    assert.equal(ok.status, 200);
    assert.equal((await login('meena@rit.edu.in', 'password123', 'admin')).status, 401);
    assert.equal((await login('kid@rit.edu.in', 'password123', 'student')).status, 401);
    const list = await call('GET', '/api/institutions/joinable');
    assert.ok(!list.data.institutions.find(i => i.id === newInst.id));
  });

  test('sandbox reset rebuilds only the fictional institutions and keeps real accounts and feedback', async () => {
    const before = await call('GET', '/api/platform/feedback', { token: tokens.superadmin });
    const reset = await call('POST', '/api/platform/sandbox/reset', { token: tokens.superadmin });
    assert.equal(reset.status, 200);
    assert.equal((await login('zoya@school.in', 'password123', 'external')).status, 200, 'real visiting student survives');
    const after = await call('GET', '/api/platform/feedback', { token: tokens.superadmin });
    assert.equal(after.data.feedback.length, before.data.feedback.length, 'real feedback survives');
    const admin = await login('admin@westbridge.example', 'Sandbox@2026', 'admin');
    assert.equal(admin.status, 200);
    tokens.admin = admin.data.token;
    for (const [email, portal, key] of [['ishita@example.com', 'student', 'student'], ['rohan@example.com', 'alumni', 'alumni'], ['meera.premium@example.com', 'external', 'premium']]) {
      tokens[key] = (await login(email, 'Sandbox@2026', portal)).data.token;
    }
  });

  // The three tasks in the reviewer "Try this" script (docs: 02_MVP_Access).
  test('Try this #1: admin approves a pending student', async () => {
    const { data: q } = await call('GET', '/api/admin/verification-queue', { token: tokens.admin });
    const riya = q.pending.find(p => p.full_name === 'Riya Kulkarni');
    assert.ok(riya);
    assert.equal((await call('POST', `/api/admin/verification/${riya.id}/decide`, { token: tokens.admin, body: { decision: 'VERIFIED' } })).status, 200);
    const { data: members } = await call('GET', '/api/admin/members?type=STUDENT&q=Riya', { token: tokens.admin });
    assert.equal(members.rows[0].verification_status, 'VERIFIED');
    const { data: auditLog } = await call('GET', '/api/admin/institution/audit', { token: tokens.admin });
    assert.equal(auditLog.entries[0].action, 'MEMBER_VERIFIED');
  });

  test('Try this #2: student requests mentorship from an alumnus of their college', async () => {
    const sent = await call('POST', '/api/student/requests', {
      token: tokens.student,
      body: { alumni_id: 'u_alumni_harish', topic: 'Mock Interview', message: 'Could you run a 30-minute system design mock interview with me before placements?' }
    });
    assert.equal(sent.status, 201);
    const mine = await call('GET', '/api/student/requests', { token: tokens.student });
    assert.equal(mine.data.requests.find(r => r.id === sent.data.request_id).status, 'PENDING');
    const harish = await login('harish.test.alum@example.com', 'Sandbox@2026', 'alumni');
    const inbox = await call('GET', '/api/alumni/requests', { token: harish.data.token });
    assert.ok(inbox.data.requests.find(r => r.id === sent.data.request_id));
  });

  test('Try this #3: alumnus accepts a request and the student sees the meeting details', async () => {
    const inbox = await call('GET', '/api/alumni/requests', { token: tokens.alumni });
    const fromMeera = inbox.data.requests.find(r => r.student_name === 'Meera Joshi' && r.status === 'PENDING');
    assert.ok(fromMeera);
    const link = 'Google Meet: https://meet.google.com/abc-defg-hij · Saturday 11:00 AM';
    assert.equal((await call('POST', `/api/alumni/requests/${fromMeera.id}/respond`, { token: tokens.alumni, body: { status: 'ACCEPTED', meeting_info: link } })).status, 200);
    const mine = await call('GET', '/api/student/requests', { token: tokens.premium });
    const r = mine.data.requests.find(x => x.id === fromMeera.id);
    assert.equal(r.status, 'ACCEPTED');
    assert.equal(r.meeting_info, link);
  });

  test('sample-data CSV files import with the documented results', async () => {
    const fs = await import('node:fs');
    const importFile = async (file, type) => (await call('POST', '/api/admin/roster/upload', {
      token: tokens.admin, body: { csv_text: fs.readFileSync(`sample-data/${file}`, 'utf8'), record_type: type }
    })).data;

    const students = await importFile('students_roster.csv', 'STUDENT');
    assert.equal(students.imported_count, 20);
    const alumni = await importFile('alumni_roster.csv', 'ALUMNI');
    assert.equal(alumni.imported_count, 20);
    const again = await importFile('alumni_roster.csv', 'ALUMNI');
    assert.equal(again.imported_count, 0);
    assert.equal(again.skipped_duplicates, 20);

    const errs = await importFile('roster_with_errors.csv', 'ALUMNI');
    assert.equal(errs.imported_count, 4);
    assert.equal(errs.skipped_duplicates, 1);
    assert.deepEqual(errs.errors.map(e => e.split(':')[0]), ['Row 4', 'Row 5', 'Row 9']);

    const { data: roster } = await call('GET', '/api/admin/roster', { token: tokens.admin });
    assert.ok(roster.records.find(r => r.full_name === 'Sen, Siddharth'), 'quoted name with a comma stays whole');
  });

  test('full seed refuses to wipe a production database', async () => {
    const { spawnSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alumni-connect-refuse-'));
    try {
      const out = spawnSync(process.execPath, ['server/seed-cli.js'], {
        env: { ...process.env, NODE_ENV: 'production', DATA_DIR: dir, DB_FILE: 'refuse_check.db', NODE_TEST_CONTEXT: '' },
        encoding: 'utf8'
      });
      assert.equal(out.status, 1);
      assert.ok(out.stderr.includes('Refusing to wipe'));
      assert.deepEqual(fs.readdirSync(dir), [], 'a refusal must not create any database file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('login is rate limited', async () => {
    let last;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(baseUrl + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-rate-limit': '1' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'x' })
      });
      last = res.status;
    }
    assert.equal(last, 429);
  });

  test('unknown API routes return JSON 404', async () => {
    const { status, data } = await call('GET', '/api/does-not-exist');
    assert.equal(status, 404);
    assert.equal(data.error, 'Not found');
  });
});
