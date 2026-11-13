import { icon, esc, inr } from '../icons.js';
import { api } from '../api.js';
import { state, openModal, toast, refreshSession, refresh } from '../state.js';

const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

let plansCache = [];

window._startCheckout = (planId) => {
  const plan = plansCache.find(p => p.id === planId);
  if (plan) openModal('checkout', { plan });
};

window._cancelRenewal = async () => {
  if (!confirm('Turn off auto-renew? You keep Premium until the end of the current period.')) return;
  try {
    await api.subscriptions.cancel();
    toast('Auto-renew turned off', 'good');
    await refreshSession();
    refresh();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

function planCard(plan, u, premium) {
  const perMonth = Math.round(plan.price_inr / (plan.days / 30));
  let cta;
  if (!u) cta = `<a class="btn btn-violet" href="#/signup/external">Sign up to subscribe</a>`;
  else if (u.role !== 'EXTERNAL') cta = '';
  else if (premium) cta = `<button class="btn" disabled>${icon('check', 14)} You have Premium</button>`;
  else cta = `<button class="btn btn-violet" onclick="window._startCheckout('${esc(plan.id)}')">${icon('star', 14)} Choose ${esc(plan.name)}</button>`;

  return `
    <div class="card card-pad price-card ${plan.id === 'premium_annual' ? 'price-card-featured' : ''}">
      ${plan.id === 'premium_annual' ? '<span class="badge badge-violet" style="align-self:flex-start">Best value</span>' : ''}
      <h3>${esc(plan.name)}</h3>
      <div class="row g6" style="align-items:baseline">
        <span class="stat-val num">${inr(plan.price_inr)}</span>
        <span class="small muted">/ ${plan.days >= 365 ? 'year' : 'month'}</span>
      </div>
      ${plan.days >= 365 ? `<div class="tiny dim">About ${inr(perMonth)} per month</div>` : '<div class="tiny dim">Cancel any time</div>'}
      <ul class="perk-list">${plan.features.map(f => `<li>${icon('check', 13)} ${esc(f)}</li>`).join('')}</ul>
      <div style="margin-top:auto">${cta}</div>
    </div>
  `;
}

export async function renderPremium() {
  const u = state.user;
  try {
    plansCache = (await api.subscriptions.plans()).plans || [];
  } catch {
    plansCache = [];
  }

  let mine = null;
  if (u?.role === 'EXTERNAL') {
    try { mine = await api.subscriptions.me(); } catch { mine = null; }
  }
  const active = mine?.active;
  const premium = Boolean(active);

  return `
  <div class="page">
    <div class="page-head" style="text-align:center">
      <div class="eyebrow" style="color:var(--violet)">${icon('star', 12)} Premium</div>
      <h1 style="margin-top:6px">Personal guidance from alumni, for students outside the college</h1>
      <p class="muted" style="margin-top:6px;max-width:62ch;margin-left:auto;margin-right:auto">
        College information is free for everyone. Premium adds one-to-one mentorship, career guidance and internships
        from alumni who have opted in to help students from other colleges and schools.
      </p>
    </div>

    ${u && (u.role === 'STUDENT' || u.role === 'ALUMNI') ? `
      <div class="notice notice-brand" style="max-width:720px;margin:0 auto 20px">${icon('shield', 14)}
        ${u.role === 'STUDENT'
          ? `As a current student of ${esc(u.institution_short)}, mentorship from your college's alumni is <b>always free</b>. Premium is only for students from other colleges and schools.`
          : 'Alumni never pay. You can choose to mentor Premium students from other colleges from your dashboard.'}
      </div>
    ` : ''}

    ${premium ? `
      <div class="card card-pad" style="max-width:720px;margin:0 auto 24px;border-color:var(--violet-line);background:var(--violet-soft)">
        <div class="row between wrap g12">
          <div>
            <div class="row g8" style="color:var(--violet-ink)">${icon('star', 18)}<h3 style="color:var(--violet-ink)">${esc(mine.plan?.name || 'Premium')} is active</h3></div>
            <p class="small" style="margin-top:6px;color:var(--violet-ink)">
              Started ${fmtDate(active.started_at)} · ${active.auto_renew ? 'Renews' : 'Ends'} on <b>${fmtDate(active.expires_at)}</b>
            </p>
          </div>
          <div class="row g8 wrap">
            <a class="btn btn-violet btn-sm" href="#/alumni?external_only=1">${icon('spark', 13)} Find a mentor</a>
            <a class="btn btn-sm" href="#/internships">${icon('brief', 13)} Internships</a>
            ${active.auto_renew ? `<button class="btn btn-sm btn-ghost" onclick="window._cancelRenewal()">Turn off auto-renew</button>` : ''}
          </div>
        </div>
      </div>
    ` : ''}

    <div class="price-grid">
      <div class="card card-pad price-card">
        <h3>Free</h3>
        <div class="row g6" style="align-items:baseline"><span class="stat-val num">₹0</span><span class="small muted">forever</span></div>
        <div class="tiny dim">For every signed-up student</div>
        <ul class="perk-list">
          ${['Courses, fees and eligibility', 'Placement records and top recruiters', 'Alumni-network outcomes', 'Browse and save alumni profiles'].map(f => `<li>${icon('check', 13)} ${esc(f)}</li>`).join('')}
        </ul>
        <div style="margin-top:auto">${u ? '' : '<a class="btn" href="#/signup/external">Create free account</a>'}</div>
      </div>
      ${plansCache.map(p => planCard(p, u, premium)).join('')}
    </div>

    <p class="tiny dim" style="text-align:center;margin-top:18px">
      ${icon('shield', 11)} Payments in this build are simulated (demo mode). No card details are collected and no money is charged.
    </p>

    ${mine?.history?.length ? `
      <section style="max-width:720px;margin:28px auto 0">
        <h3 style="margin-bottom:10px">Billing history</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Plan</th><th class="num">Amount</th><th>Reference</th></tr></thead>
            <tbody>
              ${mine.history.map(h => `
                <tr>
                  <td class="small">${fmtDate(h.started_at)}</td>
                  <td class="small">${esc((plansCache.find(p => p.id === h.plan_id) || {}).name || h.plan_id)}</td>
                  <td class="num small">${inr(h.amount_inr)}</td>
                  <td class="tiny dim">${esc(h.payment_ref)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </section>
    ` : ''}
  </div>
  `;
}
