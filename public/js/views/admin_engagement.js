import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, refresh, openModal, hasInstFeature } from '../state.js';

const AUD = { ALL: 'Everyone', STUDENTS: 'Students', ALUMNI: 'Alumni' };
const fmt = (s) => (s ? new Date(s.replace(' ', 'T') + (s.length > 16 ? 'Z' : '')).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function upgradeCard(feature, text) {
  return `
    <div class="card card-pad lock-card" style="padding:28px">
      <div style="color:var(--violet)">${icon('lock', 26)}</div>
      <h3 style="margin-top:8px">${esc(feature)} is part of Growth and Enterprise</h3>
      <p class="small muted" style="margin-top:4px">${esc(text)}</p>
      <a class="btn btn-violet btn-sm" style="margin-top:12px" href="#/admin/billing">${icon('star', 13)} Compare plans</a>
    </div>
  `;
}

async function submitForm(e, fn, okMsg) {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  const err = f.querySelector('.form-err');
  btn.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(f).entries());
    if (f.pinned) data.pinned = f.pinned.checked;
    await fn(data);
    toast(okMsg, 'good');
    refresh();
  } catch (ex) {
    err.textContent = ex.message;
    btn.disabled = false;
  }
}

window._postAnnouncement = (e) => submitForm(e, api.engage.postAnnouncement, 'Announcement posted');
window._createEvent = (e) => submitForm(e, api.engage.createEvent, 'Event created');
window._createProgram = (e) => submitForm(e, api.engage.createProgram, 'Program created — members can now join from their dashboard');

window._deleteAnnouncement = async (id) => {
  if (!confirm('Delete this announcement?')) return;
  try { await api.engage.deleteAnnouncement(id); refresh(); } catch (err) { toast(err.message, 'bad'); }
};
window._deleteEvent = async (id) => {
  if (!confirm('Delete this event and its RSVPs?')) return;
  try { await api.engage.deleteEvent(id); refresh(); } catch (err) { toast(err.message, 'bad'); }
};
window._matchProgram = async (id) => {
  try {
    const r = await api.engage.matchProgram(id);
    toast(r.matched ? `Matched ${r.matched} mentees — each pair can now message privately` : 'Everyone is already matched', 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};
window._closeProgram = async (id) => {
  if (!confirm('Close this program to new participants?')) return;
  try { await api.engage.closeProgram(id); refresh(); } catch (err) { toast(err.message, 'bad'); }
};
window._viewProgram = async (id) => {
  try { openModal('program_detail', await api.engage.program(id)); } catch (err) { toast(err.message, 'bad'); }
};

// ---------------- Announcements & events ----------------

export async function renderAdminEngagement() {
  const eventsOn = hasInstFeature('events');
  const [ann, ev] = await Promise.all([
    api.engage.announcements().catch(() => ({ announcements: [] })),
    api.engage.events().catch(() => ({ events: [] }))
  ]);
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const upcoming = ev.events.filter(e => e.starts_at >= now).reverse();
  const past = ev.events.filter(e => e.starts_at < now);

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Engagement</div>
      <h1 style="margin-top:4px">Announcements & events</h1>
      <p class="muted" style="margin-top:4px">Keep students and alumni connected. Announcements appear on member dashboards.</p>
    </div>

    <div class="split-layout">
      <section class="stack g16">
        <h2>Announcements</h2>
        ${ann.announcements.map(a => `
          <div class="card card-pad">
            <div class="row between astart g8">
              <div>
                <div class="row g8 wrap"><h3>${esc(a.title)}</h3>${a.pinned ? '<span class="badge badge-brand">Pinned</span>' : ''}<span class="badge">${AUD[a.audience]}</span></div>
                <div class="tiny dim">${esc(a.author_name || 'Admin')} · ${fmt(a.created_at)}</div>
              </div>
              <button class="btn btn-sm btn-ghost" onclick="window._deleteAnnouncement('${esc(a.id)}')" aria-label="Delete">${icon('x', 14)}</button>
            </div>
            <p class="small" style="margin-top:8px;white-space:pre-wrap">${esc(a.body)}</p>
          </div>
        `).join('') || '<p class="muted small">No announcements yet.</p>'}

        <h2 style="margin-top:12px">Events</h2>
        ${eventsOn ? '' : upgradeCard('Events', 'Run alumni meetups, webinars and career fairs with RSVPs and attendance tracking.')}
        ${upcoming.map(e => eventCard(e)).join('')}
        ${past.length ? `<h4 class="muted" style="margin-top:6px">Past events</h4>${past.map(e => eventCard(e, true)).join('')}` : ''}
        ${eventsOn && !ev.events.length ? '<p class="muted small">No events yet.</p>' : ''}
      </section>

      <aside class="stack g16">
        <form class="card card-pad stack g10" onsubmit="window._postAnnouncement(event)">
          <h3>New announcement</h3>
          <div><label class="label" for="an-title">Title</label><input class="input" id="an-title" name="title" required maxlength="120"></div>
          <div><label class="label" for="an-body">Message</label><textarea class="input" id="an-body" name="body" rows="4" required maxlength="3000"></textarea></div>
          <div><label class="label" for="an-aud">Audience</label>
            <select class="select" id="an-aud" name="audience"><option value="ALL">Everyone</option><option value="STUDENTS">Current students</option><option value="ALUMNI">Alumni</option></select></div>
          <label class="row g8 small"><input type="checkbox" name="pinned"> Pin to top</label>
          <p class="tiny form-err" role="alert" style="color:var(--bad);font-weight:600"></p>
          <button type="submit" class="btn btn-primary">${icon('flag', 14)} Post</button>
        </form>

        ${eventsOn ? `
          <form class="card card-pad stack g10" onsubmit="window._createEvent(event)">
            <h3>New event</h3>
            <div><label class="label" for="ev-title">Title</label><input class="input" id="ev-title" name="title" required maxlength="120"></div>
            <div><label class="label" for="ev-desc">Description</label><textarea class="input" id="ev-desc" name="description" rows="3" required></textarea></div>
            <div><label class="label" for="ev-at">Date & time</label><input class="input" id="ev-at" name="starts_at" type="datetime-local" required></div>
            <div class="row g8">
              <div class="grow"><label class="label" for="ev-mode">Format</label><select class="select" id="ev-mode" name="mode"><option value="ONLINE">Online</option><option value="IN_PERSON">In person</option></select></div>
              <div class="grow"><label class="label" for="ev-cap">Capacity</label><input class="input" id="ev-cap" name="capacity" type="number" min="1"></div>
            </div>
            <div><label class="label" for="ev-loc">Venue or link</label><input class="input" id="ev-loc" name="location" maxlength="200"></div>
            <div><label class="label" for="ev-aud">Audience</label>
              <select class="select" id="ev-aud" name="audience"><option value="ALL">Everyone</option><option value="STUDENTS">Current students</option><option value="ALUMNI">Alumni</option></select></div>
            <p class="tiny form-err" role="alert" style="color:var(--bad);font-weight:600"></p>
            <button type="submit" class="btn btn-primary">${icon('flag', 14)} Create event</button>
          </form>
        ` : ''}
      </aside>
    </div>
  </div>
  `;
}

function eventCard(e, past = false) {
  return `
    <div class="card card-pad" style="${past ? 'opacity:0.7' : ''}">
      <div class="row between astart g8">
        <div>
          <div class="row g8 wrap"><h3>${esc(e.title)}</h3><span class="badge">${e.mode === 'ONLINE' ? 'Online' : 'In person'}</span><span class="badge">${AUD[e.audience]}</span></div>
          <div class="tiny dim">${fmt(e.starts_at)}${e.location ? ' · ' + esc(e.location) : ''}</div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="window._deleteEvent('${esc(e.id)}')" aria-label="Delete">${icon('x', 14)}</button>
      </div>
      <p class="small" style="margin-top:8px">${esc(e.description)}</p>
      <div class="small" style="margin-top:8px"><b class="num">${e.rsvp_count}</b> ${past ? 'attended (RSVPs)' : 'going'}${e.capacity ? ` of ${e.capacity}` : ''}</div>
    </div>
  `;
}

// ---------------- Mentorship ----------------

export async function renderAdminMentorship() {
  const programsOn = hasInstFeature('programs');
  const [stats, progs] = await Promise.all([
    api.engage.mentorship().catch(() => ({ by_topic: [], top_mentors: [], waiting_over_7_days: 0 })),
    api.engage.programs().catch(() => ({ programs: [] }))
  ]);
  const maxTopic = Math.max(1, ...stats.by_topic.map(t => t.count));

  return `
  <div class="page">
    <div class="page-head">
      <div class="eyebrow">Mentorship</div>
      <h1 style="margin-top:4px">Mentorship programs & activity</h1>
      <p class="muted" style="margin-top:4px">See what students ask for, who is helping, and run structured programs that pair students with alumni.</p>
    </div>

    ${stats.waiting_over_7_days ? `<div class="notice notice-warn">${icon('inbox', 14)} ${stats.waiting_over_7_days} requests have waited more than 7 days for a reply. Consider an announcement asking alumni to check their inbox.</div>` : ''}

    <div class="split-layout" style="margin-bottom:24px">
      <section class="card card-pad">
        <h3 style="margin-bottom:12px">What students ask for</h3>
        <div class="stack g10">
          ${stats.by_topic.map(t => `
            <div class="cbar">
              <div class="cbar-lbl truncate">${esc(t.topic)}</div>
              <div class="cbar-track"><div class="cbar-fill cbar-fill-violet" style="width:${(t.count / maxTopic) * 100}%"></div></div>
              <div class="cbar-val num" style="width:70px">${t.accepted}/${t.count}</div>
            </div>
          `).join('') || '<p class="tiny dim">No requests yet.</p>'}
        </div>
        <p class="tiny dim" style="margin-top:8px">Accepted / total requests by topic.</p>
      </section>
      <aside class="card card-pad">
        <h3 style="margin-bottom:10px">Most helpful mentors</h3>
        <div class="stack g8">
          ${stats.top_mentors.map((m, i) => `
            <div class="row between small"><span><b>${i + 1}.</b> ${esc(m.full_name)} <span class="tiny dim">${esc(m.current_company || '')}</span></span><b class="num">${m.accepted}</b></div>
          `).join('') || '<p class="tiny dim">No accepted mentorships yet.</p>'}
        </div>
      </aside>
    </div>

    <div class="row between wrap g8" style="margin-bottom:12px"><h2>Programs</h2></div>
    ${programsOn ? `
      <div class="split-layout">
        <section class="stack g12">
          ${progs.programs.map(p => `
            <div class="card card-pad">
              <div class="row between astart wrap g8">
                <div>
                  <div class="row g8 wrap"><h3>${esc(p.title)}</h3><span class="badge ${p.status === 'OPEN' ? 'badge-good' : ''}">${esc(p.status)}</span><span class="badge badge-violet">${esc(p.topic)}</span></div>
                  <div class="tiny dim">${esc(p.starts_on || '')}${p.ends_on ? ' to ' + esc(p.ends_on) : ''}</div>
                </div>
                <div class="row g6 wrap">
                  <button class="btn btn-sm" onclick="window._viewProgram('${esc(p.id)}')">Participants</button>
                  ${p.status === 'OPEN' ? `<button class="btn btn-sm btn-primary" onclick="window._matchProgram('${esc(p.id)}')">${icon('spark', 13)} Match now</button>
                  <button class="btn btn-sm btn-ghost" onclick="window._closeProgram('${esc(p.id)}')">Close</button>` : ''}
                </div>
              </div>
              <p class="small" style="margin-top:8px">${esc(p.description)}</p>
              <div class="row g16 wrap small" style="margin-top:10px">
                <span><b class="num">${p.mentor_count}</b> mentors</span>
                <span><b class="num">${p.mentee_count}</b> mentees${p.mentee_capacity ? ` / ${p.mentee_capacity}` : ''}</span>
                <span><b class="num">${p.matched_count}</b> matched</span>
                ${p.mentee_count - p.matched_count > 0 ? `<span class="badge badge-warn">${p.mentee_count - p.matched_count} waiting for a match</span>` : ''}
              </div>
            </div>
          `).join('') || '<p class="muted small">No programs yet. Create one to start pairing students with alumni.</p>'}
        </section>
        <aside>
          <form class="card card-pad stack g10" onsubmit="window._createProgram(event)">
            <h3>New program</h3>
            <div><label class="label" for="mp-title">Title</label><input class="input" id="mp-title" name="title" required maxlength="120" placeholder="e.g. Placement Prep 2026"></div>
            <div><label class="label" for="mp-desc">Description</label><textarea class="input" id="mp-desc" name="description" rows="3" required></textarea></div>
            <div><label class="label" for="mp-topic">Focus</label>
              <select class="select" id="mp-topic" name="topic">${['Career Guidance', 'Mock Interview', 'Resume Review', 'Placement preparation', 'Higher studies abroad', 'Career transitions'].map(t => `<option>${t}</option>`).join('')}</select></div>
            <div class="row g8">
              <div class="grow"><label class="label" for="mp-start">Starts</label><input class="input" id="mp-start" name="starts_on" type="date"></div>
              <div class="grow"><label class="label" for="mp-end">Ends</label><input class="input" id="mp-end" name="ends_on" type="date"></div>
            </div>
            <div><label class="label" for="mp-cap">Mentee places (optional)</label><input class="input" id="mp-cap" name="mentee_capacity" type="number" min="1"></div>
            <p class="tiny form-err" role="alert" style="color:var(--bad);font-weight:600"></p>
            <button type="submit" class="btn btn-primary">${icon('spark', 14)} Create program</button>
          </form>
        </aside>
      </div>
    ` : upgradeCard('Mentorship programs', 'Run cohort-based programs: alumni sign up as mentors, students as mentees, and you match them in one click.')}
  </div>
  `;
}
