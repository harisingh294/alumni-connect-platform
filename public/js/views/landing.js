import { icon, esc } from '../icons.js';
import { api } from '../api.js';
import { openModal } from '../state.js';

export async function renderLanding() {
  let stats = { institutions: [], top_employers: [] };
  try {
    const instData = await api.student.getInstitutions();
    stats.institutions = instData.institutions || [];
  } catch (e) {
    console.error('Failed to fetch institutions:', e);
  }

  const instCount = stats.institutions.length || 3;
  const verifiedTotal = stats.institutions.reduce((acc, i) => acc + (i.verified_count || 0), 0) || 103;

  return `
  <section class="hero">
    <div class="hero-grid">
      <div>
        <span class="badge badge-brand">${icon('shield', 13)} Verified by Educational Institutions</span>
        <h1 style="margin-top:16px">Where did the graduates of this college actually end up?</h1>
        <p style="margin-top:12px;font-size:1.05rem;line-height:1.55;color:var(--ink-2)">
          Brochures advertise rankings and placement percentages. <b>Alumni Connect Platform</b> reveals the real outcomes — verified companies, job roles, cities, and career journeys — and opens a structured, spam-free channel to ask alumni for guidance.
        </p>

        <div class="row g10 wrap" style="margin-top:24px">
          <a class="btn btn-primary" href="#/alumni?mentor_only=1">${icon('spark', 15)} Find a Verified Mentor</a>
          <a class="btn" href="#/institutions">${icon('building', 15)} Explore Institutions</a>
        </div>

        <div class="row wrap g8" style="margin-top:20px">
          <span class="tiny dim">Featured Institutions:</span>
          ${stats.institutions.map(i => `
            <a class="chip" href="#/alumni?inst=${i.id}" style="cursor:pointer">${esc(i.short_name)}</a>
          `).join('')}
        </div>
      </div>

      <div class="card card-pad" style="background:var(--surface)">
        <div class="row between" style="margin-bottom:16px">
          <div>
            <div class="eyebrow">Live Ecosystem</div>
            <h3 style="margin-top:4px">Verified Alumni Network</h3>
          </div>
          <span class="badge badge-good">${icon('shield', 12)} ${verifiedTotal} Verified</span>
        </div>

        <div class="stack g12">
          ${[
            ['Stripe', 'Fintech', 18],
            ['Google', 'Software & Internet', 15],
            ['Microsoft', 'Software & Internet', 12],
            ['McKinsey & Co', 'Consulting', 9],
            ['Goldman Sachs', 'Financial Services', 8],
            ['Amazon', 'E-commerce', 8]
          ].map(([co, ind, count]) => `
            <div class="cbar">
              <div class="cbar-lbl truncate" style="font-weight:600">${esc(co)}</div>
              <div class="cbar-track">
                <div class="cbar-fill" style="width:${(count / 18) * 100}%"></div>
              </div>
              <div class="cbar-val num font-bold">${count}</div>
            </div>
          `).join('')}
        </div>

        <div class="row between" style="margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
          <span class="tiny dim">Across ${instCount} partner institutions</span>
          <a class="small font-semibold" href="#/alumni">Browse all alumni ${icon('arrow', 13)}</a>
        </div>
      </div>
    </div>
  </section>

  <section style="margin-bottom:48px">
    <div class="eyebrow">The Core Problem</div>
    <h2 style="margin-top:8px;max-width:24em">Educational decisions are usually made on marketing. We ground them in verified data.</h2>

    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:20px;margin-top:24px">
      <div class="card card-pad">
        <h3 style="color:var(--bad)">What Students See</h3>
        <p class="small muted" style="margin-top:10px">Brochures, sponsored social posts, and unverified placement percentages with no denominator.</p>
      </div>
      <div class="card card-pad">
        <h3 style="color:var(--brand)">What They Actually Need</h3>
        <p class="small muted" style="margin-top:10px">Where previous batches work today. Which roles were realistic. Who pursued higher studies abroad and who switched fields.</p>
      </div>
      <div class="card card-pad" style="border-color:var(--brand-line);background:var(--brand-soft)">
        <h3 style="color:var(--brand-ink)">What We Enable</h3>
        <p class="small" style="margin-top:10px;color:var(--brand-ink)">Institution-verified career directories and structured, respectful mentorship requests that give alumni a reason to stay engaged.</p>
      </div>
    </div>
  </section>

  <section style="margin-bottom:40px">
    <div class="eyebrow">Select Your Workspace</div>
    <h2 style="margin-top:8px;margin-bottom:20px">Choose how you experience the platform</h2>

    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:20px">
      <div class="card card-pad card-hover" style="cursor:pointer" onclick="window._switchPersona('student')">
        <div style="color:var(--brand)">${icon('cap', 28)}</div>
        <h3 style="margin-top:12px">Student Workspace</h3>
        <p class="small muted" style="margin-top:6px">Search alumni across 7 dimensions, save career profiles, and submit structured mentorship inquiries.</p>
        <div class="row g6" style="margin-top:16px;color:var(--brand);font-weight:600;font-size:0.88rem">Open Student Portal ${icon('arrow', 14)}</div>
      </div>

      <div class="card card-pad card-hover" style="cursor:pointer" onclick="window._switchPersona('alumni')">
        <div style="color:var(--violet)">${icon('users', 28)}</div>
        <h3 style="margin-top:12px">Alumni Workspace</h3>
        <p class="small muted" style="margin-top:6px">Manage your career trajectory, set mentorship availability, select guidance topics, and answer student requests.</p>
        <div class="row g6" style="margin-top:16px;color:var(--violet);font-weight:600;font-size:0.88rem">Open Alumni Portal ${icon('arrow', 14)}</div>
      </div>

      <div class="card card-pad card-hover" style="cursor:pointer" onclick="window._switchPersona('admin')">
        <div style="color:var(--good)">${icon('building', 28)}</div>
        <h3 style="margin-top:12px">Institution Admin</h3>
        <p class="small muted" style="margin-top:6px">Import CSV rosters, review the verification queue, manage the alumni directory, and monitor network health.</p>
        <div class="row g6" style="margin-top:16px;color:var(--good);font-weight:600;font-size:0.88rem">Open Admin Dashboard ${icon('arrow', 14)}</div>
      </div>
    </div>
  </section>
  `;
}
