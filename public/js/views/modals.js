import { icon, esc, inr } from '../icons.js';
import { api } from '../api.js';
import { closeModal, openModal, toast, refreshSession, refresh } from '../state.js';

export function renderModal(modal) {
  if (!modal) return '';
  const { type, data } = modal;
  switch (type) {
    case 'request_mentorship': return renderRequestModal(data);
    case 'accept_mentorship': return renderAcceptModal(data);
    case 'review_verification': return renderReviewModal(data);
    case 'roster_import': return renderRosterImportModal(data);
    case 'conversation': return renderConversationModal(data);
    case 'inst_checkout': return renderInstCheckoutModal(data);
    case 'edit_member': return renderEditMemberModal(data);
    case 'program_detail': return renderProgramModal(data);
    case 'feedback': return renderFeedbackModal();
    case 'feedback_edit': return renderFeedbackEditModal(data);
    case 'checkout': return renderCheckoutModal(data);
    case 'apply_internship': return renderApplyModal(data);
    case 'post_internship': return renderPostInternshipModal();
    default: return '';
  }
}

function renderShell(title, bodyHtml, footHtml) {
  return `
    <div class="scrim" onclick="if(event.target === this) window._closeModal()">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head row between">
          <h3>${esc(title)}</h3>
          <button class="btn btn-ghost btn-sm" onclick="window._closeModal()" aria-label="Close">${icon('x', 18)}</button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
      </div>
    </div>
  `;
}

window._closeModal = () => closeModal();

// Disable a button while an async action runs.
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { await fn(); } finally { if (btn && document.body.contains(btn)) btn.disabled = false; }
}

// ---------- Mentorship request (students & premium visiting students) ----------
let reqData = null;
window._submitMentorshipRequest = (btn) => busy(btn, async () => {
  const topic = document.getElementById('req-topic').value;
  const msg = document.getElementById('req-msg').value.trim();
  const errEl = document.getElementById('req-err');
  if (!topic) { errEl.textContent = 'Please select a topic.'; return; }
  if (msg.length < 30) {
    errEl.textContent = `Please write at least 30 characters (currently ${msg.length}). Specific questions receive much higher response rates.`;
    return;
  }
  try {
    await api.learner.sendRequest(reqData.alumni_id, topic, msg);
    closeModal();
    toast('Mentorship request sent!', 'good');
    location.hash = reqData.is_external ? '#/external-home' : '#/student-home';
  } catch (err) {
    errEl.innerHTML = esc(err.message) + (err.code === 'PREMIUM_REQUIRED' ? ' <a href="#/premium" onclick="window._closeModal()">See Premium plans</a>' : '');
  }
});

function renderRequestModal(data) {
  reqData = data;
  const topics = data.topics && data.topics.length ? data.topics : ['Resume Review', 'Career Guidance', 'Mock Interview'];
  const body = `
    <div style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border)">
      <div style="font-weight:700;font-size:1.05rem">${esc(data.name)}</div>
      <div class="small muted">${esc(data.role)} at <b>${esc(data.company)}</b></div>
    </div>
    <div>
      <label class="label" for="req-topic">What do you want guidance on?</label>
      <select class="select" id="req-topic" data-autofocus>
        ${topics.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>
    </div>
    <div style="margin-top:14px">
      <label class="label" for="req-msg">Your message</label>
      <textarea class="input" id="req-msg" rows="5" maxlength="2000" placeholder="Share your background, the decision you are weighing, and what you would like their advice on."></textarea>
      <p class="tiny dim" style="margin-top:6px">${icon('shield', 12)} Your name and ${data.is_external ? 'current school/college' : 'college'} are shared. Contact details are exchanged only after the alumnus accepts.</p>
      <p class="tiny" id="req-err" role="alert" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
    </div>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-violet" onclick="window._submitMentorshipRequest(this)">${icon('spark', 15)} Send request</button>
  `;
  return renderShell(`Request mentorship from ${data.name.split(' ')[0]}`, body, foot);
}

// ---------- Alumnus accepts a request ----------
let acceptData = null;
window._submitAccept = (btn) => busy(btn, async () => {
  const meetingInfo = document.getElementById('acc-meeting').value.trim();
  const note = document.getElementById('acc-note').value.trim();
  const errEl = document.getElementById('acc-err');
  if (!meetingInfo) { errEl.textContent = 'Please provide a meeting link or contact details.'; return; }
  try {
    await api.alumni.respondRequest(acceptData.request_id, 'ACCEPTED', note, meetingInfo);
    closeModal();
    toast('Request accepted and details shared', 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderAcceptModal(data) {
  acceptData = data;
  const body = `
    <p class="small muted" style="margin-bottom:14px">Accepting opens a channel with <b>${esc(data.student_name)}</b>. Share how they can reach you.</p>
    <div>
      <label class="label" for="acc-meeting">Meeting link or contact details (required)</label>
      <input class="input" id="acc-meeting" data-autofocus placeholder="e.g. Google Meet: meet.google.com/abc-defg or email@company.com">
      <p class="tiny dim" style="margin-top:4px">This is shown only to this student.</p>
    </div>
    <div style="margin-top:14px">
      <label class="label" for="acc-note">Note to student (optional)</label>
      <input class="input" id="acc-note" placeholder="e.g. Looking forward to it! Thursday works for me.">
    </div>
    <p class="tiny" id="acc-err" role="alert" style="color:var(--bad);margin-top:8px;font-weight:600"></p>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._submitAccept(this)">${icon('check', 15)} Accept & share details</button>
  `;
  return renderShell('Accept mentorship request', body, foot);
}

// ---------- Admin reviews an alumnus or student ----------
let reviewUser = null;
window._decideVerification = (btn, decision) => busy(btn, async () => {
  const reason = (document.getElementById('rev-reason')?.value || '').trim();
  const errEl = document.getElementById('rev-err');
  if (decision === 'REJECTED' && reason.length < 5) {
    errEl.textContent = 'A specific rejection reason is required (at least 5 characters).';
    return;
  }
  try {
    await api.admin.decideVerification(reviewUser.id, decision, reason);
    closeModal();
    toast(decision === 'VERIFIED' ? 'Verified successfully' : 'Verification rejected', decision === 'VERIFIED' ? 'good' : 'default');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderReviewModal(user) {
  reviewUser = user;
  const isStudent = user.role === 'STUDENT';
  const rows = isStudent
    ? [['Account type', 'Current student'], ['Roll number', user.roll_number], ['Expected graduation', user.graduation_year], ['Degree & branch', `${user.degree} (${user.branch})`]]
    : [['Account type', 'Alumnus'], ['Graduation batch', user.graduation_year], ['Degree & branch', `${user.degree} (${user.branch || '—'})`], ['Current employer', user.current_company], ['Current role', user.current_role]];
  const body = `
    <div style="margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">
      <div style="font-weight:700;font-size:1.05rem">${esc(user.full_name)}</div>
      <div class="small muted">${esc(user.email)}</div>
    </div>
    <div class="card card-pad" style="background:var(--surface-2);margin-bottom:16px">
      <div class="stack g8 small">
        ${rows.map(([k, v]) => `<div class="row between g12"><span class="dim">${esc(k)}</span><b>${esc(v ?? '—')}</b></div>`).join('')}
      </div>
    </div>
    <div>
      <label class="label" for="rev-reason">Rejection reason (required if rejecting)</label>
      <input class="input" id="rev-reason" placeholder="${isStudent ? 'e.g. Roll number not found in current enrolment list' : 'e.g. Not found in the 2019 graduating batch'}">
      <p class="tiny dim" style="margin-top:6px">${isStudent
        ? 'Approving lets this student request free mentorship and apply to internships from your alumni.'
        : 'Approving publishes this profile in the directory with your college’s verified badge.'}</p>
      <p class="tiny" id="rev-err" role="alert" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
    </div>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn" onclick="window._decideVerification(this, 'REJECTED')" style="color:var(--bad);border-color:var(--bad-line)">Reject</button>
    <button class="btn btn-primary" onclick="window._decideVerification(this, 'VERIFIED')">${icon('shield', 15)} Approve & verify</button>
  `;
  return renderShell(isStudent ? 'Review student account' : 'Review alumni claim', body, foot);
}

// ---------- Admin roster import ----------
window._submitRosterUpload = (btn) => busy(btn, async () => {
  const text = document.getElementById('roster-csv').value.trim();
  const type = document.getElementById('roster-type').value;
  const errEl = document.getElementById('roster-err');
  if (!text) { errEl.textContent = 'Please paste CSV content or choose a file.'; return; }
  try {
    const res = await api.admin.uploadRosterCsv(text, type);
    closeModal();
    toast(`Imported ${res.imported_count} ${type === 'STUDENT' ? 'student' : 'alumni'} records (${res.skipped_duplicates} duplicates skipped${res.errors.length ? `, ${res.errors.length} invalid rows` : ''})`, 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

window._rosterFile = (input) => {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { document.getElementById('roster-err').textContent = 'File is larger than 5 MB.'; return; }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById('roster-csv').value = String(reader.result || ''); };
  reader.readAsText(file);
};

function renderRosterImportModal(data = {}) {
  const type = data.record_type === 'STUDENT' ? 'STUDENT' : 'ALUMNI';
  const sampleCsv = `name,email,batch,degree,branch
Aakash Gupta,aakash.g@alumni.westbridge.example,2023,B.Tech,CSE
Pooja Krishnan,pooja.k@alumni.westbridge.example,2022,M.Tech,EE
"Sen, Siddharth",siddharth.s@alumni.westbridge.example,2021,B.Tech,Mechanical`;
  const body = `
    <p class="small muted" style="margin-bottom:12px">Members who sign up with an email on your roster are <b>verified automatically</b>. Roster records stay private to your institution.</p>
    <div style="margin-bottom:10px">
      <label class="label" for="roster-type">Roster type</label>
      <select class="select" id="roster-type">
        <option value="ALUMNI" ${type === 'ALUMNI' ? 'selected' : ''}>Graduates / alumni</option>
        <option value="STUDENT" ${type === 'STUDENT' ? 'selected' : ''}>Current students</option>
      </select>
    </div>
    <div style="margin-bottom:10px"><label class="label" for="roster-file">Upload a .csv file</label><input class="input" id="roster-file" type="file" accept=".csv,text/csv" onchange="window._rosterFile(this)"></div>
    <label class="label" for="roster-csv">…or paste CSV content (with header row)</label>
    <textarea class="input" id="roster-csv" rows="7" style="font-family:var(--mono);font-size:0.82rem">${esc(sampleCsv)}</textarea>
    <p class="tiny dim" style="margin-top:6px">Columns: name, email, batch (graduation year), degree / class, branch / stream. Quoted values are supported.</p>
    <p class="tiny" id="roster-err" role="alert" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._submitRosterUpload(this)">${icon('doc', 15)} Import roster</button>
  `;
  return renderShell('Import graduate roster', body, foot);
}

// ---------- Private mentorship conversation ----------
let convData = null;
window._sendMessage = (btn) => busy(btn, async () => {
  const input = document.getElementById('conv-input');
  const body = input.value.trim();
  if (!body) return;
  try {
    await api.community.send(convData.conversation.id, body);
    openModal('conversation', await api.community.messages(convData.conversation.id));
  } catch (err) {
    document.getElementById('conv-err').textContent = err.message;
  }
});

function renderConversationModal(data) {
  convData = data;
  const c = data.conversation;
  const other = (id) => (id === c.student_id ? c.student_name : c.alumni_name);
  const body = `
    <p class="tiny dim" style="margin-bottom:10px">${icon('lock', 11)} Private between ${esc(c.student_name)} and ${esc(c.alumni_name)}. Not visible to your institution or the platform team.</p>
    <div class="thread" id="conv-thread">
      ${data.messages.map(m => `
        <div class="msg ${m.sender_id === c.alumni_id ? 'msg-a' : 'msg-s'}">
          <div class="tiny dim">${esc(other(m.sender_id))} · ${new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</div>
          <div class="small" style="white-space:pre-wrap">${esc(m.body)}</div>
        </div>
      `).join('') || '<p class="small muted" style="text-align:center;padding:16px">No messages yet. Say hello and agree a time.</p>'}
    </div>
    ${data.can_send ? `
      <textarea class="input" id="conv-input" rows="2" maxlength="2000" placeholder="Write a message…" style="margin-top:10px" data-autofocus></textarea>
      <p class="tiny" id="conv-err" role="alert" style="color:var(--bad)"></p>
    ` : '<p class="tiny dim" style="margin-top:10px">Messages open once the request is accepted.</p>'}
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Close</button>
    ${data.can_send ? `<button class="btn btn-primary" onclick="window._sendMessage(this)">${icon('arrow', 14)} Send</button>` : ''}
  `;
  setTimeout(() => { const t = document.getElementById('conv-thread'); if (t) t.scrollTop = t.scrollHeight; }, 0);
  return renderShell(`${c.topic}: ${c.student_name} & ${c.alumni_name}`, body, foot);
}

// ---------- Institution plan checkout (demo) ----------
let instCheckout = null;
window._confirmInstCheckout = (btn) => busy(btn, async () => {
  const errEl = document.getElementById('ico-err');
  try {
    const r = await api.billing.checkout(instCheckout.plan_id, instCheckout.cycle);
    await refreshSession();
    closeModal();
    toast(`Payment of ${inr(r.amount_inr)} recorded. Your plan is active.`, 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderInstCheckoutModal(data) {
  instCheckout = data;
  const body = `
    <p class="small">You are subscribing to <b>${esc(data.plan_id.charAt(0).toUpperCase() + data.plan_id.slice(1))}</b>, billed <b>${data.cycle === 'ANNUAL' ? 'annually' : 'monthly'}</b>. The new billing period starts today.</p>
    <div class="notice notice-warn" style="margin-top:14px;margin-bottom:0">
      ${icon('shield', 14)} <span><b>Demo payment.</b> No payment gateway is connected in this build. No card details are collected and nothing is charged. An invoice with a DEMO reference is recorded.</span>
    </div>
    <p class="tiny" id="ico-err" role="alert" style="color:var(--bad);margin-top:8px;font-weight:600"></p>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" data-autofocus onclick="window._confirmInstCheckout(this)">${icon('check', 15)} Confirm demo payment</button>
  `;
  return renderShell('Confirm subscription', body, foot);
}

// ---------- Admin edits a member record ----------
let editMember = null;
window._saveMemberEdit = (btn) => busy(btn, async () => {
  const f = document.getElementById('em-form');
  const errEl = document.getElementById('em-err');
  try {
    await api.admin.updateMember(editMember.id, Object.fromEntries(new FormData(f).entries()));
    closeModal();
    toast('Record updated', 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderEditMemberModal(m) {
  editMember = m;
  const student = m.role === 'STUDENT';
  const body = `
    <form id="em-form" class="stack g10" onsubmit="event.preventDefault()">
      <div><label class="label" for="em-name">Full name</label><input class="input" id="em-name" name="full_name" value="${esc(m.full_name)}" data-autofocus></div>
      <div class="row g10 wrap">
        <div class="grow"><label class="label" for="em-year">${student ? 'Expected graduation' : 'Graduation year'}</label><input class="input" id="em-year" name="graduation_year" type="number" value="${esc(m.graduation_year)}"></div>
        <div class="grow"><label class="label" for="em-deg">Programme / class</label><input class="input" id="em-deg" name="degree" value="${esc(m.degree)}"></div>
      </div>
      <div class="row g10 wrap">
        <div class="grow"><label class="label" for="em-br">Branch / stream</label><input class="input" id="em-br" name="branch" value="${esc(m.branch)}"></div>
        ${student ? `<div class="grow"><label class="label" for="em-roll">Roll number</label><input class="input" id="em-roll" name="roll_number" value="${esc(m.roll_number || '')}"></div>` : ''}
      </div>
      <p class="tiny dim">${esc(m.email)} · changes are recorded in your audit log.</p>
      <p class="tiny" id="em-err" role="alert" style="color:var(--bad);font-weight:600"></p>
    </form>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._saveMemberEdit(this)">Save record</button>
  `;
  return renderShell(`Edit ${student ? 'student' : 'alumni'} record`, body, foot);
}

// ---------- Program participants ----------
function renderProgramModal({ program, participants }) {
  const mentors = participants.filter(p => p.role === 'MENTOR');
  const mentees = participants.filter(p => p.role === 'MENTEE');
  const body = `
    <p class="small muted" style="margin-bottom:12px">${esc(program.description)}</p>
    <h4>Mentors (${mentors.length})</h4>
    <div class="stack g4" style="margin:6px 0 14px">${mentors.map(p => `<div class="small">${esc(p.full_name)} <span class="tiny dim">${esc(p.detail || '')}</span></div>`).join('') || '<p class="tiny dim">None yet</p>'}</div>
    <h4>Mentees (${mentees.length})</h4>
    <div class="stack g4" style="margin-top:6px">${mentees.map(p => `
      <div class="row between small"><span>${esc(p.full_name)} <span class="tiny dim">${esc(p.detail || '')}</span></span>
        ${p.matched_name ? `<span class="badge badge-good">${esc(p.matched_name)}</span>` : '<span class="badge badge-warn">Unmatched</span>'}</div>
    `).join('') || '<p class="tiny dim">None yet</p>'}</div>
  `;
  return renderShell(program.title, body, '<button class="btn" onclick="window._closeModal()">Close</button>');
}

// ---------- Send product feedback ----------
const FEEDBACK_TYPES = [
  ['Bug', 'Something is broken'],
  ['Feature', 'I need something new'],
  ['Usability', 'Something is confusing or slow to do'],
  ['Data or integration', 'Importing, exporting or connecting other tools'],
  ['Pricing or business', 'Plans, pricing or how we buy']
];

window._sendFeedback = (btn) => busy(btn, async () => {
  const type = document.querySelector('input[name="fb-type"]:checked')?.value;
  const message = document.getElementById('fb-msg').value.trim();
  const errEl = document.getElementById('fb-err');
  if (!type) { errEl.textContent = 'Please choose what kind of feedback this is.'; return; }
  if (message.length < 5) { errEl.textContent = 'Please tell us a little more.'; return; }
  try {
    await api.feedback.send(type, message);
    closeModal();
    toast('Thank you! The team reads every message. See replies under Account & Privacy.', 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderFeedbackModal() {
  const body = `
    <p class="small muted" style="margin-bottom:12px">Tell the AlumVerse team what to fix or build next. Write it the way you would say it.</p>
    <div class="stack g6" role="radiogroup" aria-label="Type of feedback">
      ${FEEDBACK_TYPES.map(([v, hint], i) => `
        <label class="radio-card" style="padding:8px 12px">
          <input type="radio" name="fb-type" value="${esc(v)}" ${i === 0 ? 'data-autofocus' : ''}>
          <span class="small"><b>${esc(v)}</b> <span class="muted">· ${esc(hint)}</span></span>
        </label>
      `).join('')}
    </div>
    <label class="label" for="fb-msg" style="margin-top:12px">Your feedback</label>
    <textarea class="input" id="fb-msg" rows="4" maxlength="2000" placeholder="e.g. Our alumni office needs to export event attendance for the annual report."></textarea>
    <p class="tiny dim" style="margin-top:6px">${icon('shield', 11)} Your name, role and institution are sent with your feedback so the team can follow up.</p>
    <p class="tiny" id="fb-err" role="alert" style="color:var(--bad);font-weight:600"></p>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._sendFeedback(this)">${icon('arrow', 14)} Send feedback</button>
  `;
  return renderShell('Send feedback', body, foot);
}

// ---------- Platform team: record a decision on feedback ----------
let fbEdit = null;
window._saveFeedbackDecision = (btn) => busy(btn, async () => {
  const f = document.getElementById('fbe-form');
  const errEl = document.getElementById('fbe-err');
  const d = Object.fromEntries(new FormData(f).entries());
  try {
    await api.platform.updateFeedback(fbEdit.id, d);
    closeModal();
    toast('Feedback log updated', 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderFeedbackEditModal(fb) {
  fbEdit = fb;
  const opt = (list, cur) => list.map(v => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const body = `
    <div class="card card-pad" style="background:var(--surface-2);margin-bottom:12px">
      <div class="tiny dim">${esc(fb.received_on)} · ${esc(fb.partner || '')} · ${esc(fb.person)}${fb.person_role ? ` (${esc(fb.person_role)})` : ''} · ${esc(fb.channel || '')}</div>
      <p class="small" style="margin-top:4px;color:var(--ink)">“${esc(fb.what_they_said)}”</p>
    </div>
    <form id="fbe-form" class="stack g10" onsubmit="event.preventDefault()">
      <div class="row g10 wrap">
        <div class="grow"><label class="label" for="fbe-type">Type</label><select class="select" id="fbe-type" name="type">${opt(['Bug', 'Feature', 'Usability', 'Data or integration', 'Pricing or business'], fb.type)}</select></div>
        <div class="grow"><label class="label" for="fbe-dec">Decision</label><select class="select" id="fbe-dec" name="decision" data-autofocus>${opt(['New', 'Shipped', 'In progress', 'Planned', "Won't do"], fb.decision)}</select></div>
      </div>
      <div><label class="label" for="fbe-reason">Reason (required for “Won't do”)</label><input class="input" id="fbe-reason" name="decision_reason" value="${esc(fb.decision_reason || '')}" placeholder="e.g. Only one partner asked; revisit if others do"></div>
      <div class="row g10 wrap">
        <div style="width:170px"><label class="label" for="fbe-ship">Shipped on</label><input class="input" id="fbe-ship" name="shipped_on" type="date" value="${esc(fb.shipped_on || '')}"></div>
        <div class="grow"><label class="label" for="fbe-ev">Evidence (commit, PR or screenshot link)</label><input class="input" id="fbe-ev" name="evidence" value="${esc(fb.evidence || '')}"></div>
      </div>
      <div><label class="label" for="fbe-react">Partner's reaction</label><input class="input" id="fbe-react" name="partner_reaction" value="${esc(fb.partner_reaction || '')}" placeholder="What they said after it shipped"></div>
      <p class="tiny" id="fbe-err" role="alert" style="color:var(--bad);font-weight:600"></p>
    </form>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._saveFeedbackDecision(this)">Save</button>
  `;
  return renderShell('Feedback decision', body, foot);
}

// ---------- Premium checkout (demo) ----------
let checkoutPlan = null;
window._confirmCheckout = (btn) => busy(btn, async () => {
  const errEl = document.getElementById('co-err');
  try {
    await api.subscriptions.checkout(checkoutPlan.id);
    await refreshSession();
    closeModal();
    toast('Welcome to Premium! Mentorship and internships are unlocked.', 'good');
    refresh();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderCheckoutModal({ plan }) {
  checkoutPlan = plan;
  const body = `
    <div class="card card-pad" style="background:var(--violet-soft);border-color:var(--violet-line)">
      <div class="row between">
        <div><div style="font-weight:700">${esc(plan.name)}</div><div class="tiny" style="color:var(--violet-ink)">${plan.days} days of Premium access</div></div>
        <div class="stat-val num" style="color:var(--violet-ink)">${inr(plan.price_inr)}</div>
      </div>
    </div>
    <div class="notice notice-warn" style="margin-top:14px;margin-bottom:0">
      ${icon('shield', 14)} <span><b>Demo payment.</b> This build does not connect to a payment gateway. No card details are collected and nothing is charged. Confirming activates the plan immediately.</span>
    </div>
    <p class="tiny" id="co-err" role="alert" style="color:var(--bad);margin-top:8px;font-weight:600"></p>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-violet" data-autofocus onclick="window._confirmCheckout(this)">${icon('star', 15)} Confirm demo payment</button>
  `;
  return renderShell('Upgrade to Premium', body, foot);
}

// ---------- Apply to internship ----------
let applyData = null;
window._submitApply = (btn) => busy(btn, async () => {
  const note = document.getElementById('apply-note').value.trim();
  const errEl = document.getElementById('apply-err');
  if (note.length < 20) { errEl.textContent = 'Please write at least 20 characters about why you are a good fit.'; return; }
  try {
    await api.internships.apply(applyData.id, note);
    closeModal();
    toast('Application sent', 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderApplyModal(data) {
  applyData = data;
  const body = `
    <div style="margin-bottom:14px">
      <div style="font-weight:700">${esc(data.title)}</div>
      <div class="small muted">${esc(data.company)}</div>
    </div>
    <label class="label" for="apply-note">Why are you a good fit?</label>
    <textarea class="input" id="apply-note" rows="5" maxlength="2000" data-autofocus placeholder="Relevant projects, skills, and what you hope to learn."></textarea>
    <p class="tiny dim" style="margin-top:6px">${icon('shield', 12)} Your name, email and this note are shared with the alumnus who posted the internship.</p>
    <p class="tiny" id="apply-err" role="alert" style="color:var(--bad);margin-top:6px;font-weight:600"></p>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._submitApply(this)">Send application</button>
  `;
  return renderShell('Apply for internship', body, foot);
}

// ---------- Alumni post internship ----------
window._submitPostInternship = (btn) => busy(btn, async () => {
  const f = document.getElementById('post-form');
  const errEl = document.getElementById('post-err');
  if (!f.reportValidity()) return;
  const d = Object.fromEntries(new FormData(f).entries());
  d.skills = (d.skills || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    await api.internships.create(d);
    closeModal();
    toast('Internship posted', 'good');
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function renderPostInternshipModal() {
  const body = `
    <form id="post-form" class="stack g12" onsubmit="event.preventDefault()">
      <div><label class="label" for="pi-title">Title</label><input class="input" id="pi-title" name="title" required maxlength="100" data-autofocus placeholder="e.g. Backend Engineering Intern"></div>
      <div class="row g10 wrap">
        <div class="grow" style="min-width:160px"><label class="label" for="pi-company">Company</label><input class="input" id="pi-company" name="company" required maxlength="80"></div>
        <div class="grow" style="min-width:160px"><label class="label" for="pi-location">Location</label><input class="input" id="pi-location" name="location" required maxlength="60"></div>
      </div>
      <div class="row g10 wrap">
        <div class="grow" style="min-width:120px"><label class="label" for="pi-mode">Mode</label>
          <select class="select" id="pi-mode" name="mode"><option value="HYBRID">Hybrid</option><option value="ONSITE">On-site</option><option value="REMOTE">Remote</option></select></div>
        <div class="grow" style="min-width:120px"><label class="label" for="pi-stipend">Stipend (₹/month)</label><input class="input" id="pi-stipend" name="stipend_inr_month" type="number" min="0"></div>
        <div class="grow" style="min-width:120px"><label class="label" for="pi-weeks">Duration (weeks)</label><input class="input" id="pi-weeks" name="duration_weeks" type="number" min="1" max="104"></div>
      </div>
      <div><label class="label" for="pi-desc">Description</label><textarea class="input" id="pi-desc" name="description" rows="4" required minlength="30" maxlength="3000"></textarea></div>
      <div class="row g10 wrap">
        <div class="grow" style="min-width:160px"><label class="label" for="pi-skills">Skills (comma separated)</label><input class="input" id="pi-skills" name="skills"></div>
        <div class="grow" style="min-width:160px"><label class="label" for="pi-deadline">Apply by</label><input class="input" id="pi-deadline" name="deadline" type="date"></div>
      </div>
      <div><label class="label" for="pi-aud">Who can see and apply?</label>
        <select class="select" id="pi-aud" name="audience">
          <option value="OWN_COLLEGE">Only current students of my college</option>
          <option value="ALL">All students, including Premium students from other colleges</option>
        </select></div>
      <p class="tiny" id="post-err" role="alert" style="color:var(--bad);font-weight:600"></p>
    </form>
  `;
  const foot = `
    <button class="btn" onclick="window._closeModal()">Cancel</button>
    <button class="btn btn-primary" onclick="window._submitPostInternship(this)">${icon('brief', 15)} Post internship</button>
  `;
  return renderShell('Post an internship', body, foot);
}
