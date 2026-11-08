/* MilestonePay front-end — vanilla JS, no build step. */
const $app = document.getElementById('app');
const state = { config: null, draft: null, project: null, role: 'freelancer', token: null, busy: {}, uploads: {}, justVerified: null, openForm: {}, sig: '' };

// ------------------------------------------------------------------ utils
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number(n) || 0);
const date = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dateTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS_LABEL = { PLANNED: 'Not funded yet', FUNDED: 'Funds on hold', SUBMITTED: 'Awaiting client review', REVISION: 'Revision requested', RELEASED: 'Paid', PARTIAL: 'Partially paid', VOIDED: 'Hold returned' };
const HELD = ['FUNDED', 'SUBMITTED', 'REVISION'];

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details?.[0]?.description || data.details?.[0]?.issue;
    throw new Error((data.error || `Request failed (${res.status})`) + (detail ? ` — ${detail}` : '') + (data.debugId ? ` [PayPal debug id ${data.debugId}]` : ''));
  }
  return data;
}
let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 7000 : 3500);
}
async function withBusy(key, fn) {
  if (state.busy[key]) return;
  state.busy[key] = true;
  rerender();
  try { await fn(); } catch (e) { toast(e.message, true); console.error(e); } finally { state.busy[key] = false; rerender(); }
}
const spin = (key, label, busyLabel) => (state.busy[key] ? `<span class="spinner" aria-hidden="true"></span>${h(busyLabel)}` : h(label));

// ------------------------------------------------------------------ routing
function parseHash() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  return { parts: (path || '/').split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}
async function route() {
  const { parts, q } = parseHash();
  state.project = null;
  if (parts[0] === 'plan') return viewPlan();
  if (parts[0] === 'p' || parts[0] === 'c') {
    state.role = parts[0] === 'c' ? 'client' : 'freelancer';
    state.token = q.get('t');
    $app.innerHTML = `<div class="thinking"><span class="spinner"></span>Loading agreement…</div>`;
    try {
      state.project = state.role === 'client'
        ? await api('GET', `/api/client/${parts[1]}?t=${encodeURIComponent(state.token || '')}`)
        : await api('GET', `/api/projects/${parts[1]}`);
      state.sig = signature(state.project);
      return viewProject();
    } catch (e) {
      $app.innerHTML = `<div class="panel"><h2>We couldn't open this agreement</h2><p class="error-box">${h(e.message)}</p><a class="btn ghost" href="#/">Go to your agreements</a></div>`;
      return;
    }
  }
  return viewHome();
}
function rerender() {
  const { parts } = parseHash();
  if (parts[0] === 'plan') viewPlan();
  else if (state.project) viewProject();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

// ------------------------------------------------------------------ money rail (signature element)
function rail(project, big = false) {
  const segs = project.milestones.map((m) => {
    const w = Math.max(4, (m.amount / project.budget) * 100);
    const label = `Milestone ${m.idx + 1 || ''}: ${money(m.amount, project.currency)} — ${STATUS_LABEL[m.status]}`;
    if (m.status === 'PARTIAL') {
      return `<div class="seg void" style="flex:${w}" title="${h(label)}"><div class="part" style="width:${(m.released / m.amount) * 100}%"></div></div>`;
    }
    const cls = HELD.includes(m.status) ? 'held' : m.status === 'RELEASED' ? 'paid' : m.status === 'VOIDED' ? 'void' : 'unfunded';
    return `<div class="seg ${cls}" style="flex:${w}" title="${h(label)}"></div>`;
  }).join('');
  return `<div class="rail${big ? ' big' : ''}" role="img" aria-label="Payment progress">${segs}</div>`;
}
function totals(p) {
  const paid = p.milestones.reduce((s, m) => s + (m.released || 0), 0);
  const held = p.milestones.filter((m) => HELD.includes(m.status)).reduce((s, m) => s + m.amount, 0);
  return { paid, held, open: Math.max(0, p.budget - paid - held - p.milestones.filter((m) => ['VOIDED', 'PARTIAL'].includes(m.status)).reduce((s, m) => s + m.amount - (m.released || 0), 0)) };
}

// ------------------------------------------------------------------ HOME
const SAMPLE = {
  brief: `Hi! I run a small surf school in Canggu, Bali (Swell & Salt Surf Co). Our current site is an old Wix page that doesn't work well on phones.

I need a new website: home page with a big video/photo hero, our 3 lesson packages with prices (beginner, intermediate, private), a page about our instructors, a gallery, and a contact page with a WhatsApp button and Google Maps. It must be fast on mobile because most customers find us on Instagram. English only for now.

Maybe later we'll want an online booking system with deposits and an Indonesian version, but not now. Budget is around $900 and I'd love to launch before the high season in 3 weeks.`,
  budget: 900, deadlineDays: 21, clientName: 'Mark Ellison', clientEmail: '', yourName: 'Ayu Pratiwi',
};

async function viewHome() {
  $app.innerHTML = `
  <section class="home-hero">
    <div>
      <h1>Get paid for work that's verifiably done.</h1>
      <p class="lede">MilestonePay turns a client's brief into milestones with clear acceptance criteria. The client's money waits on hold in PayPal, an AI verifier checks each delivery against what was agreed, and the client releases payment with one click.</p>
      <ol class="how">
        <li><span class="dot d1"></span><div><b>Agree on what "done" means</b><span class="muted">AI drafts milestones and testable criteria from the brief.</span></div></li>
        <li><span class="dot d2"></span><div><b>Client funds a hold, not a payment</b><span class="muted">PayPal authorizes the amount. Nothing is charged yet.</span></div></li>
        <li><span class="dot d3"></span><div><b>AI checks the delivery</b><span class="muted">Links, repos and screenshots are compared to each criterion.</span></div></li>
        <li><span class="dot d4"></span><div><b>Client releases the money</b><span class="muted">Full or partial capture. New requests become separate invoices.</span></div></li>
      </ol>
    </div>
    <form class="panel" id="newForm" novalidate>
      <h2 style="margin-bottom:6px">Start an agreement</h2>
      <p class="muted small">Paste the brief or chat exactly as your client sent it. <button type="button" class="linkish" data-action="sample">Use a sample brief</button></p>
      <div class="field"><label for="brief">Client's brief</label><textarea id="brief" name="brief" rows="8" required placeholder="Hi, I need a website for…"></textarea></div>
      <div class="row3 field">
        <div><label for="budget">Total budget</label><input id="budget" name="budget" type="number" min="1" step="1" required placeholder="900"></div>
        <div><label for="currency">Currency</label><select id="currency" name="currency">${['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'].map((c) => `<option ${c === state.config.defaultCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
        <div><label for="deadlineDays">Timeline <span class="hint">days</span></label><input id="deadlineDays" name="deadlineDays" type="number" min="1" placeholder="21"></div>
      </div>
      <div class="row field">
        <div><label for="clientName">Client name</label><input id="clientName" name="clientName" placeholder="Mark Ellison"></div>
        <div><label for="clientEmail">Client email <span class="hint">for invoices</span></label><input id="clientEmail" name="clientEmail" type="email" required placeholder="client@example.com"></div>
      </div>
      <div class="field"><label for="yourName">Your name</label><input id="yourName" name="yourName" placeholder="Ayu Pratiwi"></div>
      <button class="btn" type="submit" ${state.busy.plan ? 'disabled' : ''}>${spin('plan', 'Draft milestones with AI', 'Reading the brief…')}</button>
      <div id="formErr"></div>
    </form>
  </section>
  <section class="agreements"><h2>Your agreements</h2><div id="list"><div class="thinking"><span class="spinner"></span>Loading…</div></div></section>`;

  const form = document.getElementById('newForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const err = document.getElementById('formErr');
    if (f.brief.trim().length < 20) return (err.innerHTML = `<p class="error-box">Paste the full brief so the AI has enough to plan with.</p>`);
    if (!(Number(f.budget) > 0)) return (err.innerHTML = `<p class="error-box">Enter the total budget agreed with the client.</p>`);
    if (!/^\S+@\S+\.\S+$/.test(f.clientEmail)) return (err.innerHTML = `<p class="error-box">Enter the client's email. Change-order invoices are sent there.</p>`);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Reading the brief…';
    try {
      const plan = await api('POST', '/api/plan', { brief: f.brief, budget: Number(f.budget), currency: f.currency, deadlineDays: Number(f.deadlineDays) || null });
      state.draft = { plan, inputs: f };
      sessionStorage.setItem('mp-draft', JSON.stringify(state.draft));
      location.hash = '#/plan';
    } catch (e2) {
      err.innerHTML = `<p class="error-box">${h(e2.message)}</p>`;
      btn.disabled = false; btn.textContent = 'Draft milestones with AI';
    }
  });

  try {
    const list = await api('GET', '/api/projects');
    document.getElementById('list').innerHTML = list.length ? list.map((p) => {
      const paid = p.milestones.reduce((s, m) => s + (m.released || 0), 0);
      return `<a class="agreement" href="#/p/${p.id}">
        <div><h3>${h(p.title)}</h3><span class="muted small">with ${h(p.client.name)} — started ${date(p.createdAt)}</span></div>
        <div style="text-align:right"><div class="amount">${money(paid, p.currency)} <span class="muted small">of ${money(p.budget, p.currency)}</span></div></div>
        ${rail({ ...p, milestones: p.milestones.map((m, i) => ({ ...m, idx: i })) })}
      </a>`;
    }).join('') : `<div class="empty">No agreements yet. Paste a client brief above to draft your first one.</div>`;
  } catch (e) {
    document.getElementById('list').innerHTML = `<p class="error-box">${h(e.message)}</p>`;
  }
}

// ------------------------------------------------------------------ PLAN REVIEW
function viewPlan() {
  if (!state.draft) {
    const saved = sessionStorage.getItem('mp-draft');
    if (saved) state.draft = JSON.parse(saved);
    else { location.hash = '#/'; return; }
  }
  const { plan, inputs } = state.draft;
  const cur = inputs.currency;
  const total = plan.milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
  $app.innerHTML = `
  <div class="plan-head">
    <div><p class="muted" style="margin:0 0 6px">Drafted by AI from ${h(inputs.clientName || 'your client')}'s brief. Edit anything before sharing.</p>
    <h1><input aria-label="Project title" data-plan="projectTitle" value="${h(plan.projectTitle)}" style="font:inherit;border:0;background:transparent;padding:0;width:100%"></h1></div>
    <div style="text-align:right"><div class="amount">${money(total, cur)}</div><span class="small ${Math.abs(total - inputs.budget) > 0.01 ? '' : 'muted'}" style="${Math.abs(total - inputs.budget) > 0.01 ? 'color:var(--stamp)' : ''}">${Math.abs(total - inputs.budget) > 0.01 ? `Budget was ${money(inputs.budget, cur)}` : 'Matches the agreed budget'}</span></div>
  </div>
  <div class="layout">
    <div class="panel">
      <div class="field"><label for="summary">Scope summary</label><textarea id="summary" data-plan="summary" rows="3">${h(plan.summary)}</textarea></div>
      ${plan.milestones.map((m, i) => `
      <div class="ms-edit">
        <div class="ms-num">${i + 1}</div>
        <div>
          <div class="row3 field">
            <div><label for="t${i}">Milestone</label><input id="t${i}" data-ms="${i}" data-k="title" value="${h(m.title)}"></div>
            <div><label for="a${i}">Amount <span class="hint">${cur}</span></label><input id="a${i}" type="number" step="0.01" min="1" data-ms="${i}" data-k="amount" value="${m.amount}"></div>
            <div><label for="d${i}">Due in <span class="hint">days</span></label><input id="d${i}" type="number" min="1" data-ms="${i}" data-k="dueInDays" value="${m.dueInDays}"></div>
          </div>
          <div class="field"><label for="ds${i}">What's delivered</label><textarea id="ds${i}" rows="2" data-ms="${i}" data-k="description" style="min-height:60px">${h(m.description)}</textarea></div>
          <div class="field criteria-edit"><label for="c${i}">Acceptance criteria <span class="hint">one per line — the AI verifier checks exactly these</span></label><textarea id="c${i}" data-ms="${i}" data-k="criteria">${h(m.criteria.join('\n'))}</textarea></div>
          <button type="button" class="linkish small" data-action="rm-ms" data-i="${i}" ${plan.milestones.length <= 1 ? 'hidden' : ''}>Remove milestone</button>
        </div>
      </div>`).join('')}
      <button type="button" class="btn ghost small" data-action="add-ms">Add milestone</button>
    </div>
    <aside class="side">
      <div class="panel">
        <h3>Not included</h3>
        <p class="muted small">Scope Guard uses this list to spot new requests later and turn them into separate invoices.</p>
        <textarea data-plan="outOfScope" rows="5" aria-label="Out of scope, one per line">${h(plan.outOfScope.join('\n'))}</textarea>
      </div>
      ${plan.assumptions.length ? `<div class="panel"><h3>Assumptions</h3><ul class="small muted" style="padding-left:18px;margin:8px 0 0">${plan.assumptions.map((a) => `<li>${h(a)}</li>`).join('')}</ul></div>` : ''}
      ${plan.risks?.length ? `<div class="panel"><h3>Watch out for</h3><ul class="small muted" style="padding-left:18px;margin:8px 0 0">${plan.risks.map((a) => `<li>${h(a)}</li>`).join('')}</ul></div>` : ''}
      <div class="panel">
        <button class="btn paid" style="width:100%" data-action="save-plan" ${state.busy.save ? 'disabled' : ''}>${spin('save', 'Create agreement and client link', 'Creating…')}</button>
        <p class="small muted" style="margin:10px 0 0">Your client funds each milestone through PayPal. Money is held, not charged, until they release it.</p>
        <button class="linkish small" data-action="discard">Start over</button>
      </div>
    </aside>
  </div>`;
}

function syncPlanInputs() {
  const plan = state.draft.plan;
  document.querySelectorAll('[data-plan]').forEach((el) => {
    const k = el.dataset.plan;
    plan[k] = k === 'outOfScope' ? el.value.split('\n').map((s) => s.trim()).filter(Boolean) : el.value;
  });
  document.querySelectorAll('[data-ms]').forEach((el) => {
    const m = plan.milestones[el.dataset.ms];
    const k = el.dataset.k;
    m[k] = k === 'criteria' ? el.value.split('\n').map((s) => s.trim()).filter(Boolean) : ['amount', 'dueInDays'].includes(k) ? Number(el.value) : el.value;
  });
  sessionStorage.setItem('mp-draft', JSON.stringify(state.draft));
}

// ------------------------------------------------------------------ PROJECT
function viewProject() {
  const p = state.project;
  const isClient = state.role === 'client';
  const t = totals(p);
  const current = p.milestones.find((m) => !['RELEASED', 'PARTIAL', 'VOIDED'].includes(m.status));
  const clientLink = `${location.origin}/#/c/${p.id}?t=${p.clientToken}`;
  $app.innerHTML = `
  ${isClient
    ? `<div class="role-banner"><span>Hi ${h(p.client.name)}. ${h(p.freelancer.name)} proposed this agreement. Funding a milestone puts the amount on hold in your PayPal account; you're only charged when you release it.</span></div>`
    : `<div class="role-banner"><span>You're viewing this as the freelancer.</span><a href="${h(clientLink)}" target="_blank" rel="noopener">Open the client's view in a new tab</a></div>`}
  <section class="project-head">
    <h1>${h(p.title)}</h1>
    <div class="parties"><span>Freelancer <b>${h(p.freelancer.name)}</b></span><span>Client <b>${h(p.client.name)}</b></span><span>Total <b>${money(p.budget, p.currency)}</b></span>${p.status === 'COMPLETED' ? '<span><b style="color:var(--paid)">Completed</b></span>' : ''}</div>
    ${rail(p, true)}
    <div class="legend"><span class="l-paid">Paid <b>${money(t.paid, p.currency)}</b></span><span class="l-held">On hold <b>${money(t.held, p.currency)}</b></span><span class="l-unf">Not funded <b>${money(t.open, p.currency)}</b></span></div>
    ${!isClient ? `<div class="share"><input readonly value="${h(clientLink)}" aria-label="Client link" onclick="this.select()"><button class="btn ghost small" data-action="copy" data-v="${h(clientLink)}">Copy client link</button></div>` : ''}
    ${p.summary ? `<p class="muted" style="max-width:75ch;margin-top:16px">${h(p.summary)}</p>` : ''}
  </section>
  <div class="layout">
    <section class="track" aria-label="Milestones">${p.milestones.map((m) => milestoneCard(m, p, current && current.id === m.id)).join('')}</section>
    <aside class="side">${conversation(p)}${activity(p)}</aside>
  </div>`;
  mountPayPalButtons();
}

function milestoneCard(m, p, isCurrent) {
  const isClient = state.role === 'client';
  const sub = m.submissions?.[m.submissions.length - 1];
  const firstUnfunded = p.milestones.find((x) => x.status === 'PLANNED');
  let body = '';

  if (m.status === 'PLANNED') {
    if (isClient && firstUnfunded?.id === m.id) {
      body = `<div class="pp-box"><p class="small muted">Approve a hold of ${money(m.amount, p.currency)}. You can review the work before anything is captured.</p>${
        state.config.paypalMode === 'mock'
          ? `<div class="sim"><p class="small" style="margin-top:0"><b>Simulated PayPal.</b> This server has no sandbox credentials, so approval is simulated.</p><button class="btn" data-action="sim-fund" data-m="${m.id}" ${state.busy['fund' + m.id] ? 'disabled' : ''}>${spin('fund' + m.id, 'Approve hold', 'Authorizing…')}</button></div>`
          : `<div id="pp-${m.id}" class="pp-slot" data-m="${m.id}"></div>`}</div>`;
    } else if (!isClient) {
      body = `<p class="small muted" style="margin-top:12px">${firstUnfunded?.id === m.id ? 'Waiting for the client to fund this milestone.' : 'Can be funded after the previous milestone.'}</p>`;
    }
  }

  if (HELD.includes(m.status)) {
    const pastHonor = m.honorExpiresAt && new Date(m.honorExpiresAt) < new Date();
    body += `<div class="hold-note">${money(m.amount, p.currency)} on hold in PayPal until ${date(m.authExpiresAt)}.${!isClient && (pastHonor || state.config.paypalMode === 'mock') && !m.reauthorizedAt ? ` <button class="linkish" data-action="reauth" data-m="${m.id}">Refresh hold</button>` : ''}</div>`;
    if (m.status === 'REVISION' && m.revisionNote) body += `<p class="error-box small"><b>Client's revision note:</b> ${h(m.revisionNote)}</p>`;
  }

  if (sub && ['SUBMITTED', 'REVISION', 'RELEASED', 'PARTIAL'].includes(m.status)) body += report(sub, m, p);

  if (!isClient && (['FUNDED', 'REVISION'].includes(m.status) || (m.status === 'SUBMITTED' && state.openForm[m.id]))) body += submitForm(m);
  if (!isClient && m.status === 'SUBMITTED' && !state.openForm[m.id]) body += `<div class="actions"><button class="btn ghost small" data-action="open-form" data-m="${m.id}">Submit an update</button></div>`;
  if (state.busy['submit' + m.id]) body += `<div class="thinking"><span class="spinner"></span>The verifier is opening your links and checking each criterion…</div>`;

  if (['RELEASED', 'PARTIAL'].includes(m.status)) {
    const c = m.captures[m.captures.length - 1];
    body += `<p class="small" style="margin-top:12px;color:#1f5a40"><b>${money(m.released, p.currency)} paid</b> on ${date(m.releasedAt)}${m.status === 'PARTIAL' ? `; ${money(m.amount - m.released, p.currency)} returned to the client` : ''}. <span class="muted">PayPal capture ${h(c?.id)}</span></p>`;
  }

  if (!isClient && HELD.includes(m.status)) {
    body += `<div class="actions">${state.openForm['void' + m.id]
      ? `<span class="small">Return ${money(m.amount, p.currency)} to the client?</span><button class="btn danger small" data-action="void" data-m="${m.id}">Yes, return funds</button><button class="linkish small" data-action="toggle" data-k="void${m.id}">Keep hold</button>`
      : `<button class="linkish small" data-action="toggle" data-k="void${m.id}">Return funds to client</button>`}</div>`;
  }

  return `<article class="milestone st-${m.status}${isCurrent ? ' is-current' : ''}" id="m-${m.id}">
    <div class="ms-spine"><span class="n">${m.idx + 1}</span><span class="bar"></span></div>
    <div class="ms-body">
      <div class="ms-top"><div><h3>${h(m.title)}</h3><span class="status s-${m.status}">${STATUS_LABEL[m.status]}</span></div><div class="amount">${money(m.amount, p.currency)}</div></div>
      ${m.description ? `<p class="muted" style="margin:10px 0 0">${h(m.description)}</p>` : ''}
      ${!sub ? `<ul class="criteria" aria-label="Acceptance criteria">${m.criteria.map((c) => `<li>${h(c)}</li>`).join('')}</ul>` : ''}
      ${m.dueInDays ? `<p class="small muted" style="margin:10px 0 0">Due ${m.dueInDays} days after start</p>` : ''}
      ${body}
    </div>
  </article>`;
}

function submitForm(m) {
  const ups = state.uploads[m.id] || [];
  return `<form class="sub-form" data-submit="${m.id}">
    <h3 style="margin-bottom:10px">Submit work for verification</h3>
    <div class="field"><label for="n-${m.id}">What did you deliver?</label><textarea id="n-${m.id}" name="notes" rows="3" placeholder="Explain how each criterion is met."></textarea></div>
    <div class="field"><label for="l-${m.id}">Links <span class="hint">live preview, GitHub repo, Figma, Drive</span></label><input id="l-${m.id}" name="links" placeholder="https://…"></div>
    <div class="field"><label for="f-${m.id}">Screenshots <span class="hint">up to 3</span></label>
      <input id="f-${m.id}" type="file" accept="image/png,image/jpeg,image/webp" multiple data-upload="${m.id}" class="drop">
      ${ups.length ? `<div class="thumbs">${ups.map((u) => `<img src="${u}" alt="Screenshot to verify">`).join('')}</div>` : ''}</div>
    <button class="btn" type="submit" ${state.busy['submit' + m.id] ? 'disabled' : ''}>${spin('submit' + m.id, 'Submit for AI verification', 'Verifying…')}</button>
  </form>`;
}

function report(sub, m, p) {
  const v = sub.verification;
  const isClient = state.role === 'client';
  const label = { RELEASE: 'Ready to pay', PARTIAL: 'Partly done', REVISE: 'Needs work' }[v.verdict];
  const icon = { MET: '✓', PARTIAL: '½', NOT_MET: '✕', UNVERIFIABLE: '?' };
  const statusText = { MET: 'Met', PARTIAL: 'Partly met', NOT_MET: 'Not met', UNVERIFIABLE: 'Check by hand' };
  const rec = v.recommendedReleasePercent;
  const pct = state.openForm['pct' + m.id] ?? (rec || 100);
  return `<div class="report">
    <div class="report-head">
      <div><h3>AI verification</h3><p class="small muted" style="margin:4px 0 10px">Submitted ${dateTime(sub.at)}${sub.links.length ? ` with ${sub.links.length} link${sub.links.length > 1 ? 's' : ''}` : ''}${sub.screenshots ? ` and ${sub.screenshots} screenshot${sub.screenshots > 1 ? 's' : ''}` : ''}</p>
      <p>${h(v.clientSummary)}</p></div>
      <div class="stamp ${v.verdict}${state.justVerified === m.id ? ' land' : ''}" aria-label="Score ${v.score} of 100, ${label}"><div><div class="sc">${v.score}</div><div class="vd">${label}</div></div></div>
    </div>
    <ul class="checks">${v.criteria.map((c) => `<li><span class="ico ${c.status}" aria-hidden="true">${icon[c.status]}</span><div><b>${h(c.criterion)}</b> <span class="small muted">${statusText[c.status]}</span><div class="evidence">${h(c.evidence)}</div></div></li>`).join('')}</ul>
    ${v.manualChecks?.length ? `<p class="small" style="margin-top:12px"><b>Please check by hand:</b> ${v.manualChecks.map(h).join('; ')}</p>` : ''}
    ${!isClient && v.freelancerFeedback && v.verdict !== 'RELEASE' ? `<p class="small" style="margin-top:8px"><b>To get to 100%:</b> ${h(v.freelancerFeedback)}</p>` : ''}
    ${sub.fetched?.length ? `<p class="fetched">Verifier read: ${sub.fetched.map((f) => `${h(f.url)} ${f.ok ? '' : `(couldn't open: ${h(f.error)})`}`).join(', ')}</p>` : ''}
    ${isClient && m.status === 'SUBMITTED' ? `<div class="decide">
      <label for="pct-${m.id}">Release ${pct}% of this milestone <span class="hint">AI suggests ${rec}%</span></label>
      <div class="slider-row"><input id="pct-${m.id}" type="range" min="10" max="100" step="5" value="${pct}" data-pct="${m.id}"><span class="amount">${money((m.amount * pct) / 100, p.currency)}</span></div>
      <div class="actions">
        <button class="btn paid" data-action="release" data-m="${m.id}" ${state.busy['rel' + m.id] ? 'disabled' : ''}>${spin('rel' + m.id, `Release ${money((m.amount * pct) / 100, p.currency)}`, 'Capturing payment…')}</button>
        <button class="btn ghost" data-action="toggle" data-k="rev${m.id}">Ask for changes</button>
      </div>
      ${pct < 100 ? `<p class="small muted" style="margin-top:8px">The remaining ${money(m.amount - (m.amount * pct) / 100, p.currency)} hold is released back to you automatically.</p>` : ''}
      ${state.openForm['rev' + m.id] ? `<div class="field" style="margin-top:12px"><label for="rv-${m.id}">What should change?</label><textarea id="rv-${m.id}" rows="2" style="min-height:60px"></textarea><div class="actions"><button class="btn danger small" data-action="revise" data-m="${m.id}">Send back for changes</button></div></div>` : ''}
    </div>` : ''}
  </div>`;
}

function conversation(p) {
  const isClient = state.role === 'client';
  const msgs = p.messages || [];
  const label = { IN_SCOPE: 'Covered by the agreement', CLARIFICATION: 'Clarification, no new work', OUT_OF_SCOPE: 'New work — not in the agreement', OTHER: 'General message' };
  return `<div class="panel">
    <h3>Messages</h3>
    <p class="small muted" style="margin:4px 0 0">${isClient ? 'Ask questions or request changes here.' : 'Scope Guard reviews each client request against the agreement.'}</p>
    <div class="thread">${msgs.length ? msgs.map((msg) => {
      const a = msg.analysis;
      let guard = '';
      if (a && !isClient) {
        const co = a.changeOrder;
        guard = `<div class="guard ${a.classification}"><b>${label[a.classification]}</b>${h(a.reasoning)}`;
        if (co && !msg.changeOrder) {
          guard += `<table class="co-items"><tbody>${co.items.map((it, i) => `<tr><td>${h(it.name)}</td><td style="width:60px"><input aria-label="Quantity" type="number" step="0.5" value="${it.quantity}" data-co="${msg.id}" data-i="${i}" data-k="quantity"></td><td style="width:78px"><input aria-label="Unit price" type="number" step="1" value="${it.unitAmount}" data-co="${msg.id}" data-i="${i}" data-k="unitAmount"></td></tr>`).join('')}</tbody></table>
          <label for="rp-${msg.id}" class="small">Reply to send</label><textarea id="rp-${msg.id}" rows="3" style="min-height:70px;font-size:0.9rem">${h(a.suggestedReply)}</textarea>
          <div class="actions"><button class="btn small" data-action="change-order" data-msg="${msg.id}" ${state.busy['co' + msg.id] ? 'disabled' : ''}>${spin('co' + msg.id, `Send ${money(co.total, p.currency)} invoice via PayPal`, 'Sending invoice…')}</button></div>`;
        } else if (a.suggestedReply && !msg.changeOrder && a.classification !== 'OUT_OF_SCOPE') {
          guard += `<div class="small muted" style="margin-top:6px">Suggested reply: “${h(a.suggestedReply)}”</div>`;
        }
        guard += `</div>`;
      }
      const co = msg.changeOrder ? `<div class="guard OUT_OF_SCOPE"><b>Change order ${money(msg.changeOrder.total, p.currency)} — ${h(String(msg.changeOrder.status).toLowerCase())}</b>${msg.changeOrder.url ? `<a href="${h(msg.changeOrder.url)}" target="_blank" rel="noopener">${isClient ? 'Review and pay on PayPal' : 'View invoice on PayPal'}</a>` : `Invoice ${h(msg.changeOrder.invoiceId)}`}</div>` : '';
      return `<div class="msg ${msg.from}"><div class="who">${msg.from === 'client' ? h(p.client.name) : h(p.freelancer.name)} — ${dateTime(msg.at)}</div>${h(msg.text)}${guard}${co}</div>`;
    }).join('') : `<p class="small muted">No messages yet.</p>`}</div>
    <form class="compose" data-compose>
      <label for="compose" class="small">${isClient ? `Message ${h(p.freelancer.name)}` : `Message ${h(p.client.name)}`}</label>
      <textarea id="compose" name="text" placeholder="${isClient ? 'Could you also add…' : 'Write a message…'}"></textarea>
      <div class="actions"><button class="btn small" type="submit" ${state.busy.msg ? 'disabled' : ''}>${spin('msg', 'Send message', isClient ? 'Sending…' : 'Sending…')}</button></div>
    </form>
  </div>`;
}

function activity(p) {
  return `<div class="panel"><h3>Activity</h3><ol class="timeline" reversed>${(p.timeline || []).map((e) => `<li><time datetime="${e.at}">${dateTime(e.at)}</time>${h(e.text)}</li>`).join('')}</ol></div>`;
}

// ------------------------------------------------------------------ PayPal JS SDK
let sdkPromise = null;
function loadPayPalSdk(currency) {
  if (sdkPromise && sdkPromise.currency === currency) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    document.querySelectorAll('script[data-pp-sdk]').forEach((s) => s.remove());
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.config.paypalClientId)}&currency=${currency}&intent=authorize&components=buttons`;
    s.dataset.ppSdk = '1';
    s.onload = () => resolve(window.paypal);
    s.onerror = () => reject(new Error('Could not load PayPal. Check your connection or ad blocker.'));
    document.head.appendChild(s);
  });
  sdkPromise.currency = currency;
  return sdkPromise;
}
async function mountPayPalButtons() {
  const slots = document.querySelectorAll('.pp-slot');
  if (!slots.length) return;
  const p = state.project;
  try {
    const paypal = await loadPayPalSdk(p.currency);
    slots.forEach((slot) => {
      const mid = slot.dataset.m;
      paypal.Buttons({
        style: { layout: 'vertical', shape: 'rect', label: 'paypal' },
        createOrder: async () => (await api('POST', `/api/projects/${p.id}/milestones/${mid}/order?t=${state.token}`)).id,
        onApprove: async (data) => {
          slot.innerHTML = '<div class="thinking"><span class="spinner"></span>Placing the hold…</div>';
          try {
            await api('POST', `/api/projects/${p.id}/milestones/${mid}/authorize?t=${state.token}`, { orderID: data.orderID });
            toast('Funds are on hold. You will only be charged when you release them.');
          } catch (e) { toast(e.message, true); }
          await reload();
        },
        onCancel: () => toast('PayPal window closed. Nothing was held.'),
        onError: (err) => toast(err?.message || 'PayPal could not start the payment.', true),
      }).render(slot);
    });
  } catch (e) {
    slots.forEach((s) => (s.innerHTML = `<p class="error-box">${h(e.message)}</p>`));
  }
}

// ------------------------------------------------------------------ actions
async function reload() {
  const p = state.project;
  state.project = state.role === 'client' ? await api('GET', `/api/client/${p.id}?t=${state.token}`) : await api('GET', `/api/projects/${p.id}`);
  state.sig = signature(state.project);
  viewProject();
}
const q = () => (state.role === 'client' ? `?t=${state.token}` : '');

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const p = state.project;
  const mid = el.dataset.m;

  if (a === 'sample') {
    const f = document.getElementById('newForm');
    f.brief.value = SAMPLE.brief; f.budget.value = SAMPLE.budget; f.deadlineDays.value = SAMPLE.deadlineDays;
    f.clientName.value = SAMPLE.clientName; f.yourName.value = SAMPLE.yourName;
    f.clientEmail.focus();
    toast('Sample filled in. Add a client email (your sandbox personal account works) to continue.');
  }
  if (a === 'add-ms') { syncPlanInputs(); state.draft.plan.milestones.push({ title: 'New milestone', description: '', amount: 0, dueInDays: 7, criteria: [] }); viewPlan(); }
  if (a === 'rm-ms') { syncPlanInputs(); state.draft.plan.milestones.splice(Number(el.dataset.i), 1); viewPlan(); }
  if (a === 'discard') { sessionStorage.removeItem('mp-draft'); state.draft = null; location.hash = '#/'; }
  if (a === 'save-plan') {
    syncPlanInputs();
    const { plan, inputs } = state.draft;
    if (plan.milestones.some((m) => !(m.amount > 0) || !m.criteria.length)) return toast('Every milestone needs an amount and at least one acceptance criterion.', true);
    await withBusy('save', async () => {
      const project = await api('POST', '/api/projects', { plan, brief: inputs.brief, currency: inputs.currency, freelancer: { name: inputs.yourName || 'Freelancer' }, client: { name: inputs.clientName || 'Client', email: inputs.clientEmail } });
      sessionStorage.removeItem('mp-draft'); state.draft = null;
      location.hash = `#/p/${project.id}`;
      toast('Agreement created. Send the client link so they can fund the first milestone.');
    });
  }
  if (a === 'copy') { navigator.clipboard?.writeText(el.dataset.v); toast('Client link copied.'); }
  if (a === 'toggle') { state.openForm[el.dataset.k] = !state.openForm[el.dataset.k]; viewProject(); }
  if (a === 'open-form') { state.openForm[mid] = true; viewProject(); }
  if (a === 'sim-fund') {
    await withBusy('fund' + mid, async () => {
      const o = await api('POST', `/api/projects/${p.id}/milestones/${mid}/order${q()}`);
      await api('POST', `/api/projects/${p.id}/milestones/${mid}/authorize${q()}`, { orderID: o.id });
      await reload();
      toast('Funds are on hold (simulated).');
    });
  }
  if (a === 'release') {
    const pct = state.openForm['pct' + mid] ?? p.milestones.find((m) => m.id === mid).submissions.at(-1).verification.recommendedReleasePercent ?? 100;
    await withBusy('rel' + mid, async () => {
      const m = await api('POST', `/api/projects/${p.id}/milestones/${mid}/release${q()}`, { percent: pct || 100 });
      await reload();
      toast(`${money(m.released, p.currency)} released to ${p.freelancer.name}.`);
    });
  }
  if (a === 'revise') {
    const note = document.getElementById('rv-' + mid)?.value || '';
    await withBusy('rev' + mid, async () => {
      await api('POST', `/api/projects/${p.id}/milestones/${mid}/revision${q()}`, { note });
      state.openForm['rev' + mid] = false;
      await reload();
      toast('Sent back for changes. The funds stay on hold.');
    });
  }
  if (a === 'void') {
    await withBusy('void' + mid, async () => {
      await api('POST', `/api/projects/${p.id}/milestones/${mid}/void`);
      state.openForm['void' + mid] = false;
      await reload();
      toast('Hold returned to the client.');
    });
  }
  if (a === 'reauth') {
    await withBusy('reauth' + mid, async () => { await api('POST', `/api/projects/${p.id}/milestones/${mid}/reauthorize`); await reload(); toast('Hold refreshed for another period.'); });
  }
  if (a === 'change-order') {
    const msgId = el.dataset.msg;
    const msg = p.messages.find((x) => x.id === msgId);
    const items = msg.analysis.changeOrder.items.map((it, i) => ({
      ...it,
      quantity: Number(document.querySelector(`[data-co="${msgId}"][data-i="${i}"][data-k="quantity"]`)?.value || it.quantity),
      unitAmount: Number(document.querySelector(`[data-co="${msgId}"][data-i="${i}"][data-k="unitAmount"]`)?.value || it.unitAmount),
    }));
    const reply = document.getElementById('rp-' + msgId)?.value;
    await withBusy('co' + msgId, async () => {
      await api('POST', `/api/projects/${p.id}/messages/${msgId}/change-order`, { changeOrder: { items }, reply });
      await reload();
      toast('Change-order invoice sent through PayPal.');
    });
  }
});

$app.addEventListener('input', (e) => {
  if (e.target.dataset.pct) {
    const mid = e.target.dataset.pct;
    state.openForm['pct' + mid] = Number(e.target.value);
    const m = state.project.milestones.find((x) => x.id === mid);
    const row = e.target.closest('.decide');
    const amt = money((m.amount * e.target.value) / 100, state.project.currency);
    row.querySelector('label').firstChild.textContent = `Release ${e.target.value}% of this milestone `;
    row.querySelector('.slider-row .amount').textContent = amt;
    row.querySelector('[data-action=release]').textContent = `Release ${amt}`;
  }
});
$app.addEventListener('change', async (e) => {
  const mid = e.target.dataset.upload;
  if (!mid) return;
  const files = [...e.target.files].slice(0, 3);
  state.uploads[mid] = await Promise.all(files.map(shrinkImage));
  const form = e.target.closest('form');
  const notes = form.notes.value, links = form.links.value;
  viewProject();
  const f2 = document.querySelector(`[data-submit="${mid}"]`);
  if (f2) { f2.notes.value = notes; f2.links.value = links; }
});
$app.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.dataset.submit) {
    e.preventDefault();
    const mid = form.dataset.submit;
    const body = { notes: form.notes.value, links: form.links.value, images: state.uploads[mid] || [] };
    if (!body.notes.trim() && !body.links.trim() && !body.images.length) return toast('Add notes, a link or a screenshot so the verifier has something to check.', true);
    await withBusy('submit' + mid, async () => {
      await api('POST', `/api/projects/${state.project.id}/milestones/${mid}/submit`, body);
      state.uploads[mid] = []; state.openForm[mid] = false; state.justVerified = mid;
      await reload();
      document.getElementById('m-' + mid)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => (state.justVerified = null), 1500);
    });
  }
  if (form.dataset.compose !== undefined) {
    e.preventDefault();
    const text = form.text.value.trim();
    if (!text) return;
    await withBusy('msg', async () => {
      await api('POST', `/api/projects/${state.project.id}/messages${q()}`, { from: state.role, text });
      await reload();
    });
  }
});

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Light polling so freelancer and client tabs stay in sync (webhooks also land in the activity log).
function signature(p) { return JSON.stringify([p.status, p.milestones.map((m) => [m.status, m.submissions.length]), (p.messages || []).length, (p.messages || []).map((m) => m.changeOrder?.status), (p.timeline || []).length]); }
setInterval(async () => {
  if (!state.project || document.hidden || Object.values(state.busy).some(Boolean)) return;
  const ae = document.activeElement;
  if (ae && ['TEXTAREA', 'INPUT'].includes(ae.tagName)) return;
  if ([...document.querySelectorAll('#app textarea')].some((t) => t.value.trim() && !t.closest('.guard'))) return;
  try {
    const p = state.project;
    const fresh = state.role === 'client' ? await api('GET', `/api/client/${p.id}?t=${state.token}`) : await api('GET', `/api/projects/${p.id}`);
    const sig = signature(fresh);
    if (sig !== state.sig) { state.project = fresh; state.sig = sig; viewProject(); }
  } catch {}
}, 6000);

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    state.config = await api('GET', '/api/config');
  } catch {
    state.config = { paypalMode: 'mock', aiMode: 'mock', defaultCurrency: 'USD' };
  }
  const c = state.config;
  document.getElementById('modes').innerHTML =
    `<span class="mode ${c.paypalMode === 'mock' ? 'mock' : 'live'}">PayPal ${c.paypalMode === 'mock' ? 'simulated' : c.paypalMode}</span>` +
    `<span class="mode ${c.aiMode === 'mock' ? 'mock' : 'live'}">AI ${c.aiMode === 'mock' ? 'simulated' : h(c.aiMode)}</span>`;
  route();
})();
