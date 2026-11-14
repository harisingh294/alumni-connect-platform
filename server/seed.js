import crypto from 'node:crypto';
import { db, dbPath, initSchema, dropAllTables } from './db.js';
import { assertDestructiveAllowed } from './guard.js';
import { hashPassword } from './auth.js';

// Deterministic Pseudo-Random Number Generator
function createRng(seed = 20260925) {
  let s = seed;
  return function () {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

let R = createRng();
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const pickW = (arr, weights) => {
  let r = R() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
};
const many = (arr, n) => {
  const c = [...arr];
  const out = [];
  for (let i = 0; i < n && c.length; i++) {
    out.push(c.splice(Math.floor(R() * c.length), 1)[0]);
  }
  return out;
};
const int = (min, max) => min + Math.floor(R() * (max - min + 1));

const INSTITUTIONS = [
  // All sandbox institutions are fictional. Their domains use the reserved .example TLD.
  {
    id: 'westbridge',
    name: 'Westbridge Institute of Technology',
    short_name: 'Westbridge Tech',
    abbr: 'WT',
    domain: 'engineering',
    city: 'Pune',
    state: 'Maharashtra',
    type: 'Autonomous Engineering College',
    founded: 1998,
    hue: 214,
    email_domain: 'westbridge.example',
    website: 'https://www.westbridge.example',
    about: 'Fictional sandbox college. A private engineering college whose alumni work in product engineering, fintech and consulting.',
    courses: ['B.Tech Computer Science', 'B.Tech Electrical', 'B.Tech Mechanical', 'M.Tech', 'MBA']
  },
  {
    id: 'lakeview',
    name: 'Lakeview College of Engineering',
    short_name: 'Lakeview Engineering',
    abbr: 'LE',
    domain: 'engineering',
    city: 'Jaipur',
    state: 'Rajasthan',
    type: 'Private Engineering College',
    founded: 2004,
    hue: 262,
    email_domain: 'lakeview.example',
    website: 'https://www.lakeview.example',
    about: 'Fictional sandbox college. Known for a semester-long industry internship and alumni in software and startups.',
    courses: ['B.E. Computer Science', 'B.E. Electronics', 'M.Sc. Economics', 'MBA']
  },
  {
    id: 'meridian',
    name: 'Meridian College of Commerce',
    short_name: 'Meridian Commerce',
    abbr: 'MC',
    domain: 'commerce',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    type: 'Affiliated Commerce College',
    founded: 1985,
    hue: 42,
    email_domain: 'meridian.example',
    website: 'https://www.meridian.example',
    about: 'Fictional sandbox college. A commerce and economics college whose alumni work in banking, consulting and public service.',
    courses: ['B.Com (Hons)', 'B.A. (Hons) Economics', 'M.Com']
  }
];

// Course catalogue for the fictional sandbox colleges.
const COURSE_CATALOGUE = {
  westbridge: [
    ['B.Tech Computer Science and Engineering', 'UG', 4, 120, 185000, 'JEE Main rank / state CET', 'Core CS with electives in AI, systems and theory.'],
    ['B.Tech Electrical Engineering', 'UG', 4, 60, 175000, 'JEE Main rank / state CET', 'Power, communications, VLSI and control systems.'],
    ['B.Tech Mechanical Engineering', 'UG', 4, 60, 175000, 'JEE Main rank / state CET', 'Design, thermal sciences and manufacturing.'],
    ['M.Tech Computer Science', 'PG', 2, 30, 120000, 'GATE score', 'Research-oriented masters with thesis.'],
    ['MBA', 'PG', 2, 60, 350000, 'CAT / MAT score + interview', 'Technology-focused management programme.'],
    ['Ph.D. Engineering', 'DOCTORAL', 5, null, 60000, 'Masters degree + interview', 'Full-time doctoral research across departments.']
  ],
  lakeview: [
    ['B.E. Computer Science', 'UG', 4, 180, 210000, 'JEE Main rank / college entrance test', 'Includes a semester-long industry internship.'],
    ['B.E. Electronics and Communication', 'UG', 4, 120, 200000, 'JEE Main rank / college entrance test', 'Embedded systems, signal processing and VLSI.'],
    ['M.Sc. Economics', 'PG', 2, 40, 90000, 'Graduate with economics or maths', 'Applied economics and data analysis.'],
    ['MBA', 'PG', 2, 60, 300000, 'Entrance test + interview', 'General management with analytics electives.']
  ],
  meridian: [
    ['B.Com (Honours)', 'UG', 3, 620, 30000, 'CUET-UG score', 'Accounting, finance, taxation and business law.'],
    ['B.A. (Honours) Economics', 'UG', 3, 160, 30000, 'CUET-UG score', 'Micro, macro, econometrics and policy.'],
    ['M.Com', 'PG', 2, 60, 25000, 'CUET-PG score', 'Advanced commerce and research methods.'],
    ['Diploma in Global Business Operations', 'DIPLOMA', 1, 40, 90000, 'Graduate in any discipline', 'One-year applied programme.']
  ]
};

// Placement records for the fictional sandbox colleges (sample data).
const PLACEMENTS = {
  westbridge: [
    [2025, 290, 241, 7.2, 8.4, 32.0, ['Infosys', 'Razorpay', 'Atlassian', 'Tata Motors', 'Amazon']],
    [2024, 285, 229, 6.8, 7.9, 28.0, ['Infosys', 'Amazon', 'PhonePe', 'Qualcomm', 'Tata Motors']],
    [2023, 280, 230, 6.5, 7.6, 26.0, ['Infosys', 'Swiggy', 'Zomato', 'Qualcomm', 'Tata Motors']]
  ],
  lakeview: [
    [2025, 300, 236, 6.0, 7.1, 24.0, ['Infosys', 'Razorpay', 'PhonePe', 'Zomato', 'Amazon']],
    [2024, 296, 224, 5.8, 6.7, 21.0, ['Infosys', 'Swiggy', 'Razorpay', 'Zomato', 'Amazon']],
    [2023, 290, 219, 5.5, 6.4, 19.0, ['Infosys', 'Zomato', 'PhonePe', 'Swiggy', 'Amazon']]
  ],
  meridian: [
    [2025, 420, 286, 4.8, 5.6, 14.0, ['Deloitte', 'JP Morgan', 'Zerodha', 'Infosys', 'Razorpay']],
    [2024, 410, 271, 4.5, 5.2, 12.5, ['Deloitte', 'JP Morgan', 'Infosys', 'Amazon', 'Razorpay']],
    [2023, 400, 262, 4.2, 5.0, 11.0, ['Deloitte', 'Infosys', 'JP Morgan', 'Zerodha', 'Amazon']]
  ]
};

const FIRST_NAMES = [
  'Aarav', 'Ananya', 'Rohan', 'Ishita', 'Kabir', 'Meera', 'Arjun', 'Priya',
  'Vivaan', 'Sanya', 'Aditya', 'Nikhil', 'Tara', 'Rahul', 'Shreya', 'Karan',
  'Diya', 'Siddharth', 'Neha', 'Varun', 'Anika', 'Manav', 'Riya', 'Devansh',
  'Pooja', 'Yash', 'Kavya', 'Aryan', 'Sneha', 'Harsh', 'Aisha', 'Rajat'
];

const LAST_NAMES = [
  'Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Mehta', 'Kapoor', 'Bose',
  'Chatterjee', 'Rao', 'Malhotra', 'Joshi', 'Deshpande', 'Pillai', 'Banerjee',
  'Gupta', 'Singh', 'Patel', 'Menon', 'Krishnan', 'Agarwal', 'Bhatt'
];

const COMPANIES = [
  { name: 'Google', industry: 'Software & Internet' },
  { name: 'Microsoft', industry: 'Software & Internet' },
  { name: 'Amazon', industry: 'E-commerce & Retail' },
  { name: 'Goldman Sachs', industry: 'Financial Services' },
  { name: 'JP Morgan', industry: 'Financial Services' },
  { name: 'McKinsey & Co', industry: 'Consulting' },
  { name: 'Boston Consulting Group', industry: 'Consulting' },
  { name: 'Stripe', industry: 'Fintech' },
  { name: 'Razorpay', industry: 'Fintech' },
  { name: 'PhonePe', industry: 'Fintech' },
  { name: 'Zerodha', industry: 'Fintech' },
  { name: 'Zomato', industry: 'Consumer Internet' },
  { name: 'Swiggy', industry: 'Consumer Internet' },
  { name: 'Atlassian', industry: 'Software & Internet' },
  { name: 'Nvidia', industry: 'Semiconductors' },
  { name: 'Qualcomm', industry: 'Semiconductors' },
  { name: 'Tata Motors', industry: 'Manufacturing' },
  { name: 'Infosys', industry: 'IT Services' }
];

const CITIES = [
  'Bengaluru', 'Mumbai', 'Delhi NCR', 'Hyderabad', 'Pune', 'Chennai',
  'San Francisco Bay Area', 'Seattle', 'London', 'Singapore', 'New York'
];

const ROLES_TECH = [
  'Software Engineer', 'Senior Software Engineer', 'Staff Engineer',
  'Engineering Manager', 'Product Manager', 'Senior Product Manager',
  'Data Scientist', 'Machine Learning Engineer', 'Engineering Lead'
];

const ROLES_COMMERCE = [
  'Investment Banking Analyst', 'Associate Consultant', 'Engagement Manager',
  'Business Analyst', 'Quantitative Analyst', 'Corporate Finance Associate'
];

const SKILLS_TECH = [
  'Python', 'JavaScript', 'TypeScript', 'React', 'System Design',
  'Distributed Systems', 'SQL', 'Machine Learning', 'Go', 'Kubernetes', 'Java'
];

const SKILLS_COMMERCE = [
  'Financial Modelling', 'Valuation', 'SQL', 'Data Analysis', 'Excel',
  'Market Research', 'Stakeholder Management', 'Corporate Finance'
];

const TOPICS = [
  'Resume Review',
  'Career Guidance',
  'Mock Interview',
  'Career transitions',
  'Placement preparation',
  'Higher studies abroad'
];

// How long ago each sandbox institution joined the platform (matches its subscription history).
const INST_AGE_DAYS = { westbridge: 230, lakeview: 130, meridian: 18, greenfield: 33 };

// One password for every sandbox (reviewer) account. Real partner accounts never use it.
export const SANDBOX_PASSWORD = 'Sandbox@2026';
export const SANDBOX_EXTERNAL_EMAILS = ['aarav.school@example.com', 'meera.premium@example.com'];

// Removes every fictional sandbox institution (cascading to its members and records)
// and the sandbox visiting-student accounts. Real institutions are never touched.
export function removeSandbox() {
  // Feedback written from sandbox accounts would otherwise lose its link and look like real feedback.
  db.prepare(`DELETE FROM feedback WHERE institution_id IN (SELECT id FROM institutions WHERE is_sandbox = 1)
    OR user_id IN (SELECT id FROM users WHERE is_sandbox = 1)`).run();
  db.prepare('DELETE FROM institutions WHERE is_sandbox = 1').run();
  const marks = SANDBOX_EXTERNAL_EMAILS.map(() => '?').join(',');
  db.prepare(`DELETE FROM users WHERE role = 'EXTERNAL' AND email IN (${marks})`).run(...SANDBOX_EXTERNAL_EMAILS);
}

/**
 * mode 'full'    — local development: wipes the whole database, then loads sandbox data
 *                  and a local platform account. Refused in production.
 * mode 'sandbox' — safe anywhere: rebuilds only the fictional reviewer institutions.
 */
export function runSeed({ mode, authorization } = {}) {
  // No implicit mode: calling runSeed() must never wipe anything.
  if (mode !== 'full' && mode !== 'sandbox') {
    throw new Error("runSeed requires an explicit mode: 'full' (destructive, needs an authorization capability) or 'sandbox'.");
  }
  // First statement of the destructive path, before any SQL runs.
  if (mode === 'full') assertDestructiveAllowed(dbPath, 'run a full seed', authorization);
  console.log(`Seeding Alumni Connect Platform database (${mode} mode)...`);
  R = createRng();
  if (mode === 'full') {
    dropAllTables(authorization);
    initSchema();
  } else {
    removeSandbox();
  }

  // 1. Institutions, courses, placements
  const insertInstRow = db.prepare(`
    INSERT INTO institutions (id, name, short_name, abbr, domain, city, state, type, founded, hue, about, email_domain, website,
      kind, data_sharing, platform_verified, contact_email, public_profile, is_sandbox)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  // Seeded colleges opted into platform sharing so the visiting-student features have data.
  const insertInst = {
    run: (...a) => insertInstRow.run(...a, 'COLLEGE', 'PLATFORM', 1, `admin@${a[11]}`, 1)
  };
  const insertCourse = db.prepare(`
    INSERT INTO courses (id, institution_id, name, level, duration_years, seats, annual_fee_inr, eligibility, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPlacement = db.prepare(`
    INSERT INTO placement_stats (id, institution_id, year, students_eligible, students_placed, median_ctc_lpa, average_ctc_lpa, highest_ctc_lpa, top_recruiters_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const inst of INSTITUTIONS) {
    insertInst.run(
      inst.id, inst.name, inst.short_name, inst.abbr, inst.domain,
      inst.city, inst.state, inst.type, inst.founded, inst.hue, inst.about, inst.email_domain, inst.website
    );
    COURSE_CATALOGUE[inst.id].forEach((c, idx) => insertCourse.run(`co_${inst.id}_${idx + 1}`, inst.id, ...c));
    PLACEMENTS[inst.id].forEach(([year, elig, placed, med, avg, high, recruiters]) =>
      insertPlacement.run(`pl_${inst.id}_${year}`, inst.id, year, elig, placed, med, avg, high, JSON.stringify(recruiters)));
  }

  // 2. Fixed persona users
  // Generated members get a random password nobody knows; named reviewer personas share SANDBOX_PASSWORD.
  const defaultPwHash = hashPassword(crypto.randomUUID());
  const sandboxPwHash = hashPassword(SANDBOX_PASSWORD);
  const adminPwHash = sandboxPwHash;
  const alumniPwHash = sandboxPwHash;
  const studentPwHash = sandboxPwHash;
  const externalPwHash = sandboxPwHash;
  const premiumPwHash = sandboxPwHash;

  const insertUser = db.prepare(`
    INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at, reject_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const adminId = 'u_admin_iitb';
  insertUser.run(adminId, 'westbridge', 'admin@westbridge.example', adminPwHash, 'ADMIN', 'Priya Menon', 'VERIFIED', '2025-01-10', null);

  const rohanId = 'u_alumni_rohan';
  insertUser.run(rohanId, 'westbridge', 'rohan@example.com', alumniPwHash, 'ALUMNI', 'Rohan Deshpande', 'VERIFIED', '2025-01-15', null);

  const ishitaId = 'u_student_ishita';
  insertUser.run(ishitaId, 'westbridge', 'ishita@example.com', studentPwHash, 'STUDENT', 'Ishita Rao', 'VERIFIED', '2025-08-01', null);

  // Local development only: a platform account. In production the platform account is
  // created from PLATFORM_ADMIN_EMAIL / PLATFORM_ADMIN_PASSWORD at server start.
  if (mode === 'full') {
    insertUser.run('u_superadmin', null, 'superadmin@alumniplatform.com', hashPassword('superadmin123'), 'SUPERADMIN', 'Operations Team', 'VERIFIED', '2025-01-01', null);
  }
  db.prepare("UPDATE users SET admin_level = 'OWNER' WHERE id = ?").run(adminId);

  const insertAlumniProfile = db.prepare(`
    INSERT INTO alumni_profiles (
      id, user_id, graduation_year, degree, branch, current_company, current_role,
      industry, location, linkedin_url, bio, headline, is_open_to_mentoring, open_to_external,
      visibility, details_confirmed_at, stale_months, skills_json, mentorship_topics_json, higher_ed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rohanProfileId = 'ap_rohan';
  insertAlumniProfile.run(
    rohanProfileId, rohanId, 2016, 'B.Tech', 'Computer Science',
    'Stripe', 'Staff Engineer', 'Fintech', 'Bengaluru',
    'https://linkedin.com/in/rohandeshpande',
    'Payments infrastructure engineer passionate about distributed systems and fintech reliability.',
    'Staff Engineer at Stripe. Former Razorpay and Amazon.',
    1, 1, 'PUBLIC', '2026-08-10', 1,
    JSON.stringify(['Distributed Systems', 'Python', 'Go', 'System Design', 'SQL']),
    JSON.stringify(['Career Guidance', 'Resume Review', 'Mock Interview']),
    'M.S. Computer Science, Georgia Tech'
  );

  const insertStep = db.prepare(`
    INSERT INTO career_steps (id, alumni_profile_id, year, role, company, is_current, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertStep.run('cs_1', rohanProfileId, 2016, 'Graduated · B.Tech CS', 'Westbridge Tech', 0, 1);
  insertStep.run('cs_2', rohanProfileId, 2018, 'Software Engineer', 'Amazon', 0, 2);
  insertStep.run('cs_3', rohanProfileId, 2021, 'Senior Software Engineer', 'Razorpay', 0, 3);
  insertStep.run('cs_4', rohanProfileId, 2024, 'Staff Engineer', 'Stripe', 1, 4);

  const harishId = 'u_alumni_harish';
  insertUser.run(harishId, 'westbridge', 'harish.test.alum@example.com', alumniPwHash, 'ALUMNI', 'Harish Test Alum', 'VERIFIED', '2025-01-20', null);
  const harishProfileId = 'ap_harish';
  insertAlumniProfile.run(
    harishProfileId, harishId, 2021, 'B.Tech', 'Computer Science',
    'Google', 'Staff Software Engineer', 'Software & Internet', 'Bengaluru',
    'https://linkedin.com/in/harishtestalum',
    'Distributed systems, scalable cloud infrastructure and backend platforms.',
    'Staff Software Engineer at Google',
    1, 1, 'PUBLIC', '2026-08-15', 1,
    JSON.stringify(['System Design', 'Python', 'TypeScript', 'React', 'Go']),
    JSON.stringify(['Career Guidance', 'Resume Review', 'Mock Interview']),
    null
  );
  insertStep.run('cs_h_1', harishProfileId, 2021, 'Graduated · B.Tech CS', 'Westbridge Tech', 0, 1);
  insertStep.run('cs_h_2', harishProfileId, 2024, 'Staff Software Engineer', 'Google', 1, 2);

  // Current students
  const insertStudentProfile = db.prepare(`
    INSERT INTO student_profiles (id, user_id, graduation_year, degree, branch, roll_number, target_industry, target_role, bio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStudentProfile.run(
    'sp_ishita', ishitaId, 2027, 'B.Tech', 'Computer Science', '22B1043',
    'Fintech', 'Product Engineer',
    'Third-year undergraduate interested in distributed systems, fintech infra, and product engineering.'
  );

  // Two current-student signups waiting for the admin (non-college email addresses)
  const pendingStudents = [
    ['u_stud_pend_1', 'Riya Kulkarni', 'riya.kulkarni.student@gmail.com', 2028, 'B.Tech', 'Electrical', '24B3011'],
    ['u_stud_pend_2', 'Omkar Shetty', 'omkar.s.student@gmail.com', 2027, 'B.Tech', 'Mechanical', '23B2207']
  ];
  pendingStudents.forEach(([id, name, email, year, deg, br, roll], idx) => {
    insertUser.run(id, 'westbridge', email, defaultPwHash, 'STUDENT', name, 'PENDING', null, null);
    insertStudentProfile.run(`sp_pend_${idx + 1}`, id, year, deg, br, roll, null, null, null);
  });

  // 3. Students from other colleges and schools
  const insertExternal = db.prepare(`
    INSERT INTO external_profiles (id, user_id, education_level, current_institution, current_year, field_of_interest, interested_institution_id, city)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const aaravId = 'u_ext_aarav';
  insertUser.run(aaravId, null, 'aarav.school@example.com', externalPwHash, 'EXTERNAL', 'Aarav Khanna', 'VERIFIED', '2026-09-01', null);
  insertExternal.run('ep_aarav', aaravId, 'SCHOOL', 'Sunrise Public School, Kanpur', 'Class 12', 'Computer Science', 'westbridge', 'New Delhi');

  const meeraId = 'u_ext_meera';
  insertUser.run(meeraId, null, 'meera.premium@example.com', premiumPwHash, 'EXTERNAL', 'Meera Joshi', 'VERIFIED', '2026-08-20', null);
  insertExternal.run('ep_meera', meeraId, 'COLLEGE', 'Riverside Science College, Pune', 'B.Sc. 2nd year', 'Data Science', 'westbridge', 'Pune');

  db.prepare(`
    INSERT INTO subscriptions (id, user_id, plan_id, amount_inr, started_at, expires_at, auto_renew, payment_ref)
    VALUES ('sub_meera', ?, 'premium_annual', 3999, datetime('now', '-20 days'), datetime('now', '+345 days'), 1, 'DEMO-SEED0001')
  `).run(meeraId);

  // 4. Generated alumni across the 3 institutions
  let alumCount = 0;
  const alumniIds = [rohanId];
  const verifiedByInst = { westbridge: [], lakeview: [], meridian: [] };

  for (const inst of INSTITUTIONS) {
    const isTech = inst.domain === 'engineering';
    const rolePool = isTech ? ROLES_TECH : ROLES_COMMERCE;
    const skillPool = isTech ? SKILLS_TECH : SKILLS_COMMERCE;
    const countForInst = inst.id === 'westbridge' ? 50 : inst.id === 'lakeview' ? 35 : 25;

    for (let k = 0; k < countForInst; k++) {
      alumCount++;
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const fullName = `${first} ${last}`;
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${alumCount}@example.com`;
      const batch = int(2014, 2024);
      const yearsOut = 2026 - batch;
      const comp = pick(COMPANIES);
      const role = pick(rolePool);
      const city = pickW(CITIES, [24, 16, 16, 12, 8, 8, 4, 4, 3, 3, 2]);
      const degree = pick(inst.courses);
      const isOpenToMentor = R() < (yearsOut >= 4 ? 0.6 : 0.35) ? 1 : 0;
      const status = pickW(['VERIFIED', 'VERIFIED', 'VERIFIED', 'PENDING', 'REJECTED'], [60, 20, 10, 8, 2]);
      const rejectReason = status === 'REJECTED' ? 'Graduation year and degree could not be verified in institution records' : null;
      const verifiedAt = status === 'VERIFIED' ? `2025-0${int(1, 9)}-15` : null;

      const userId = `u_alum_${alumCount}`;
      insertUser.run(userId, inst.id, email, defaultPwHash, 'ALUMNI', fullName, status, verifiedAt, rejectReason);

      const profileId = `ap_${alumCount}`;
      const selectedSkills = many(skillPool, int(3, 6));
      const selectedTopics = isOpenToMentor ? many(TOPICS, int(2, 3)) : [];
      const staleMonths = pickW([1, 4, 8, 14, 26], [30, 30, 20, 12, 8]);
      const openToExternal = isOpenToMentor && R() < 0.5 ? 1 : 0;

      insertAlumniProfile.run(
        profileId, userId, batch, degree, degree.includes('Commerce') ? 'Commerce' : 'Engineering',
        comp.name, role, comp.industry, city,
        `https://linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`,
        `${role} at ${comp.name} with ${yearsOut}+ years experience in ${comp.industry}.`,
        `${role} at ${comp.name}`,
        isOpenToMentor, openToExternal, 'PUBLIC', '2026-01-15', staleMonths,
        JSON.stringify(selectedSkills), JSON.stringify(selectedTopics),
        yearsOut >= 5 && R() < 0.25 ? 'MBA / Masters Degree' : null
      );

      insertStep.run(`cs_${alumCount}_0`, profileId, batch, `Graduated · ${degree}`, inst.short_name, 0, 1);
      if (yearsOut >= 5) {
        insertStep.run(`cs_${alumCount}_1`, profileId, batch + 2, 'Software Engineer', pick(COMPANIES).name, 0, 2);
      }
      insertStep.run(`cs_${alumCount}_now`, profileId, 2026, role, comp.name, 1, 3);

      if (status === 'VERIFIED') {
        alumniIds.push(userId);
        verifiedByInst[inst.id].push({ userId, company: comp.name, city });
      }
    }
  }

  // 5. Verification queue: 5 pending alumni claims for Westbridge Tech
  const pendingCandidates = [
    { name: 'Karan Saxena', email: 'karan.saxena.claim@gmail.com', batch: 2019, degree: 'B.Tech Mechanical', comp: 'Tata Motors', role: 'Design Engineer' },
    { name: 'Tanvi Chopra', email: 'tanvi.c.claim@gmail.com', batch: 2021, degree: 'B.Tech Computer Science', comp: 'Microsoft', role: 'Software Engineer' },
    { name: 'Aditya Rao', email: 'aditya.rao.claim@gmail.com', batch: 2017, degree: 'M.Tech Microelectronics', comp: 'Nvidia', role: 'Hardware Design Engineer' },
    { name: 'Nikita Dutta', email: 'nikita.dutta.claim@gmail.com', batch: 2022, degree: 'B.Tech Electrical', comp: 'PhonePe', role: 'Systems Analyst' },
    { name: 'Vikram Ahuja', email: 'vikram.ahuja.claim@gmail.com', batch: 2020, degree: 'MBA', comp: 'McKinsey & Co', role: 'Associate Consultant' }
  ];

  pendingCandidates.forEach((c, idx) => {
    const pUserId = `u_pend_${idx + 1}`;
    insertUser.run(pUserId, 'westbridge', c.email, defaultPwHash, 'ALUMNI', c.name, 'PENDING', null, null);
    const pProfId = `ap_pend_${idx + 1}`;
    insertAlumniProfile.run(
      pProfId, pUserId, c.batch, c.degree, 'Engineering',
      c.comp, c.role, 'Technology', 'Bengaluru',
      `https://linkedin.com/in/${c.name.toLowerCase().replace(' ', '')}`,
      `Claimed affiliation as alumnus of Westbridge Tech, Class of ${c.batch}.`,
      `${c.role} at ${c.comp}`,
      1, 0, 'PUBLIC', '2026-09-01', 0,
      JSON.stringify(['System Architecture', 'Design']),
      JSON.stringify(['Career Guidance', 'Resume Review']),
      null
    );
    insertStep.run(`cs_pend_${idx}_0`, pProfId, c.batch, `Graduated · ${c.degree}`, 'Westbridge Tech', 0, 1);
    insertStep.run(`cs_pend_${idx}_now`, pProfId, 2026, c.role, c.comp, 1, 2);
  });

  // 6. Roster records for CSV onboarding match
  const insertRoster = db.prepare(`
    INSERT INTO roster_records (id, institution_id, email, full_name, graduation_year, degree, branch, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sampleRoster = [
    { email: 'new.graduate@alumni.westbridge.example', name: 'Siddharth Varma', batch: 2024, degree: 'B.Tech', branch: 'Computer Science' },
    { email: 'divya.nair@alumni.westbridge.example', name: 'Divya Nair', batch: 2023, degree: 'B.Tech', branch: 'Electrical' },
    { email: 'amitabh.roy@alumni.westbridge.example', name: 'Amitabh Roy', batch: 2022, degree: 'M.Tech', branch: 'Data Science' },
    { email: 'swati.patel@alumni.westbridge.example', name: 'Swati Patel', batch: 2021, degree: 'B.Tech', branch: 'Mechanical' },
    { email: 'rahul.mehta@alumni.westbridge.example', name: 'Rahul Mehta', batch: 2020, degree: 'MBA', branch: 'Management' }
  ];
  sampleRoster.forEach((r, idx) => {
    insertRoster.run(`rr_${idx + 1}`, 'westbridge', r.email, r.name, r.batch, r.degree, r.branch, 'UNCLAIMED');
  });

  // 7. Mentorship requests across states
  const insertReq = db.prepare(`
    INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, is_external, topic, message, status, response_note, meeting_info, responded_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertReq.run(
    'req_1', 'westbridge', ishitaId, rohanId, 0, 'Career Guidance',
    'Hi Rohan, I am a 3rd year CS student at Westbridge Tech looking to transition into distributed backend systems. Could you share how you prepared for Stripe interviews and what projects made a difference?',
    'ACCEPTED', 'Happy to connect Ishita! Let us set up a 30-minute chat.',
    'Google Meet: https://meet.google.com/qrs-tuvw-xyz | Email: rohan.deshpande@stripe.com | Slot: Tuesday 6:00 PM IST',
    '2026-09-20 14:30:00', '2026-09-18 10:15:00'
  );

  const iitbAlum1 = verifiedByInst.westbridge[0]?.userId || harishId;
  const iitbAlum2 = verifiedByInst.westbridge[1]?.userId || harishId;
  insertReq.run(
    'req_2', 'westbridge', ishitaId, iitbAlum1, 0, 'Resume Review',
    'Hello, I would really appreciate your feedback on my tech resume for upcoming off-campus placement season. I have focused on open-source distributed systems work.',
    'PENDING', null, null, null, '2026-09-24 16:45:00'
  );
  insertReq.run(
    'req_3', 'westbridge', ishitaId, iitbAlum2, 0, 'Mock Interview',
    'Hi, would you be available for a 45-minute technical system design mock interview sometime this month before placements start?',
    'DECLINED', 'Apologies Ishita, currently traveling on tight release deliverables and unable to take mock sessions.',
    null, '2026-09-22 11:20:00', '2026-09-21 09:00:00'
  );

  // Premium external student requests
  insertReq.run(
    'req_4', 'westbridge', meeraId, rohanId, 1, 'Career Guidance',
    'Hi Rohan, I am a B.Sc. Data Science student from Riverside Science College in Pune. I am considering an M.Tech at Westbridge Tech versus going straight into industry. How did the masters route help you?',
    'PENDING', null, null, null, '2026-10-12 19:05:00'
  );
  insertReq.run(
    'req_5', 'westbridge', meeraId, harishId, 1, 'Resume Review',
    'Hello Harish, could you review my resume for backend internships? I have built two Flask projects and a small recommender system and want to know what to highlight.',
    'ACCEPTED', 'Sure Meera, send it over before our call.',
    'Google Meet: https://meet.google.com/abc-mnop-qrs | Saturday 11:00 AM IST',
    '2026-10-05 09:00:00', '2026-10-03 18:30:00'
  );

  // 8. Saved alumni
  db.prepare('INSERT INTO saved_alumni (id, user_id, alumni_profile_id) VALUES (?, ?, ?)').run('sa_1', ishitaId, rohanProfileId);

  // 9. Internships posted by alumni
  const insertIntern = db.prepare(`
    INSERT INTO internships (id, institution_id, posted_by, title, company, location, mode, stipend_inr_month, duration_weeks,
      description, skills_json, audience, status, deadline, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
  `);
  insertIntern.run('in_1', 'westbridge', rohanId, 'Backend Engineering Intern — Payments', 'Stripe', 'Bengaluru', 'HYBRID', 80000, 12,
    'Work with the payments reliability team on idempotent APIs and settlement pipelines. You will ship production code with a mentor and present a project at the end.',
    JSON.stringify(['Go', 'SQL', 'Distributed Systems']), 'ALL', '2026-12-15', '2026-10-01 10:00:00');
  insertIntern.run('in_2', 'westbridge', rohanId, 'Summer Research Intern — Fintech Fraud Models', 'Stripe', 'Remote', 'REMOTE', 50000, 8,
    'Explore graph-based fraud signals on anonymised data. Reserved for current Westbridge Tech students via the alumni network.',
    JSON.stringify(['Python', 'Machine Learning']), 'OWN_COLLEGE', '2026-11-30', '2026-10-08 10:00:00');
  insertIntern.run('in_3', 'westbridge', harishId, 'Frontend Intern — Cloud Console', 'Google', 'Hyderabad', 'ONSITE', 100000, 12,
    'Build accessible UI components for an internal cloud console used by thousands of engineers. Strong JavaScript fundamentals expected.',
    JSON.stringify(['TypeScript', 'React']), 'ALL', '2026-12-01', '2026-10-10 10:00:00');
  const bitsAlum = verifiedByInst.lakeview[0];
  if (bitsAlum) {
    insertIntern.run('in_4', 'lakeview', bitsAlum.userId, 'Product Analyst Intern', bitsAlum.company, bitsAlum.city, 'HYBRID', 40000, 10,
      'Analyse funnel data, write SQL dashboards and support product managers on experiment design for a consumer product.',
      JSON.stringify(['SQL', 'Excel', 'Data Analysis']), 'ALL', '2026-12-20', '2026-10-15 10:00:00');
  }
  const srccAlum = verifiedByInst.meridian[0];
  if (srccAlum) {
    insertIntern.run('in_5', 'meridian', srccAlum.userId, 'Equity Research Intern', srccAlum.company, srccAlum.city, 'ONSITE', 35000, 8,
      'Support sector analysts with financial models, earnings notes and industry primers. Ideal for commerce and economics students.',
      JSON.stringify(['Financial Modelling', 'Valuation', 'Excel']), 'OWN_COLLEGE', '2026-11-25', '2026-10-18 10:00:00');
  }

  db.prepare(`INSERT INTO internship_applications (id, internship_id, applicant_id, note, status) VALUES (?, ?, ?, ?, ?)`)
    .run('ia_1', 'in_1', ishitaId, 'I have built a toy payment ledger in Go with idempotency keys and would love to learn how it works at scale.', 'SHORTLISTED');

  seedSaasLayer({ insertUser, insertStudentProfile, insertAlumniProfile, insertStep, defaultPwHash, adminPwHash, studentPwHash, alumniPwHash, ishitaId, rohanId, harishId, rohanProfileId });
  seedActivityHistory();
  seedPhase2TestData(adminPwHash);
  const marks = SANDBOX_EXTERNAL_EMAILS.map(() => '?').join(',');
  db.prepare(`UPDATE users SET is_sandbox = 1 WHERE institution_id IN (SELECT id FROM institutions WHERE is_sandbox = 1)
    OR (role = 'EXTERNAL' AND email IN (${marks}))`).run(...SANDBOX_EXTERNAL_EMAILS);

  const totalUsers = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  console.log('Database seeded successfully!');
  console.log(`- Institutions: ${INSTITUTIONS.length} colleges + 1 school (with courses and placement records)`);
  console.log(`- Total users: ${totalUsers}`);
  console.log(`- Verified alumni: ${alumniIds.length + 1}`);
  console.log(`- Pending verification: ${pendingCandidates.length} alumni + ${pendingStudents.length} students (Westbridge Tech)`);
  console.log('- External students: 2 (1 free, 1 Premium)');
  console.log('- Internships: 5');
  console.log('- Institution subscriptions: Westbridge Tech (Growth, annual), Lakeview Engineering (Starter), Meridian Commerce (trial), Greenfield School (trial expired)');
}

// ---------------------------------------------------------------------------
// Phase 2 test data (sandbox only). Exercises every Phase 2 tool with fictional data:
//  - usage evidence: realistic account-creation dates, nothing before an institution joined,
//    weekly admin activity, and one partner of each kind for the "2 of the last 3 weeks" check
//    (Westbridge/Lakeview 3 of 3, Meridian 2 of 3, Greenfield 0 of 3);
//  - an empty, just-registered institution for the "empty account" failure path;
//  - a feedback log covering every type and decision, with at least two entries per partner.
// None of this is design-partner evidence: it lives in sandbox institutions, which are
// excluded from usage evidence, revenue and the feedback log by default.
// ---------------------------------------------------------------------------
function seedPhase2TestData(adminPwHash) {
  const day = (sqlTs) => sqlTs.slice(0, 10);

  // 1. Account creation dates, and nothing older than the account.
  for (const [instId, age] of Object.entries(INST_AGE_DAYS)) {
    const created = ago(age);
    db.prepare('UPDATE institutions SET created_at = ? WHERE id = ?').run(created, instId);
    db.prepare(`UPDATE users SET created_at = MAX(created_at, ?) WHERE institution_id = ?`).run(created, instId);
    db.prepare(`UPDATE users SET last_active_at = NULL WHERE institution_id = ? AND last_active_at < ?`).run(instId, created);
    db.prepare(`UPDATE roster_records SET imported_at = ? WHERE institution_id = ?`).run(ago(age - 1), instId);
    db.prepare(`DELETE FROM activity_daily WHERE institution_id = ? AND day < ?`).run(instId, day(created));
  }

  // 2. Weekly patterns. Usage windows: days 0–6, 7–13 and 14–20 ago are "the last 3 weeks".
  // Meridian (18-day trial) skipped the middle week: 2 of 3.
  db.prepare(`DELETE FROM activity_daily WHERE institution_id = 'meridian' AND day BETWEEN date('now', '-13 days') AND date('now', '-7 days')`).run();
  db.prepare(`UPDATE mentorship_requests SET created_at = datetime(created_at, '+7 days'),
      responded_at = CASE WHEN responded_at IS NULL THEN NULL ELSE MIN(datetime(responded_at, '+7 days'), datetime('now', '-1 hour')) END
    WHERE institution_id = 'meridian' AND created_at BETWEEN datetime('now', '-14 days') AND datetime('now', '-7 days')`).run();
  // Greenfield went quiet after its first two weeks, then its trial lapsed: 0 of 3.
  db.prepare(`DELETE FROM activity_daily WHERE institution_id = 'greenfield' AND day >= date('now', '-20 days')`).run();
  db.prepare(`UPDATE mentorship_requests SET created_at = datetime('now', '-' || (21 + abs(random()) % 10) || ' days'), responded_at = NULL, status = 'PENDING',
      response_note = NULL, meeting_info = NULL
    WHERE institution_id = 'greenfield' AND created_at > datetime('now', '-21 days')`).run();
  db.prepare(`DELETE FROM messages WHERE request_id IN (SELECT id FROM mentorship_requests WHERE institution_id = 'greenfield')
    AND (created_at > datetime('now', '-21 days') OR request_id IN (SELECT id FROM mentorship_requests WHERE institution_id = 'greenfield' AND status = 'PENDING'))`).run();
  db.prepare(`UPDATE users SET last_active_at = datetime('now', '-' || (21 + abs(random()) % 10) || ' days')
    WHERE institution_id = 'greenfield' AND last_active_at > datetime('now', '-21 days')`).run();
  // A reply never before its request, never in the future.
  db.prepare(`UPDATE mentorship_requests SET responded_at = MIN(datetime(created_at, '+2 hours'), datetime('now', '-5 minutes'))
    WHERE responded_at IS NOT NULL AND responded_at < created_at`).run();
  // Messages never before their request, never in the future.
  db.prepare(`UPDATE messages SET created_at = MIN(MAX(created_at, (SELECT r.created_at FROM mentorship_requests r WHERE r.id = messages.request_id)), datetime('now', '-30 minutes'))`).run();

  // 3. Admin activity across the last 4 weeks (shows up as "admin actions" and active admins).
  const insAudit = db.prepare(`INSERT INTO audit_logs (id, institution_id, actor_id, actor_name, actor_role, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insDay = db.prepare('INSERT OR IGNORE INTO activity_daily (user_id, institution_id, day) VALUES (?, ?, ?)');
  const members = (instId) => db.prepare(`SELECT id, role FROM users WHERE institution_id = ? AND role IN ('STUDENT','ALUMNI') AND verification_status = 'VERIFIED'`).all(instId);
  let a = 0;
  const adminDid = (instId, adminId, adminName, level, action, daysAgo, target = null, details = null) => {
    const ts = ago(daysAgo, int(1, 9));
    insAudit.run(`al_t${++a}`, instId, adminId, adminName, `ADMIN:${level}`, action, target ? target.role.toLowerCase() : null, target?.id || null, details, ts);
    insDay.run(adminId, instId, day(ts));
  };
  const routine = ['MEMBER_VERIFIED', 'MEMBER_VERIFIED', 'MEMBER_RECORD_UPDATED', 'MEMBERS_EXPORTED', 'USAGE_REPORT_EXPORTED'];
  const weeklyAdmin = (instId, admins, weekDays, perWeek) => {
    const pool = members(instId);
    for (const [from, to] of weekDays) {
      for (let k = 0; k < perWeek; k++) {
        const [id, name, level] = pick(admins);
        const action = pick(routine);
        adminDid(instId, id, name, level, action, int(from, to), action.startsWith('MEMBER_') ? pick(pool) : null);
      }
    }
  };
  const allWeeks = [[0, 6], [7, 13], [14, 20], [21, 27]];
  weeklyAdmin('westbridge', [['u_admin_iitb', 'Priya Menon', 'OWNER'], ['u_admin_iitb_2', 'Rahul Iyer', 'ADMIN']], allWeeks, 5);
  adminDid('westbridge', 'u_admin_iitb', 'Priya Menon', 'OWNER', 'PROGRAM_CREATED', 10, null, '"Placement Prep 2026"');
  adminDid('westbridge', 'u_admin_iitb', 'Priya Menon', 'OWNER', 'EVENT_CREATED', 5, null, '"Fintech careers: alumni panel"');
  adminDid('westbridge', 'u_admin_iitb', 'Priya Menon', 'OWNER', 'ANNOUNCEMENT_POSTED', 6, null, '{"title":"Placement season mentorship drive","audience":"ALL"}');
  weeklyAdmin('lakeview', [['u_admin_bits', 'Sunita Bhatt', 'OWNER']], allWeeks, 2);
  adminDid('meridian', 'u_admin_srcc', 'Arvind Khanna', 'OWNER', 'ROSTER_IMPORTED', 17, null, '{"record_type":"STUDENT","imported":10,"skipped":0,"errors":0}');
  adminDid('meridian', 'u_admin_srcc', 'Arvind Khanna', 'OWNER', 'ANNOUNCEMENT_POSTED', 15, null, '{"title":"We are live!","audience":"ALL"}');
  weeklyAdmin('meridian', [['u_admin_srcc', 'Arvind Khanna', 'OWNER']], [[0, 6], [14, 17]], 3);
  adminDid('greenfield', 'u_admin_gf', 'Dr. Lata Kulkarni', 'OWNER', 'ROSTER_IMPORTED', 32, null, '{"record_type":"STUDENT","imported":6,"skipped":0,"errors":0}');
  weeklyAdmin('greenfield', [['u_admin_gf', 'Dr. Lata Kulkarni', 'OWNER']], [[22, 30]], 3);
  db.prepare(`UPDATE users SET last_active_at = ? WHERE id = 'u_admin_gf'`).run(ago(22));
  db.prepare(`UPDATE users SET created_at = (SELECT created_at FROM institutions WHERE id = users.institution_id)
    WHERE role = 'ADMIN' AND institution_id IN (SELECT id FROM institutions WHERE is_sandbox = 1)`).run();

  // 4. An institution that registered today and has done nothing yet (empty-account path).
  db.prepare(`
    INSERT INTO institutions (id, name, short_name, abbr, kind, domain, city, state, type, founded, hue, about,
      email_domain, website, contact_email, data_sharing, public_profile, platform_verified, is_sandbox, created_at)
    VALUES ('northgate', 'Northgate Arts & Science College', 'Northgate College', 'NC', 'COLLEGE', 'general', 'Bhopal', 'Madhya Pradesh',
      'Affiliated Arts & Science College', 2009, 168, NULL, 'northgate.example', NULL, 'principal@northgate.example', 'PRIVATE', 1, 0, 1, ?)
  `).run(ago(0, 2));
  db.prepare(`INSERT INTO users (id, institution_id, email, password_hash, role, admin_level, full_name, verification_status, verified_at, created_at, last_active_at)
    VALUES ('u_admin_northgate', 'northgate', 'principal@northgate.example', ?, 'ADMIN', 'OWNER', 'Sanjay Tiwari', 'VERIFIED', date('now'), ?, ?)`)
    .run(adminPwHash, ago(0, 2), ago(0, 1));
  db.prepare(`INSERT INTO institution_subscriptions (id, institution_id, plan_id, billing_cycle, status, trial_ends_at, created_at)
    VALUES ('isub_northgate', 'northgate', 'growth', 'MONTHLY', 'TRIALING', ?, ?)`).run(ahead(30), ago(0, 2));
  insAudit.run('al_t_ng1', 'northgate', 'u_admin_northgate', 'Sanjay Tiwari', 'ADMIN:OWNER', 'INSTITUTION_REGISTERED', null, null, '{"plan":"growth","trial_days":30}', ago(0, 2));

  // 5. Feedback log: every type and decision, at least two entries per partner, newest last here.
  const insFb = db.prepare(`
    INSERT INTO feedback (id, institution_id, partner_name, person, person_role, user_id, source, channel, what_they_said, type,
      decision, decision_reason, shipped_on, evidence, partner_reaction, received_on, created_at, updated_at)
    VALUES (?, ?, (SELECT name FROM institutions WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ev = (slug) => `https://example.com/sandbox-evidence/${slug}`; // dummy links, clearly not real commits
  const fb = (n, inst, person, role, userId, channel, said, type, decision, reason, shippedDaysAgo, evidence, reaction, receivedDaysAgo) => {
    const received = ago(receivedDaysAgo);
    insFb.run(`fb_t${n}`, inst, inst, person, role, userId, userId ? 'IN_APP' : 'LOGGED_BY_TEAM', channel, said, type,
      decision, reason, shippedDaysAgo == null ? null : day(ago(shippedDaysAgo)), evidence, reaction, day(received), received,
      decision === 'New' ? null : ago(Math.min(receivedDaysAgo, shippedDaysAgo ?? receivedDaysAgo)));
  };
  fb(1, 'westbridge', 'Rahul Iyer', 'Institution admin', null, 'Visit',
    'Half our graduates have commas in their names in the register, like "Sen, Siddharth". The import splits them into two columns.',
    'Data or integration', 'Shipped', null, 21, ev('csv-quoted-names'), 'Re-imported the 2021 batch without a single error.', 26);
  fb(2, 'westbridge', 'Priya Menon', 'Institution owner', 'u_admin_iitb', 'In-app form',
    'We need to import current students too, not only alumni, so I do not have to approve each one by hand.',
    'Feature', 'Shipped', null, 14, ev('student-roster-import'), 'Imported the whole second-year class in one go.', 19);
  fb(3, 'westbridge', 'Ishita Rao', 'Student', 'u_student_ishita', 'In-app form',
    'After Rohan accepted I did not know where to talk to him, so I ended up emailing him.',
    'Usability', 'Shipped', null, 8, ev('mentorship-messages'), 'Used the messages to move our call to Tuesday.', 12);
  fb(4, 'westbridge', 'Rohan Deshpande', 'Alumnus', 'u_alumni_rohan', 'In-app form',
    'Can you ping me on WhatsApp when a student sends a request? I only open the site about once a week.',
    'Feature', 'Planned', 'Needs the paid WhatsApp Business API; planned for December after pricing is settled.', null, null, null, 5);
  fb(5, 'lakeview', 'Sunita Bhatt', 'Institution owner', null, 'Phone call',
    'Rs 4,999 a month is fine, but our budget is approved once a year, in July. Monthly bills are hard for our accounts office.',
    'Pricing or business', 'In progress', 'Drafting an academic-year plan billed in July.', null, null, null, 24);
  fb(6, 'lakeview', 'Sunita Bhatt', 'Institution owner', null, 'Visit',
    'We want to run our alumni meet through the platform, but events are not in our plan.',
    'Feature', "Won't do", 'Events stay in the Growth plan; offered her a two-week Growth trial instead.', null, null, 'Will discuss upgrading with the trustee.', 17);
  fb(7, 'lakeview', 'Sunita Bhatt', 'Institution owner', 'u_admin_bits', 'In-app form',
    'When I open the member export in Excel, names in Hindi show as strange symbols.',
    'Bug', 'New', null, null, null, null, 2);
  fb(8, 'meridian', 'Arvind Khanna', 'Institution owner', null, 'Visit',
    'My staff could not find where to approve students. They kept looking on the main page.',
    'Usability', 'Shipped', null, 4, ev('verification-queue-on-overview'), 'His office approved 30 pending students that afternoon.', 16);
  fb(9, 'meridian', 'Arvind Khanna', 'Institution owner', 'u_admin_srcc', 'In-app form',
    'Can parents get a login to see which alumni their child is talking to?',
    'Feature', "Won't do", 'Mentorship conversations stay between the student and the mentor; a parent view conflicts with student privacy.', null, null, 'Understood, said he agrees on privacy.', 3);
  fb(10, 'greenfield', 'Dr. Lata Kulkarni', 'Institution owner', null, 'Visit',
    'The trial ended in the middle of our exams. Can you extend it by two weeks?',
    'Pricing or business', "Won't do", 'Trial length is the same for every institution; offered a discounted first month instead.', null, null, 'Has not renewed yet.', 2);
  fb(11, 'greenfield', 'Dr. Lata Kulkarni', 'Institution owner', null, 'Phone call',
    'The renew page asks for online payment. As a school we pay by cheque against an invoice.',
    'Pricing or business', 'Planned', 'Offline invoices with cheque or NEFT payment planned for January.', null, null, null, 25);
  fb(12, 'northgate', 'Sanjay Tiwari', 'Institution owner', 'u_admin_northgate', 'In-app form',
    'I signed up, but I am not sure what to do first.',
    'Usability', 'New', null, null, null, null, 0);
}

// Daily-activity history for sandbox users who were active in the last 6 weeks,
// so the sandbox shows realistic week-by-week usage.
function seedActivityHistory() {
  const users = db.prepare(`
    SELECT u.id, u.institution_id, u.last_active_at FROM users u
    LEFT JOIN institutions i ON u.institution_id = i.id
    WHERE (i.is_sandbox = 1 OR u.role = 'EXTERNAL') AND u.last_active_at IS NOT NULL
      AND u.last_active_at > datetime('now', '-42 days')
  `).all();
  const ins = db.prepare('INSERT OR IGNORE INTO activity_daily (user_id, institution_id, day) VALUES (?, ?, ?)');
  for (const u of users) {
    ins.run(u.id, u.institution_id, u.last_active_at.slice(0, 10));
    const visitsPerWeek = int(1, 4);
    for (let w = 0; w < 6; w++) {
      for (let v = 0; v < visitsPerWeek; v++) {
        if (R() < 0.7) ins.run(u.id, u.institution_id, ago(w * 7 + int(0, 6)).slice(0, 10));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Institution SaaS layer: subscriptions, invoices, admin teams, a school tenant,
// current students, and six months of community activity for the value report.
// ---------------------------------------------------------------------------

function ago(days, hours = 0) {
  const d = new Date(Date.now() - days * 86400000 - hours * 3600000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function ahead(days, hours = 0) {
  return ago(-days, -hours);
}

function seedSaasLayer(ctx) {
  const { insertUser, insertStudentProfile, insertAlumniProfile, insertStep, defaultPwHash, adminPwHash, studentPwHash } = ctx;
  const { ishitaId, rohanId, harishId } = ctx;

  // --- A school tenant whose trial has lapsed (shows suspension behaviour) ---
  db.prepare(`
    INSERT INTO institutions (id, name, short_name, abbr, kind, domain, city, state, type, founded, hue, about,
      email_domain, website, contact_email, data_sharing, public_profile, platform_verified, is_sandbox)
    VALUES ('greenfield', 'Greenfield Public School, Lucknow', 'Greenfield School', 'GS', 'SCHOOL', 'school', 'Lucknow', 'Uttar Pradesh',
      'CBSE Senior Secondary School', 1994, 150,
      'Co-educational CBSE school (fictional, for the demo) with a strong science and commerce stream and an active alumni association.',
      'greenfield.example', 'https://greenfield.example', 'principal@greenfield.example', 'PRIVATE', 1, 1, 1)
  `).run();
  const insertCourse = db.prepare(`INSERT INTO courses (id, institution_id, name, level, duration_years, seats, annual_fee_inr, eligibility, description)
    VALUES (?, 'greenfield', ?, 'SCHOOL', ?, ?, ?, ?, ?)`);
  insertCourse.run('co_gf_1', 'Class 11–12 Science (PCM / PCB)', 2, 120, 85000, 'Class 10 board result', 'Physics, Chemistry with Maths or Biology.');
  insertCourse.run('co_gf_2', 'Class 11–12 Commerce', 2, 80, 80000, 'Class 10 board result', 'Accountancy, Business Studies, Economics.');
  insertCourse.run('co_gf_3', 'Class 1–10', 10, 900, 70000, 'Age-based admission', 'Primary, middle and secondary school.');

  // --- Admin teams ---
  const insertAdmin = db.prepare(`INSERT INTO users (id, institution_id, email, password_hash, role, admin_level, full_name, verification_status, verified_at, last_active_at)
    VALUES (?, ?, ?, ?, 'ADMIN', ?, ?, 'VERIFIED', '2025-01-10', ?)`);
  insertAdmin.run('u_admin_iitb_2', 'westbridge', 'alumni.office@westbridge.example', adminPwHash, 'ADMIN', 'Rahul Iyer', ago(2));
  insertAdmin.run('u_admin_bits', 'lakeview', 'admin@lakeview.example', adminPwHash, 'OWNER', 'Sunita Bhatt', ago(1));
  insertAdmin.run('u_admin_srcc', 'meridian', 'admin@meridian.example', adminPwHash, 'OWNER', 'Arvind Khanna', ago(0, 5));
  insertAdmin.run('u_admin_gf', 'greenfield', 'principal@greenfield.example', adminPwHash, 'OWNER', 'Dr. Lata Kulkarni', ago(3));
  db.prepare("UPDATE users SET last_active_at = ? WHERE id = 'u_admin_iitb'").run(ago(0, 1));

  // --- Subscriptions & invoices ---
  const insertSub = db.prepare(`INSERT INTO institution_subscriptions (id, institution_id, plan_id, billing_cycle, status, trial_ends_at, current_period_start, current_period_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertInvoice = db.prepare(`INSERT INTO institution_invoices (id, institution_id, plan_id, billing_cycle, amount_inr, period_start, period_end, status, payment_ref, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PAID', ?, ?)`);
  insertSub.run('isub_iitb', 'westbridge', 'growth', 'ANNUAL', 'ACTIVE', null, ago(200), ahead(165), ago(230));
  insertInvoice.run('inv_iitb_1', 'westbridge', 'growth', 'ANNUAL', 129990, ago(200), ahead(165), 'DEMO-SEEDIITB0001', ago(200));
  insertSub.run('isub_bits', 'lakeview', 'starter', 'MONTHLY', 'ACTIVE', null, ago(10), ahead(20), ago(130));
  [100, 70, 40, 10].forEach((d, i) => insertInvoice.run(`inv_bits_${i}`, 'lakeview', 'starter', 'MONTHLY', 4999, ago(d), ago(d - 30), `DEMO-SEEDBITS000${i}`, ago(d)));
  insertSub.run('isub_srcc', 'meridian', 'growth', 'MONTHLY', 'TRIALING', ahead(12), null, null, ago(18));
  insertSub.run('isub_gf', 'greenfield', 'starter', 'MONTHLY', 'TRIALING', ago(3), null, null, ago(33));

  // --- Student roster (non-domain emails that should still auto-verify) ---
  db.prepare(`INSERT INTO roster_records (id, institution_id, record_type, email, full_name, graduation_year, degree, branch, status)
    VALUES ('rr_s1', 'westbridge', 'STUDENT', 'aditi.sharma.student@gmail.com', 'Aditi Sharma', 2028, 'B.Tech', 'Chemical', 'UNCLAIMED')`).run();
  db.prepare(`INSERT INTO roster_records (id, institution_id, record_type, email, full_name, graduation_year, degree, branch, status)
    VALUES ('rr_s2', 'westbridge', 'STUDENT', 'varun.p.student@gmail.com', 'Varun Pillai', 2027, 'B.Tech', 'Civil', 'UNCLAIMED')`).run();

  // --- Current students per institution ---
  const studentsByInst = { westbridge: [ishitaId], lakeview: [], meridian: [], greenfield: [] };
  const plan = { westbridge: [30, 'B.Tech', ['Computer Science', 'Electrical', 'Mechanical', 'Chemical']], lakeview: [15, 'B.E.', ['Computer Science', 'Electronics']],
    meridian: [10, 'B.Com (Hons)', ['Commerce', 'Economics']], greenfield: [6, 'Class 12', ['Science', 'Commerce']] };
  const setCreated = db.prepare('UPDATE users SET created_at = ?, last_active_at = ? WHERE id = ?');
  let sc = 0;
  for (const [instId, [count, degree, branches]] of Object.entries(plan)) {
    for (let k = 0; k < count; k++) {
      sc++;
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      const id = `u_stu_${sc}`;
      const domain = { westbridge: 'westbridge.example', lakeview: 'lakeview.example', meridian: 'meridian.example', greenfield: 'greenfield.example' }[instId];
      insertUser.run(id, instId, `${first.toLowerCase()}.${last.toLowerCase()}.${sc}@${domain}`, defaultPwHash, 'STUDENT', `${first} ${last}`, 'VERIFIED', '2026-01-10', null);
      insertStudentProfile.run(`sp_stu_${sc}`, id, 2026 + int(1, instId === 'greenfield' ? 2 : 4), degree, pick(branches), `${instId.toUpperCase().slice(0, 2)}${2400 + sc}`, null, null, null);
      setCreated.run(ago(int(5, 180)), R() < 0.65 ? ago(int(0, 25)) : ago(int(31, 120)), id);
      studentsByInst[instId].push(id);
    }
  }
  setCreated.run(ago(400), ago(0, 2), ishitaId);

  // Greenfield alumni (school alumni mentoring juniors)
  const gfAlumni = [];
  ['Neha Joshi:2015:Doctor:AIIMS Delhi:Healthcare', 'Kunal Shah:2012:Chartered Accountant:Deloitte:Financial Services',
    'Sana Merchant:2018:Software Engineer:Atlassian:Software & Internet', 'Omkar Patil:2016:Civil Services Officer:Government of Maharashtra:Government & Public Sector',
    'Ritika Desai:2019:Product Designer:Swiggy:Consumer Internet'].forEach((row, i) => {
    const [name, year, role, company, industry] = row.split(':');
    const id = `u_gf_alum_${i + 1}`;
    insertUser.run(id, 'greenfield', `${name.split(' ')[0].toLowerCase()}.gf${i}@example.com`, defaultPwHash, 'ALUMNI', name, 'VERIFIED', '2026-08-01', null);
    insertAlumniProfile.run(`ap_gf_${i + 1}`, id, Number(year), 'Class 12', i % 2 ? 'Commerce' : 'Science', company, role, industry, 'Lucknow',
      null, `${role} at ${company}. Greenfield class of ${year}.`, `${role} at ${company}`, 1, 0, 'PUBLIC', '2026-08-01', 2,
      '[]', JSON.stringify(['Career Guidance', 'Higher studies abroad']), null);
    insertStep.run(`cs_gf_${i}_0`, `ap_gf_${i + 1}`, Number(year), 'Passed Class 12', 'Greenfield School', 0, 1);
    insertStep.run(`cs_gf_${i}_1`, `ap_gf_${i + 1}`, 2026, role, company, 1, 2);
    gfAlumni.push(id);
  });

  // Spread alumni join dates and activity realistically.
  for (const a of db.prepare("SELECT id FROM users WHERE role = 'ALUMNI' AND id NOT IN ('u_alumni_rohan')").all()) {
    setCreated.run(ago(int(60, 700)), R() < 0.4 ? ago(int(0, 28)) : (R() < 0.5 ? ago(int(31, 300)) : null), a.id);
  }
  setCreated.run(ago(650), ago(0, 3), rohanId);

  // --- Six months of mentorship activity, with messages on accepted ones ---
  const mentorsOf = (instId) => db.prepare(`SELECT u.id, ap.mentorship_topics_json FROM users u JOIN alumni_profiles ap ON ap.user_id = u.id
    WHERE u.institution_id = ? AND u.verification_status = 'VERIFIED' AND ap.is_open_to_mentoring = 1`).all(instId);
  const insertReq = db.prepare(`INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, topic, message, status, response_note, meeting_info, responded_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertMsg = db.prepare('INSERT INTO messages (id, request_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?)');
  const MSGS_S = ['Thank you so much for accepting! Is Thursday evening okay?', 'I have shared my resume over email, looking forward to your feedback.',
    'That advice on projects was really helpful.', 'Could we do a short follow-up before my interview next week?'];
  const MSGS_A = ['Happy to help. Thursday 7 pm works for me.', 'Went through it — tighten the project bullets and lead with impact.',
    'Good luck! Ping me after the interview.', 'Sure, let us do 20 minutes on Sunday morning.'];
  let rq = 0;
  for (const instId of ['westbridge', 'lakeview', 'meridian', 'greenfield']) {
    const mentors = instId === 'greenfield' ? gfAlumni.map(id => ({ id, mentorship_topics_json: '["Career Guidance"]' })) : mentorsOf(instId);
    const students = studentsByInst[instId];
    const volume = { westbridge: 70, lakeview: 30, meridian: 12, greenfield: 8 }[instId];
    for (let k = 0; k < volume && mentors.length && students.length; k++) {
      rq++;
      // Activity only after the institution joined the platform.
      const createdDays = int(1, Math.min(175, INST_AGE_DAYS[instId] - 1));
      const m = pick(mentors);
      const topics = JSON.parse(m.mentorship_topics_json || '[]');
      const topic = topics.length ? pick(topics) : 'Career Guidance';
      const roll = R();
      const status = createdDays < 6 && roll < 0.6 ? 'PENDING' : roll < 0.72 ? 'ACCEPTED' : roll < 0.88 ? 'DECLINED' : 'PENDING';
      const respondedHours = int(2, 96);
      const responded = status === 'PENDING' ? null : ago(createdDays, -respondedHours);
      const id = `req_h_${rq}`;
      insertReq.run(id, instId, pick(students), m.id, topic,
        `Hello! I am a current student and would value your guidance on ${topic.toLowerCase()}. Could we find 30 minutes in the coming weeks?`,
        status, status === 'ACCEPTED' ? 'Happy to help.' : status === 'DECLINED' ? 'Sorry, I am travelling this month.' : null,
        status === 'ACCEPTED' ? 'We will coordinate over messages.' : null, responded, ago(createdDays));
      if (status === 'ACCEPTED') {
        const stu = db.prepare('SELECT student_id FROM mentorship_requests WHERE id = ?').get(id).student_id;
        const nMsgs = int(1, 4);
        for (let x = 0; x < nMsgs; x++) {
          insertMsg.run(`msg_h_${rq}_${x}`, id, x % 2 ? m.id : stu, x % 2 ? MSGS_A[x % 4] : MSGS_S[x % 4], ago(Math.max(0, createdDays - 2 - x), -respondedHours));
        }
      }
    }
  }
  // Conversation on Ishita's accepted request with Rohan
  insertMsg.run('msg_r1', 'req_1', ishitaId, 'Thanks Rohan! Tuesday works. Should I prepare anything specific?', '2026-09-20 15:00:00');
  insertMsg.run('msg_r2', 'req_1', rohanId, 'Bring one system you built and be ready to walk through its trade-offs.', '2026-09-20 18:10:00');

  // --- Internship applications from students over time ---
  const insertApp = db.prepare('INSERT OR IGNORE INTO internship_applications (id, internship_id, applicant_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const iitbInternships = db.prepare("SELECT id FROM internships WHERE institution_id = 'westbridge'").all().map(r => r.id);
  for (let k = 0; k < 24; k++) {
    insertApp.run(`ia_h_${k}`, pick(iitbInternships), pick(studentsByInst.westbridge.slice(1)),
      'I have relevant project experience and would love to contribute to this team over the summer.',
      pickW(['APPLIED', 'SHORTLISTED', 'REJECTED'], [60, 25, 15]), ago(int(1, 60)));
  }

  // --- Announcements, events, programs (Westbridge Tech on Growth) ---
  const insertAnn = db.prepare('INSERT INTO announcements (id, institution_id, author_id, title, body, audience, pinned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insertAnn.run('an_1', 'westbridge', 'u_admin_iitb', 'Placement season mentorship drive', 'Alumni: please switch on mentorship availability for the next six weeks. Students: book mock interviews early — slots fill fast.', 'ALL', 1, ago(6));
  insertAnn.run('an_2', 'westbridge', 'u_admin_iitb_2', 'Update your career details', 'Accreditation reporting closes on 30 November. Please confirm your current employer and city on your dashboard.', 'ALUMNI', 0, ago(3));
  insertAnn.run('an_3', 'lakeview', 'u_admin_bits', 'Welcome to the Lakeview alumni platform', 'Find mentors from your batch seniors and explore internships shared by alumni.', 'ALL', 1, ago(40));
  insertAnn.run('an_4', 'meridian', 'u_admin_srcc', 'We are live!', 'Meridian Commerce students and alumni can now connect for mentorship on the platform.', 'ALL', 1, ago(15));

  const insertEvent = db.prepare(`INSERT INTO events (id, institution_id, title, description, starts_at, mode, location, audience, capacity, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertEvent.run('ev_1', 'westbridge', 'Fintech careers: alumni panel', 'Alumni from Stripe, Razorpay and Goldman Sachs share how they broke into fintech.', ahead(9).slice(0, 16), 'ONLINE', 'Google Meet link shared after RSVP', 'ALL', 300, 'u_admin_iitb', ago(5));
  insertEvent.run('ev_2', 'westbridge', 'Bengaluru alumni meetup', 'Evening meetup for alumni in Bengaluru. Final-year students heading to Bengaluru are welcome.', ahead(23).slice(0, 16), 'IN_PERSON', 'Indiranagar, Bengaluru', 'ALL', 80, 'u_admin_iitb', ago(4));
  insertEvent.run('ev_3', 'westbridge', 'Resume clinic with alumni', 'Twenty-minute one-to-one resume reviews.', ago(30).slice(0, 16), 'ONLINE', 'Zoom', 'STUDENTS', 60, 'u_admin_iitb', ago(45));
  const insertRsvp = db.prepare('INSERT OR IGNORE INTO event_rsvps (id, event_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  const iitbPeople = [...studentsByInst.westbridge, ...mentorsOf('westbridge').map(m => m.id)];
  let rv = 0;
  for (const [ev, count, maxAgo] of [['ev_1', 38, 5], ['ev_2', 21, 4], ['ev_3', 44, 44]]) {
    for (let k = 0; k < count; k++) insertRsvp.run(`rs_${rv++}`, ev, pick(iitbPeople), ago(int(0, maxAgo)));
  }

  db.prepare(`INSERT INTO mentorship_programs (id, institution_id, title, description, topic, starts_on, ends_on, mentee_capacity, status, created_by, created_at)
    VALUES ('mp_1', 'westbridge', 'Placement Prep 2026', 'Six-week programme pairing final-year students with alumni for mock interviews and resume reviews.',
    'Mock Interview', ?, ?, 40, 'OPEN', 'u_admin_iitb', ?)`).run(ago(3).slice(0, 10), ahead(39).slice(0, 10), ago(10));
  const insertPP = db.prepare('INSERT OR IGNORE INTO program_participants (id, program_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)');
  [rohanId, harishId, ...mentorsOf('westbridge').slice(0, 4).map(m => m.id)].forEach((id, i) => insertPP.run(`pp_m${i}`, 'mp_1', id, 'MENTOR', ago(int(1, 9))));
  [ishitaId, ...studentsByInst.westbridge.slice(1, 9)].forEach((id, i) => insertPP.run(`pp_s${i}`, 'mp_1', id, 'MENTEE', ago(int(1, 9))));

  // --- Audit trail samples ---
  const insertAudit = db.prepare(`INSERT INTO audit_logs (id, institution_id, actor_id, actor_name, actor_role, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertAudit.run('al_s1', 'westbridge', 'u_admin_iitb', 'Priya Menon', 'ADMIN:OWNER', 'SUBSCRIPTION_PAID', null, null, '{"plan":"growth","cycle":"ANNUAL","amount_inr":129990}', ago(200));
  insertAudit.run('al_s2', 'westbridge', 'u_admin_iitb', 'Priya Menon', 'ADMIN:OWNER', 'SETTINGS_UPDATED', null, null, '{"data_sharing":"PLATFORM"}', ago(199));
  insertAudit.run('al_s3', 'westbridge', 'u_admin_iitb', 'Priya Menon', 'ADMIN:OWNER', 'ROSTER_IMPORTED', null, null, '{"record_type":"ALUMNI","imported":5,"skipped":0,"errors":0}', ago(190));
  insertAudit.run('al_s4', 'westbridge', 'u_admin_iitb_2', 'Rahul Iyer', 'ADMIN:ADMIN', 'ANNOUNCEMENT_POSTED', 'announcement', 'an_2', '{"title":"Update your career details","audience":"ALUMNI"}', ago(3));
}

// The command line lives in ./seed-cli.js. This module has no entry point of its own.
