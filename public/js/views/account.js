// Account & privacy: every user can edit their basics, change password, export and delete their data.
import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { state, toast, refreshSession, refresh, download, logout, ROLE_LABEL } from '../state.js';

window._saveMyProfile = async (e) => {
  e.preventDefault();
  try {
    await api.me.updateProfile(Object.fromEntries(new FormData(e.target).entries()));
    await refreshSession();
    toast('Profile saved', 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};

window._changePassword = async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = f.querySelector('.form-err');
  err.textContent = '';
  if (f.new_password.value !== f.confirm.value) { err.textContent = 'New passwords do not match.'; return; }
  try {
    await api.me.changePassword(f.current_password.value, f.new_password.value);
    toast('Password changed', 'good');
    f.reset();
  } catch (ex) { err.textContent = ex.message; }
};

window._exportMyData = async () => {
  try {
    download('my-alumni-connect-data.json', await api.me.exportData());
    toast('Your data has been downloaded', 'good');
  } catch (err) { toast(err.message, 'bad'); }
};

window._deleteMyAccount = async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!confirm('Permanently delete your account and personal data? This cannot be undone.')) return;
  try {
    await api.me.remove(f.password.value);
    toast('Your account has been deleted');
    logout();
  } catch (ex) { f.querySelector('.form-err').textContent = ex.message; }
};

function profileForm(institutions) {
  const u = state.user;
  const p = state.profile || {};
  if (u.role === 'STUDENT') {
    const locked = u.verification_status === 'VERIFIED';
    return `
      <form class="card card-pad stack g10" onsubmit="window._saveMyProfile(event)">
        <h3>My profile</h3>
        <div><label class="label" for="me-name">Full name</label><input class="input" id="me-name" name="full_name" value="${esc(u.full_name)}"></div>
        <div class="row g10 wrap">
          <div class="grow"><label class="label" for="me-deg">Programme</label><input class="input" id="me-deg" name="degree" value="${esc(p.degree || '')}" ${locked ? 'disabled' : ''}></div>
          <div class="grow"><label class="label" for="me-br">Branch / stream</label><input class="input" id="me-br" name="branch" value="${esc(p.branch || '')}" ${locked ? 'disabled' : ''}></div>
        </div>
        ${locked ? `<p class="tiny dim">${icon('lock', 11)} Academic details are part of ${esc(u.institution_short)}’s records. Ask your admin to correct them.</p>` : ''}
        <div class="row g10 wrap">
          <div class="grow"><label class="label" for="me-ind">Career interest</label><input class="input" id="me-ind" name="target_industry" value="${esc(p.target_industry || '')}"></div>
          <div class="grow"><label class="label" for="me-role">Target role</label><input class="input" id="me-role" name="target_role" value="${esc(p.target_role || '')}"></div>
        </div>
        <div><label class="label" for="me-bio">About me</label><textarea class="input" id="me-bio" name="bio" rows="3">${esc(p.bio || '')}</textarea></div>
        <div><button type="submit" class="btn btn-primary">Save profile</button></div>
      </form>
    `;
  }
  if (u.role === 'EXTERNAL') {
    return `
      <form class="card card-pad stack g10" onsubmit="window._saveMyProfile(event)">
        <h3>My profile</h3>
        <div><label class="label" for="me-name">Full name</label><input class="input" id="me-name" name="full_name" value="${esc(u.full_name)}"></div>
        <div><label class="label" for="me-ci">Current school or college</label><input class="input" id="me-ci" name="current_institution" value="${esc(p.current_institution || '')}"></div>
        <div class="row g10 wrap">
          <div class="grow"><label class="label" for="me-yr">Class / year</label><input class="input" id="me-yr" name="current_year" value="${esc(p.current_year || '')}"></div>
          <div class="grow"><label class="label" for="me-city">City</label><input class="input" id="me-city" name="city" value="${esc(p.city || '')}"></div>
        </div>
        <div><label class="label" for="me-foi">Field of interest</label><input class="input" id="me-foi" name="field_of_interest" value="${esc(p.field_of_interest || '')}"></div>
        <div><label class="label" for="me-int">College you are interested in</label>
          <select class="select" id="me-int" name="interested_institution_id">
            <option value="">Not sure yet</option>
            ${institutions.map(i => `<option value="${esc(i.id)}" ${p.interested_institution_id === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
          </select></div>
        <div><button type="submit" class="btn btn-primary">Save profile</button></div>
      </form>
    `;
  }
  if (u.role === 'ALUMNI') {
    return `<div class="card card-pad"><h3>My profile</h3><p class="small muted" style="margin-top:6px">Edit your career profile, visibility and mentorship settings on your <a href="#/alumni-home">alumni dashboard</a>.</p></div>`;
  }
  return '';
}

export async function renderAccount() {
  const u = state.user;
  let institutions = [];
  if (u.role === 'EXTERNAL') {
    try { institutions = (await api.institutions.list()).institutions; } catch { /* ignore */ }
  }
  const canDelete = !(u.role === 'ADMIN' && u.admin_level === 'OWNER') && u.role !== 'SUPERADMIN';
  let myFeedback = [];
  if (u.role !== 'SUPERADMIN') {
    try { myFeedback = (await api.feedback.mine()).feedback; } catch { /* ignore */ }
  }
  const tone = { Shipped: 'badge-good', 'In progress': 'badge-brand', Planned: 'badge-violet', "Won't do": 'badge', New: 'badge-warn' };
  const feedbackCard = u.role === 'SUPERADMIN' ? '' : `
    <div class="card card-pad">
      <div class="row between wrap g8"><h3>My feedback</h3><button class="btn btn-sm" onclick="window._openFeedback()">${icon('flag', 13)} Send feedback</button></div>
      <div class="stack g8" style="margin-top:10px">
        ${myFeedback.map(f => `
          <div style="border-top:1px solid var(--border);padding-top:8px">
            <div class="row between g8"><span class="tiny dim">${esc(f.received_on)} · ${esc(f.type)}</span>
              <span class="badge ${tone[f.decision] || ''}">${f.decision === 'New' ? 'Received' : esc(f.decision)}${f.shipped_on ? ' · ' + esc(f.shipped_on) : ''}</span></div>
            <p class="small" style="margin-top:2px">“${esc(f.what_they_said)}”</p>
            ${f.decision_reason ? `<p class="tiny dim">${esc(f.decision_reason)}</p>` : ''}
          </div>
        `).join('') || '<p class="small muted">Nothing yet. Tell us what to fix or build next.</p>'}
      </div>
    </div>`;

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">${esc(ROLE_LABEL[u.role])}${u.institution_short ? ' · ' + esc(u.institution_short) : ''}</div>
      <h1 style="margin-top:4px">Account & privacy</h1>
      <p class="muted" style="margin-top:4px">${esc(u.email)}</p>
    </div>

    <div class="split-layout">
      <div class="stack g20">
        ${profileForm(institutions)}
        <form class="card card-pad stack g10" onsubmit="window._changePassword(event)">
          <h3>Change password</h3>
          <div><label class="label" for="pw-cur">Current password</label><input class="input" id="pw-cur" name="current_password" type="password" required autocomplete="current-password"></div>
          <div class="row g10 wrap">
            <div class="grow"><label class="label" for="pw-new">New password</label><input class="input" id="pw-new" name="new_password" type="password" minlength="8" required autocomplete="new-password"></div>
            <div class="grow"><label class="label" for="pw-conf">Confirm new password</label><input class="input" id="pw-conf" name="confirm" type="password" minlength="8" required autocomplete="new-password"></div>
          </div>
          <p class="tiny form-err" style="color:var(--bad)"></p>
          <div><button type="submit" class="btn btn-primary">Change password</button></div>
        </form>
      </div>

      <aside class="stack g16">
        ${feedbackCard}
        <div class="card card-pad">
          <h3>Your data</h3>
          <p class="small muted" style="margin-top:4px">Download everything we hold about you: profile, mentorship requests, messages you sent, applications, RSVPs and subscriptions.</p>
          <button class="btn btn-sm" style="margin-top:12px" onclick="window._exportMyData()">${icon('doc', 14)} Download my data</button>
        </div>
        <form class="card card-pad stack g10" style="border-color:var(--bad-line)" onsubmit="window._deleteMyAccount(event)">
          <h3 style="color:var(--bad)">Delete my account</h3>
          ${canDelete ? `
            <p class="small muted">Removes your account, profile, requests, messages and applications permanently.</p>
            <div><label class="label" for="del-pw2">Password</label><input class="input" id="del-pw2" name="password" type="password" required></div>
            <p class="tiny form-err" style="color:var(--bad)"></p>
            <button type="submit" class="btn" style="color:var(--bad);border-color:var(--bad-line)">Delete my account</button>
          ` : `<p class="small muted">${u.role === 'SUPERADMIN' ? 'Platform accounts are managed separately.' : 'As the owner, delete your institution from Data & Privacy instead, or transfer ownership first.'}</p>`}
        </form>
      </aside>
    </div>
  </div>
  `;
}
