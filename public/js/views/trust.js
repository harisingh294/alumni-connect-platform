import { icon, esc } from '../icons.js';

const COMMITMENTS = [
  ['shield', 'Your institution owns its data', 'Student, alumni and activity data belong to the institution. We process it only to provide the service you subscribe to.'],
  ['lock', 'We never sell or exploit it', 'No selling, renting or sharing with third parties, no advertising, no profiling, and no training of models on institution data.'],
  ['users', 'Separated from every other institution', 'Each institution’s records are walled off. Admins of one institution cannot see another’s members, and nothing is shared unless you choose to.'],
  ['building', 'Platform staff cannot read member records', 'Our operations console shows only institution accounts, plans, billing, usage counts and feedback people choose to send us. It has no access to profiles, requests or messages.'],
  ['flag', 'Private by default', 'New institutions start with community data visible only to their own verified members. Wider sharing is an explicit setting, and every alumnus can still hide their own profile.'],
  ['doc', 'Take it with you', 'Export your complete data as JSON at any time, on every plan, even after a subscription ends. Delete your institution and all its data in one step.'],
  ['chart', 'Every action is logged', 'Verifications, edits, exports, setting changes and team changes are recorded in an audit log your admins can review.'],
  ['spark', 'Members control their own data', 'Students and alumni can edit their profiles, download everything we hold about them, and delete their accounts themselves.']
];

const CONTROLS = [
  'Tenant isolation enforced on the server for every request',
  'Salted scrypt password hashing and signed, expiring session tokens',
  'Login and signup rate limiting',
  'Security headers on every response, with no-store caching for API data',
  'Deactivated or deleted accounts lose access immediately',
  'Spreadsheet-injection protection on CSV exports'
];

export function renderTrust() {
  return `
  <div class="page">
    <div class="page-head" style="text-align:center">
      <div class="eyebrow">${icon('shield', 12)} Trust & data</div>
      <h1 style="margin-top:6px">We are your technology provider, not a data company</h1>
      <p class="muted" style="margin-top:6px;max-width:66ch;margin-left:auto;margin-right:auto">
        Colleges and schools trust us with their communities. These commitments are built into how the product works, not just written in a policy.
      </p>
    </div>

    <div class="portal-grid" style="margin-bottom:32px">
      ${COMMITMENTS.map(([ic, t, d]) => `
        <div class="card card-pad"><div style="color:var(--good)">${icon(ic, 22)}</div><h3 style="margin-top:8px">${esc(t)}</h3><p class="small muted" style="margin-top:4px">${esc(d)}</p></div>
      `).join('')}
    </div>

    <div class="split-layout">
      <section class="card card-pad">
        <h2>Security controls in this build</h2>
        <ul class="perk-list" style="margin-top:12px">${CONTROLS.map(c => `<li>${icon('check', 13)} ${esc(c)}</li>`).join('')}</ul>
      </section>
      <aside class="card card-pad">
        <h3>For your legal team</h3>
        <p class="small muted" style="margin-top:6px">A formal Data Processing Agreement, along with sub-processor and data-residency details, should be finalised with legal counsel before launch. That includes alignment with India’s Digital Personal Data Protection Act, 2023. The commitments above describe how the software behaves today.</p>
      </aside>
    </div>
  </div>
  `;
}
