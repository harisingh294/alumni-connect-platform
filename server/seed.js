import { db, initSchema } from './db.js';
import { hashPassword } from './auth.js';
import crypto from 'node:crypto';

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

const R = createRng();
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
  {
    id: 'iitb',
    name: 'Indian Institute of Technology Bombay',
    short_name: 'IIT Bombay',
    abbr: 'IB',
    domain: 'engineering',
    city: 'Mumbai',
    state: 'Maharashtra',
    type: 'Institute of Eminence',
    founded: 1958,
    hue: 214,
    about: 'Premier technical university in Powai, Mumbai. Strong alumni concentrations in product engineering, quantitative finance, and technology ventures.',
    courses: ['B.Tech Computer Science', 'B.Tech Electrical', 'B.Tech Mechanical', 'M.Tech', 'MBA']
  },
  {
    id: 'bits',
    name: 'Birla Institute of Technology and Science, Pilani',
    short_name: 'BITS Pilani',
    abbr: 'BP',
    domain: 'engineering',
    city: 'Pilani',
    state: 'Rajasthan',
    type: 'Deemed University',
    founded: 1964,
    hue: 262,
    about: 'Renowned private university recognized for its Practice School model and deep global presence in tech startups and software engineering.',
    courses: ['B.E. Computer Science', 'B.E. Electronics', 'M.Sc. Economics', 'MBA']
  },
  {
    id: 'srcc',
    name: 'Shri Ram College of Commerce',
    short_name: 'SRCC',
    abbr: 'SR',
    domain: 'commerce',
    city: 'New Delhi',
    state: 'Delhi',
    type: 'Constituent College',
    founded: 1926,
    hue: 42,
    about: 'India’s premier commerce and economics college under the University of Delhi. Alumni cluster in investment banking, management consulting, and civil services.',
    courses: ['B.Com (Hons)', 'B.A. (Hons) Economics', 'M.Com']
  }
];

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

export function runSeed() {
  console.log('Seeding Alumni Connect Platform MVP database...');
  initSchema();

  // Clear existing records
  db.exec(`
    DELETE FROM saved_alumni;
    DELETE FROM mentorship_requests;
    DELETE FROM student_profiles;
    DELETE FROM career_steps;
    DELETE FROM alumni_profiles;
    DELETE FROM roster_records;
    DELETE FROM users;
    DELETE FROM institutions;
  `);

  // 1. Insert Institutions
  const insertInst = db.prepare(`
    INSERT INTO institutions (id, name, short_name, abbr, domain, city, state, type, founded, hue, about)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const inst of INSTITUTIONS) {
    insertInst.run(
      inst.id, inst.name, inst.short_name, inst.abbr, inst.domain,
      inst.city, inst.state, inst.type, inst.founded, inst.hue, inst.about
    );
  }

  // 2. Insert Core Fixed Persona Users
  const defaultPwHash = hashPassword('password123');
  const adminPwHash = hashPassword('admin123');
  const alumniPwHash = hashPassword('alumni123');
  const studentPwHash = hashPassword('student123');
  const superadminPwHash = hashPassword('superadmin123');

  const insertUser = db.prepare(`
    INSERT INTO users (id, institution_id, email, password_hash, role, full_name, verification_status, verified_at, reject_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Fixed Admin: Priya Menon (IIT Bombay)
  const adminId = 'u_admin_iitb';
  insertUser.run(adminId, 'iitb', 'admin@iitb.ac.in', adminPwHash, 'ADMIN', 'Priya Menon', 'VERIFIED', '2025-01-10', null);

  // Fixed Alumnus: Rohan Deshpande (IIT Bombay 2016)
  const rohanId = 'u_alumni_rohan';
  insertUser.run(rohanId, 'iitb', 'rohan@example.com', alumniPwHash, 'ALUMNI', 'Rohan Deshpande', 'VERIFIED', '2025-01-15', null);

  // Fixed Student: Ishita Rao (IIT Bombay 2027)
  const ishitaId = 'u_student_ishita';
  insertUser.run(ishitaId, 'iitb', 'ishita@example.com', studentPwHash, 'STUDENT', 'Ishita Rao', 'VERIFIED', '2025-08-01', null);

  // Fixed SuperAdmin
  const superadminId = 'u_superadmin';
  insertUser.run(superadminId, 'iitb', 'superadmin@alumniplatform.com', superadminPwHash, 'SUPERADMIN', 'Operations Team', 'VERIFIED', '2025-01-01', null);

  // Rohan's Profile & Steps
  const insertAlumniProfile = db.prepare(`
    INSERT INTO alumni_profiles (
      id, user_id, graduation_year, degree, branch, current_company, current_role,
      industry, location, linkedin_url, bio, headline, is_open_to_mentoring,
      visibility, details_confirmed_at, stale_months, skills_json, mentorship_topics_json, higher_ed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rohanProfileId = 'ap_rohan';
  insertAlumniProfile.run(
    rohanProfileId, rohanId, 2016, 'B.Tech', 'Computer Science',
    'Stripe', 'Staff Engineer', 'Fintech', 'Bengaluru',
    'https://linkedin.com/in/rohandeshpande',
    'Payments infrastructure engineer passionate about distributed systems and fintech reliability.',
    'Staff Engineer at Stripe. Former Razorpay and Amazon.',
    1, 'PUBLIC', '2026-08-10', 1,
    JSON.stringify(['Distributed Systems', 'Python', 'Go', 'System Design', 'SQL']),
    JSON.stringify(['Career Guidance', 'Resume Review', 'Mock Interview']),
    'M.S. Computer Science, Georgia Tech'
  );

  const insertStep = db.prepare(`
    INSERT INTO career_steps (id, alumni_profile_id, year, role, company, is_current, display_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertStep.run('cs_1', rohanProfileId, 2016, 'Graduated · B.Tech CS', 'IIT Bombay', 0, 1);
  insertStep.run('cs_2', rohanProfileId, 2018, 'Software Engineer', 'Amazon', 0, 2);
  insertStep.run('cs_3', rohanProfileId, 2021, 'Senior Software Engineer', 'Razorpay', 0, 3);
  insertStep.run('cs_4', rohanProfileId, 2024, 'Staff Engineer', 'Stripe', 1, 4);

  // Fixed Alumnus: Harish Test Alum (IIT Bombay 2021)
  const harishId = 'u_alumni_harish';
  insertUser.run(harishId, 'iitb', 'harish.test.alum@example.com', alumniPwHash, 'ALUMNI', 'Harish Test Alum', 'VERIFIED', '2025-01-20', null);
  const harishProfileId = 'ap_harish';
  insertAlumniProfile.run(
    harishProfileId, harishId, 2021, 'B.Tech', 'Computer Science',
    'Google', 'Staff Software Engineer', 'Software & Internet', 'Bengaluru',
    'https://linkedin.com/in/harishtestalum',
    'Distributed systems, scalable cloud infrastructure and backend platforms.',
    'Staff Software Engineer at Google',
    1, 'PUBLIC', '2026-08-15', 1,
    JSON.stringify(['System Design', 'Python', 'TypeScript', 'React', 'Go']),
    JSON.stringify(['Career Guidance', 'Resume Review', 'Mock Interview']),
    null
  );
  insertStep.run('cs_h_1', harishProfileId, 2021, 'Graduated · B.Tech CS', 'IIT Bombay', 0, 1);
  insertStep.run('cs_h_2', harishProfileId, 2024, 'Staff Software Engineer', 'Google', 1, 2);

  // Ishita's Student Profile
  const insertStudentProfile = db.prepare(`
    INSERT INTO student_profiles (id, user_id, graduation_year, degree, branch, target_industry, target_role, bio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStudentProfile.run(
    'sp_ishita', ishitaId, 2027, 'B.Tech', 'Computer Science',
    'Fintech', 'Product Engineer',
    'Third-year undergraduate interested in distributed systems, fintech infra, and product engineering.'
  );

  // 3. Generate 110 Realistic Alumni across the 3 institutions
  let alumCount = 0;
  const alumniIds = [rohanId];

  for (const inst of INSTITUTIONS) {
    const isTech = inst.domain === 'engineering';
    const rolePool = isTech ? ROLES_TECH : ROLES_COMMERCE;
    const skillPool = isTech ? SKILLS_TECH : SKILLS_COMMERCE;
    const countForInst = inst.id === 'iitb' ? 50 : inst.id === 'bits' ? 35 : 25;

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
      insertUser.run(
        userId, inst.id, email, defaultPwHash, 'ALUMNI', fullName, status, verifiedAt, rejectReason
      );

      const profileId = `ap_${alumCount}`;
      const selectedSkills = many(skillPool, int(3, 6));
      const selectedTopics = isOpenToMentor ? many(TOPICS, int(2, 3)) : [];
      const staleMonths = pickW([1, 4, 8, 14, 26], [30, 30, 20, 12, 8]);

      insertAlumniProfile.run(
        profileId, userId, batch, degree, degree.includes('Commerce') ? 'Commerce' : 'Engineering',
        comp.name, role, comp.industry, city,
        `https://linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}`,
        `${role} at ${comp.name} with ${yearsOut}+ years experience in ${comp.industry}.`,
        `${role} at ${comp.name}`,
        isOpenToMentor, 'PUBLIC', '2026-01-15', staleMonths,
        JSON.stringify(selectedSkills), JSON.stringify(selectedTopics),
        yearsOut >= 5 && R() < 0.25 ? 'MBA / Masters Degree' : null
      );

      // Add Career Steps
      insertStep.run(`cs_${alumCount}_0`, profileId, batch, `Graduated · ${degree}`, inst.short_name, 0, 1);
      if (yearsOut >= 5) {
        insertStep.run(`cs_${alumCount}_1`, profileId, batch + 2, 'Software Engineer', pick(COMPANIES).name, 0, 2);
      }
      insertStep.run(`cs_${alumCount}_now`, profileId, 2026, role, comp.name, 1, 3);

      if (status === 'VERIFIED') {
        alumniIds.push(userId);
      }
    }
  }

  // 4. Pre-populate Verification Queue (5 explicitly pending claims for IIT Bombay)
  const pendingCandidates = [
    { name: 'Karan Saxena', email: 'karan.saxena.claim@gmail.com', batch: 2019, degree: 'B.Tech Mechanical', comp: 'Tata Motors', role: 'Design Engineer' },
    { name: 'Tanvi Chopra', email: 'tanvi.c.claim@gmail.com', batch: 2021, degree: 'B.Tech Computer Science', comp: 'Microsoft', role: 'Software Engineer' },
    { name: 'Aditya Rao', email: 'aditya.rao.claim@gmail.com', batch: 2017, degree: 'M.Tech Microelectronics', comp: 'Nvidia', role: 'Hardware Design Engineer' },
    { name: 'Nikita Dutta', email: 'nikita.dutta.claim@gmail.com', batch: 2022, degree: 'B.Tech Electrical', comp: 'PhonePe', role: 'Systems Analyst' },
    { name: 'Vikram Ahuja', email: 'vikram.ahuja.claim@gmail.com', batch: 2020, degree: 'MBA', comp: 'McKinsey & Co', role: 'Associate Consultant' }
  ];

  pendingCandidates.forEach((c, idx) => {
    const pUserId = `u_pend_${idx + 1}`;
    insertUser.run(pUserId, 'iitb', c.email, defaultPwHash, 'ALUMNI', c.name, 'PENDING', null, null);
    const pProfId = `ap_pend_${idx + 1}`;
    insertAlumniProfile.run(
      pProfId, pUserId, c.batch, c.degree, 'Engineering',
      c.comp, c.role, 'Technology', 'Bengaluru',
      `https://linkedin.com/in/${c.name.toLowerCase().replace(' ', '')}`,
      `Claimed affiliation as alumnus of IIT Bombay, Class of ${c.batch}.`,
      `${c.role} at ${c.comp}`,
      1, 'PUBLIC', '2026-09-01', 0,
      JSON.stringify(['System Architecture', 'Design']),
      JSON.stringify(['Career Guidance', 'Resume Review']),
      null
    );
    insertStep.run(`cs_pend_${idx}_0`, pProfId, c.batch, `Graduated · ${c.degree}`, 'IIT Bombay', 0, 1);
    insertStep.run(`cs_pend_${idx}_now`, pProfId, 2026, c.role, c.comp, 1, 2);
  });

  // 5. Pre-seed Roster Records for CSV Onboarding Match
  const insertRoster = db.prepare(`
    INSERT INTO roster_records (id, institution_id, email, full_name, graduation_year, degree, branch, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sampleRoster = [
    { email: 'new.graduate@alumni.iitb.ac.in', name: 'Siddharth Varma', batch: 2024, degree: 'B.Tech', branch: 'Computer Science' },
    { email: 'divya.nair@alumni.iitb.ac.in', name: 'Divya Nair', batch: 2023, degree: 'B.Tech', branch: 'Electrical' },
    { email: 'amitabh.roy@alumni.iitb.ac.in', name: 'Amitabh Roy', batch: 2022, degree: 'M.Tech', branch: 'Data Science' },
    { email: 'swati.patel@alumni.iitb.ac.in', name: 'Swati Patel', batch: 2021, degree: 'B.Tech', branch: 'Mechanical' },
    { email: 'rahul.mehta@alumni.iitb.ac.in', name: 'Rahul Mehta', batch: 2020, degree: 'MBA', branch: 'Management' }
  ];

  sampleRoster.forEach((r, idx) => {
    insertRoster.run(`rr_${idx + 1}`, 'iitb', r.email, r.name, r.batch, r.degree, r.branch, 'UNCLAIMED');
  });

  // 6. Pre-seed Mentorship Requests across States (Pending, Accepted, Declined)
  const insertReq = db.prepare(`
    INSERT INTO mentorship_requests (id, institution_id, student_id, alumni_id, topic, message, status, response_note, meeting_info, responded_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Request 1: Accepted (Rohan Deshpande <- Ishita Rao)
  insertReq.run(
    'req_1', 'iitb', ishitaId, rohanId,
    'Career Guidance',
    'Hi Rohan, I am a 3rd year CS student at IIT Bombay looking to transition into distributed backend systems. Could you share how you prepared for Stripe interviews and what projects made a difference?',
    'ACCEPTED',
    'Happy to connect Ishita! Let us set up a 30-minute chat.',
    'Google Meet: https://meet.google.com/qrs-tuvw-xyz | Email: rohan.deshpande@stripe.com | Slot: Tuesday 6:00 PM IST',
    '2026-09-20 14:30:00',
    '2026-09-18 10:15:00'
  );

  // Request 2: Pending
  const targetAlum1 = alumniIds[1] || rohanId;
  insertReq.run(
    'req_2', 'iitb', ishitaId, targetAlum1,
    'Resume Review',
    'Hello, I would really appreciate your feedback on my tech resume for upcoming off-campus placement season. I have focused on open-source distributed systems work.',
    'PENDING',
    null, null, null,
    '2026-09-24 16:45:00'
  );

  // Request 3: Declined
  const targetAlum2 = alumniIds[2] || rohanId;
  insertReq.run(
    'req_3', 'iitb', ishitaId, targetAlum2,
    'Mock Interview',
    'Hi, would you be available for a 45-minute technical system design mock interview sometime this month before placements start?',
    'DECLINED',
    'Apologies Ishita, currently traveling on tight release deliverables and unable to take mock sessions.',
    null,
    '2026-09-22 11:20:00',
    '2026-09-21 09:00:00'
  );

  // 7. Seed Saved Alumni
  const insertSaved = db.prepare(`
    INSERT INTO saved_alumni (id, user_id, alumni_profile_id)
    VALUES (?, ?, ?)
  `);
  insertSaved.run('sa_1', ishitaId, rohanProfileId);

  console.log(`Database seeded successfully!`);
  console.log(`- Institutions: ${INSTITUTIONS.length}`);
  console.log(`- Total Users: ${1 + 1 + 1 + 1 + alumCount + pendingCandidates.length}`);
  console.log(`- Verified Alumni: ${alumniIds.length}`);
  console.log(`- Pending Verification Queue: ${pendingCandidates.length}`);
  console.log(`- Roster Records: ${sampleRoster.length}`);
  console.log(`- Seed Mentorship Handshakes: 3 (1 Accepted, 1 Pending, 1 Declined)`);
}

// Auto-run if executed directly
runSeed();
