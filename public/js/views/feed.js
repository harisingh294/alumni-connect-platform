// Institution community feed shown on student and alumni dashboards:
// announcements, upcoming events with RSVP, and mentorship programs to join.
import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { toast, refresh, openModal } from '../state.js';

const fmt = (s) => new Date(s.replace(' ', 'T')).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

window._rsvp = async (id) => {
  try {
    const r = await api.community.rsvp(id);
    toast(r.going ? 'You are going — see you there!' : 'RSVP cancelled', r.going ? 'good' : 'default');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};
window._joinProgram = async (id) => {
  try {
    const r = await api.community.joinProgram(id);
    toast(`Joined as ${r.role === 'MENTOR' ? 'a mentor' : 'a mentee'}. Your institution will match you soon.`, 'good');
    refresh();
  } catch (err) { toast(err.message, 'bad'); }
};
window._leaveProgram = async (id) => {
  try { await api.community.leaveProgram(id); toast('You left the program'); refresh(); } catch (err) { toast(err.message, 'bad'); }
};

// Opens the private conversation for an accepted mentorship.
window._openConversation = async (reqId) => {
  try {
    openModal('conversation', await api.community.messages(reqId));
  } catch (err) { toast(err.message, 'bad'); }
};

export async function renderFeed() {
  let feed;
  try {
    feed = await api.community.feed();
  } catch {
    return '';
  }
  const { announcements, events, programs } = feed;
  if (!announcements.length && !events.length && !programs.length) return '';

  return `
    <section class="feed-grid" style="margin-bottom:28px">
      ${announcements.length ? `
        <div class="card card-pad">
          <div class="row g8" style="margin-bottom:10px">${icon('flag', 16)}<h3>From your institution</h3></div>
          <div class="stack g10">
            ${announcements.slice(0, 3).map(a => `
              <div>
                <div class="row g6 wrap"><b class="small">${esc(a.title)}</b>${a.pinned ? '<span class="badge badge-brand">Pinned</span>' : ''}</div>
                <p class="small" style="margin-top:2px;white-space:pre-wrap">${esc(a.body)}</p>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${events.length ? `
        <div class="card card-pad">
          <div class="row g8" style="margin-bottom:10px">${icon('users', 16)}<h3>Upcoming events</h3></div>
          <div class="stack g10">
            ${events.slice(0, 3).map(e => `
              <div class="row between astart g8">
                <div>
                  <b class="small">${esc(e.title)}</b>
                  <div class="tiny dim">${fmt(e.starts_at)} · ${e.mode === 'ONLINE' ? 'Online' : esc(e.location || 'In person')}</div>
                  <div class="tiny dim">${e.rsvp_count} going${e.capacity ? ` · ${e.capacity} places` : ''}</div>
                </div>
                <button class="btn btn-sm ${e.going ? '' : 'btn-primary'}" onclick="window._rsvp('${esc(e.id)}')">${e.going ? `${icon('check', 12)} Going` : 'RSVP'}</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${programs.length ? `
        <div class="card card-pad">
          <div class="row g8" style="margin-bottom:10px">${icon('spark', 16)}<h3>Mentorship programs</h3></div>
          <div class="stack g10">
            ${programs.map(p => `
              <div>
                <div class="row between astart g8">
                  <div><b class="small">${esc(p.title)}</b><div class="tiny dim">${esc(p.topic)}${p.ends_on ? ' · until ' + esc(p.ends_on) : ''}</div></div>
                  ${p.my_role
                    ? (p.matched_name
                      ? `<span class="badge badge-good">Matched with ${esc(p.matched_name)}</span>`
                      : `<button class="btn btn-sm btn-ghost" onclick="window._leaveProgram('${esc(p.id)}')">Leave</button>`)
                    : (p.status === 'OPEN' ? `<button class="btn btn-sm btn-violet" onclick="window._joinProgram('${esc(p.id)}')">Join</button>` : '')}
                </div>
                <p class="tiny muted" style="margin-top:2px">${esc(p.description)}</p>
                ${p.my_role && !p.matched_name ? `<div class="tiny" style="color:var(--violet-ink)">You joined as ${p.my_role === 'MENTOR' ? 'a mentor' : 'a mentee'} · waiting to be matched</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </section>
  `;
}
