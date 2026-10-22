import { icon, esc } from '../icons.js';
import { api, setToken } from '../api.js';
import { openModal, closeModal, toast, state } from '../state.js';

export function renderModal(modal) {
  if (!modal) return '';
  const { type, data } = modal;

  if (type === 'request_mentorship') {
    return renderRequestModal(data);
  }
  if (type === 'accept_mentorship') {
    return renderAcceptModal(data);
  }
  if (type === 'review_verification') {
    return renderReviewModal(data);
  }
  if (type === 'roster_import') {
    return renderRosterImportModal();
  }
  if (type === 'auth') {
    return renderAuthModal();
  }
  return '';
}

function renderShell(title, bodyHtml, footHtml) {
  return `
    <div class="scrim" onclick="if(event.target === this) window._closeModal()">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head row between">
          <h3>${esc(title)}</h3>
          <span style="cursor:pointer;color:var(--ink-3)" onclick="window._closeModal()">${icon('x', 18)}</span>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        <div class="modal-foot">${footHtml}</div>
      </div>
    </div>
  `;
}

window._closeModal = () => closeModal();

function renderRequestModal(data) {
  window._submitMentorshipRequest = async () => {
    const topic = document.getElementById('req-topic').value;
    const msg = document.getElementById('req-msg').value.trim();
    const errEl = document.getElementById('req-err');

    if (!topic) {
      errEl.textContent = 'Please select a topic.';
      return;
    }
    if (msg.length < 30) {
      errEl.textContent = `Please write at least 30 characters (currently ${msg.length}). Specific questions receive much higher response rates.`;
      return;
    }

    try {
      await api.student.sendRequest(data.alumni_id, topic, msg);
      closeModal();
      toast('Mentorship request sent successfully!', 'good');
      if (location.hash === '#/student-home') {
        window.dispatchEvent(new Event('hashchange'));
      } else {
        location.hash = '#/student-home';
      }
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const topics = data.topics && data.topics.length ? data.topics : ['Resume Review', 'Career Guidance', 'Mock Interview'];

  const body = `
    <div class="row g12" style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:700;font-size:1.05rem">${esc(data.name)}</div>
        <div class="small muted">${esc(data.role)} at <b>${esc(data.company)}</b></div>
      </div>
    </div>

    <div>
      <label class="label">What guidance topic do you want to focus on?</label>
      <select class="select" id="req-topic">
        ${topics.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>
    </div>

    <div style="margin-top:14px">
      <label class="label">Your Structured Inquiry Message</label>
      <textarea class="input" id="req-msg" rows="5" placeholder="Be specific about your background, what decisions you are weighing, and what feedback you need from their experience."></textarea>
      <p class="tiny dim" style="margin-top:6px">
        ${icon('shield', 12)} Your name and institution are shared. Your personal email and phone number are hidden until the mentor accepts.
      </p>
      <p class="tiny" id="req-err" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
    </div>
  `;

  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-violet" onclick="window._submitMentorshipRequest()">
      ${icon('spark', 15)} Submit Request
    </button>
  `;

  return renderShell(`Request Mentorship from ${data.name.split(' ')[0]}`, body, foot);
}

function renderAcceptModal(data) {
  window._submitAccept = async () => {
    const meetingInfo = document.getElementById('acc-meeting').value.trim();
    const note = document.getElementById('acc-note').value.trim();
    const errEl = document.getElementById('acc-err');

    if (!meetingInfo) {
      errEl.textContent = 'Please provide meeting link or contact details.';
      return;
    }

    try {
      await api.alumni.respondRequest(data.request_id, 'ACCEPTED', note, meetingInfo);
      closeModal();
      toast('Request accepted and meeting details shared!', 'good');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const body = `
    <p class="small muted" style="margin-bottom:14px">
      Accepting opens a channel with <b>${esc(data.student_name)}</b>. Provide meeting link or coordination details below:
    </p>

    <div>
      <label class="label">Meeting Link or Contact Details (Required)</label>
      <input class="input" id="acc-meeting" placeholder="e.g. Google Meet: meet.google.com/abc-defg or email@company.com">
      <p class="tiny dim" style="margin-top:4px">This will be unlocked and displayed to the student.</p>
    </div>

    <div style="margin-top:14px">
      <label class="label">Note to Student (Optional)</label>
      <input class="input" id="acc-note" placeholder="e.g. Looking forward to connecting! Let's talk this Thursday.">
    </div>

    <p class="tiny" id="acc-err" style="color:var(--bad);margin-top:8px;font-weight:600"></p>
  `;

  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._submitAccept()">
      ${icon('check', 15)} Accept & Reveal Details
    </button>
  `;

  return renderShell(`Accept Mentorship Request`, body, foot);
}

function renderReviewModal(user) {
  window._decideVerification = async (decision) => {
    const reasonInput = document.getElementById('rev-reason');
    const reason = reasonInput ? reasonInput.value.trim() : '';
    const errEl = document.getElementById('rev-err');

    if (decision === 'REJECTED' && (!reason || reason.length < 5)) {
      errEl.textContent = 'A specific rejection reason is required (at least 5 characters).';
      return;
    }

    try {
      await api.admin.decideVerification(user.id, decision, reason);
      closeModal();
      toast(decision === 'VERIFIED' ? 'Alumnus verified and published!' : 'Verification rejected', decision === 'VERIFIED' ? 'good' : 'default');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const body = `
    <div class="row g12" style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-weight:700;font-size:1.05rem">${esc(user.full_name)}</div>
        <div class="small muted">${esc(user.email)}</div>
      </div>
    </div>

    <div class="card card-pad" style="background:var(--surface-2);margin-bottom:16px">
      <div class="stack g8 small">
        <div class="row between"><span class="dim">Graduation Batch:</span> <b class="num">${user.graduation_year}</b></div>
        <div class="row between"><span class="dim">Degree & Branch:</span> <b>${esc(user.degree)} (${esc(user.branch || 'Engineering')})</b></div>
        <div class="row between"><span class="dim">Current Employer:</span> <b>${esc(user.current_company)}</b></div>
        <div class="row between"><span class="dim">Current Role:</span> <b>${esc(user.current_role)}</b></div>
      </div>
    </div>

    <div>
      <label class="label">Rejection Reason (Required if Rejecting)</label>
      <input class="input" id="rev-reason" placeholder="e.g. Enrolment record not found in 2019 batch list">
      <p class="tiny dim" style="margin-top:6px">
        Approving immediately publishes this profile to public directories with the institution's verified badge.
      </p>
      <p class="tiny" id="rev-err" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
    </div>
  `;

  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn" onclick="window._decideVerification('REJECTED')" style="color:var(--bad);border-color:var(--bad-line)">
      Reject Claim
    </button>
    <button class="btn btn-primary" onclick="window._decideVerification('VERIFIED')">
      ${icon('shield', 15)} Approve & Verify
    </button>
  `;

  return renderShell('Review Alumni Verification Record', body, foot);
}

function renderRosterImportModal() {
  window._submitRosterUpload = async () => {
    const text = document.getElementById('roster-csv').value.trim();
    const errEl = document.getElementById('roster-err');

    if (!text) {
      errEl.textContent = 'Please enter or paste CSV content.';
      return;
    }

    try {
      const res = await api.admin.uploadRosterCsv(text);
      closeModal();
      toast(`Imported ${res.imported_count} records (${res.skipped_duplicates} duplicate skipped)`, 'good');
      window.dispatchEvent(new Event('hashchange'));
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const sampleCsv = `name,email,batch,degree,branch
Aakash Gupta,aakash.g@alumni.iitb.ac.in,2023,B.Tech,CSE
Pooja Krishnan,pooja.k@alumni.iitb.ac.in,2022,M.Tech,EE
Siddharth Sen,siddharth.s@alumni.iitb.ac.in,2021,B.Tech,Mechanical`;

  const body = `
    <p class="small muted" style="margin-bottom:12px">
      Batch import verified graduating rosters. When an alumnus registers with a matching email, their affiliation is <b>automatically verified</b>.
    </p>

    <div>
      <label class="label">Paste CSV Content (with header row)</label>
      <textarea class="input" id="roster-csv" rows="8" style="font-family:var(--mono);font-size:0.82rem">${sampleCsv}</textarea>
      <p class="tiny dim" style="margin-top:6px">Required columns: name, email, batch, degree, branch.</p>
      <p class="tiny" id="roster-err" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
    </div>
  `;

  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._submitRosterUpload()">
      ${icon('doc', 15)} Import Roster Records
    </button>
  `;

  return renderShell('Import CSV Alumni Roster', body, foot);
}

function renderAuthModal() {
  window._switchAuthTab = (t, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    openModal('auth', { activeTab: t });
    const mc = document.getElementById('modal-container');
    if (mc) {
      mc.innerHTML = renderModal(state.modal);
    }
  };

  window._submitLogin = async (e) => {
    e.preventDefault();
    const form = e.target;
    const errEl = document.getElementById('auth-err');
    try {
      const res = await api.auth.login(form.email.value.trim(), form.password.value);
      setToken(res.token);
      state.user = res.user;
      closeModal();
      toast(`Signed in as ${res.user.full_name}`, 'good');
      if (res.user.role === 'ADMIN') location.hash = '#/admin';
      else if (res.user.role === 'ALUMNI') location.hash = '#/alumni-home';
      else location.hash = '#/student-home';
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  window._submitRegister = async (e) => {
    e.preventDefault();
    const form = e.target;
    const errEl = document.getElementById('auth-err');
    try {
      const res = await api.auth.register({
        institution_id: form.institution_id.value,
        full_name: form.full_name.value.trim(),
        email: form.email.value.trim(),
        password: form.password.value,
        role: form.role.value,
        graduation_year: form.graduation_year.value,
        degree: form.degree.value,
        branch: form.branch.value,
        current_company: form.current_company ? form.current_company.value.trim() : '',
        current_role: form.current_role ? form.current_role.value.trim() : ''
      });
      setToken(res.token);
      state.user = res.user;
      closeModal();
      toast(`Account created! Status: ${res.user.verification_status}`, 'good');
      if (res.user.role === 'ALUMNI') location.hash = '#/alumni-home';
      else location.hash = '#/student-home';
    } catch (err) {
      errEl.textContent = err.message;
    }
  };

  const isReg = state.modal?.data?.activeTab === 'register';

  const body = `
    <div class="row g10" style="margin-bottom:18px;border-bottom:1px solid var(--border);padding-bottom:10px">
      <button type="button" class="btn btn-sm ${!isReg ? 'btn-primary' : 'btn-ghost'}" onclick="_switchAuthTab('login', event)">Sign In</button>
      <button type="button" class="btn btn-sm ${isReg ? 'btn-primary' : 'btn-ghost'}" onclick="_switchAuthTab('register', event)">Register New Account</button>
    </div>

    ${!isReg ? `
      <form onsubmit="_submitLogin(event)" class="stack g12">
        <div>
          <label class="label">Email Address</label>
          <input class="input" name="email" type="email" placeholder="e.g. rohan@example.com" required>
        </div>
        <div>
          <label class="label">Password</label>
          <input class="input" name="password" type="password" required>
        </div>
        <p class="tiny" id="auth-err" style="color:var(--bad);font-weight:600"></p>
        <button type="submit" class="btn btn-primary" style="margin-top:8px">Sign In</button>
      </form>
    ` : `
      <form onsubmit="_submitRegister(event)" class="stack g12">
        <div>
          <label class="label">Affiliated Institution</label>
          <select class="select" name="institution_id">
            <option value="iitb">Indian Institute of Technology Bombay</option>
            <option value="bits">BITS Pilani</option>
            <option value="srcc">Shri Ram College of Commerce</option>
          </select>
        </div>
        <div>
          <label class="label">Your Role</label>
          <select class="select" name="role" id="reg-role">
            <option value="STUDENT">Student (Currently Enrolled)</option>
            <option value="ALUMNI">Alumnus (Graduate)</option>
          </select>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:180px">
            <label class="label">Full Name</label>
            <input class="input" name="full_name" required>
          </div>
          <div class="grow" style="min-width:180px">
            <label class="label">Email Address</label>
            <input class="input" name="email" type="email" required>
          </div>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:120px">
            <label class="label">Batch / Year</label>
            <input class="input" name="graduation_year" type="number" value="2024" required>
          </div>
          <div class="grow" style="min-width:120px">
            <label class="label">Degree</label>
            <input class="input" name="degree" value="B.Tech" required>
          </div>
          <div class="grow" style="min-width:120px">
            <label class="label">Branch</label>
            <input class="input" name="branch" value="Computer Science" required>
          </div>
        </div>
        <div class="row g10 wrap">
          <div class="grow" style="min-width:180px">
            <label class="label">Current Employer / Company</label>
            <input class="input" name="current_company" placeholder="e.g. Google">
          </div>
          <div class="grow" style="min-width:180px">
            <label class="label">Job Title / Role</label>
            <input class="input" name="current_role" placeholder="e.g. Software Engineer">
          </div>
        </div>
        <div>
          <label class="label">Password</label>
          <input class="input" name="password" type="password" required>
        </div>
        <div class="proto-note" style="font-size:0.78rem;background:var(--brand-soft);border:1px solid var(--brand-line);color:var(--brand-ink);padding:8px 10px;border-radius:var(--r-sm)">
          ${icon('shield', 12)} If your email matches an imported roster record, your account is automatically verified. Otherwise, it enters the admin verification queue.
        </div>
        <p class="tiny" id="auth-err" style="color:var(--bad);font-weight:600"></p>
        <button type="submit" class="btn btn-primary" style="margin-top:6px">Create Account</button>
      </form>
    `}
  `;

  return renderShell('Account Access', body, '');
}
