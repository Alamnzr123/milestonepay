// MilestonePay — AI-verified milestone payments on PayPal.
// Zero-dependency Node.js (>=18) server: `node server.js`
require('./lib/env').loadEnv();

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const paypal = require('./lib/paypal');
const gemini = require('./lib/gemini');
const ai = require('./lib/ai');
const { fetchLinks } = require('./lib/fetcher');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024; // screenshots are sent as base64
const HONOR_DAYS = 3;

// ------------------------------------------------------------------ tiny router
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const must = (cond, status, msg) => { if (!cond) throw new HttpError(status, msg); };

// ------------------------------------------------------------------ helpers
const now = () => new Date().toISOString();
const addDays = (iso, d) => new Date(new Date(iso).getTime() + d * 864e5).toISOString();
const fmt = (p, n) => `${Number(n).toFixed(2)} ${p.currency}`;

function loadProject(pid) {
  const p = store.getProject(pid);
  must(p, 404, 'Project not found');
  return p;
}
function loadMilestone(pid, mid) {
  const { project, milestone } = store.findMilestone(pid, mid);
  must(project, 404, 'Project not found');
  must(milestone, 404, 'Milestone not found');
  return { project, milestone };
}
function requireClient(project, query) {
  must(query.get('t') === project.clientToken, 403, 'Invalid client link');
}
function refreshProjectStatus(project) {
  const done = project.milestones.every((m) => ['RELEASED', 'PARTIAL', 'VOIDED'].includes(m.status));
  if (done && project.status !== 'COMPLETED') {
    project.status = 'COMPLETED';
    store.log(project, 'project', 'All milestones settled — project completed 🎉');
  } else if (!done && project.milestones.some((m) => m.status !== 'PLANNED')) {
    project.status = 'ACTIVE';
  }
}
function clientView(project) {
  const { clientToken, ...rest } = project;
  return {
    ...rest,
    messages: (project.messages || []).map((m) => ({ ...m, analysis: m.analysis && { classification: m.analysis.classification, reasoning: m.analysis.reasoning } })),
  };
}

// ------------------------------------------------------------------ config & projects
route('GET', '/api/config', async () => ({
  paypalMode: paypal.mode(),
  paypalClientId: paypal.MOCK ? null : paypal.CLIENT_ID,
  aiMode: gemini.mode(),
  defaultCurrency: process.env.DEFAULT_CURRENCY || 'USD',
}));

route('GET', '/api/projects', async () => store.listProjects().map((p) => ({
  id: p.id, title: p.title, status: p.status, currency: p.currency, budget: p.budget, createdAt: p.createdAt,
  client: p.client, milestones: p.milestones.map((m) => ({ status: m.status, amount: m.amount, released: m.released || 0 })),
  clientToken: p.clientToken,
})));

// Step 1 — AI Planner: brief → milestones (draft, not saved)
route('POST', '/api/plan', async ({ body }) => {
  const brief = String(body.brief || '').trim();
  const budget = Number(body.budget);
  must(brief.length >= 20, 400, 'Brief is too short — paste the full client brief or chat.');
  must(budget > 0, 400, 'Budget must be a positive number');
  return ai.planMilestones({ brief: brief.slice(0, 12000), budget, currency: body.currency || 'USD', deadlineDays: Number(body.deadlineDays) || null });
});

// Step 2 — save the agreed plan as a project
route('POST', '/api/projects', async ({ body }) => {
  const { plan = {}, freelancer = {}, client = {} } = body;
  must(plan.milestones && plan.milestones.length, 400, 'Plan has no milestones');
  must(client.email, 400, 'Client email is required');
  const budget = +plan.milestones.reduce((s, m) => s + Number(m.amount), 0).toFixed(2);
  const project = {
    id: store.id('prj'),
    clientToken: store.token(),
    title: String(plan.projectTitle || 'Untitled project').slice(0, 120),
    summary: plan.summary || '',
    brief: String(body.brief || '').slice(0, 12000),
    currency: body.currency || 'USD',
    budget,
    hourlyRate: Number(body.hourlyRate) || null,
    freelancer: { name: freelancer.name || 'Freelancer', email: freelancer.email || '' },
    client: { name: client.name || 'Client', email: client.email },
    assumptions: plan.assumptions || [],
    outOfScope: plan.outOfScope || [],
    status: 'SENT',
    createdAt: now(),
    milestones: plan.milestones.map((m, idx) => ({
      id: store.id('ms'), idx,
      title: String(m.title).slice(0, 120),
      description: String(m.description || ''),
      amount: Number(m.amount),
      dueInDays: Number(m.dueInDays) || null,
      deliverableType: m.deliverableType || 'other',
      criteria: (m.criteria || []).map(String).filter(Boolean),
      status: 'PLANNED',
      submissions: [], captures: [],
    })),
    messages: [],
    timeline: [],
  };
  store.addProject(project);
  store.log(project, 'project', `Project created with ${project.milestones.length} AI-planned milestones (${fmt(project, budget)})`);
  return project;
});

route('GET', '/api/projects/:pid', async ({ params }) => loadProject(params.pid));

route('GET', '/api/client/:pid', async ({ params, query }) => {
  const p = loadProject(params.pid);
  requireClient(p, query);
  return clientView(p);
});

// ------------------------------------------------------------------ PayPal: fund (authorize = hold)
route('POST', '/api/projects/:pid/milestones/:mid/order', async ({ params, query }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  requireClient(project, query);
  must(milestone.status === 'PLANNED', 409, `Milestone is already ${milestone.status}`);
  const order = await paypal.createAuthorizeOrder({ projectId: project.id, milestone, currency: project.currency, projectTitle: project.title });
  milestone.orderId = order.id;
  store.save();
  return { id: order.id, mock: !!order.mock };
});

route('POST', '/api/projects/:pid/milestones/:mid/authorize', async ({ params, query, body }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  requireClient(project, query);
  must(milestone.status === 'PLANNED', 409, `Milestone is already ${milestone.status}`);
  must(body.orderID && body.orderID === milestone.orderId, 400, 'Order mismatch');
  const { authorization, payer } = await paypal.authorizeOrder(body.orderID);
  Object.assign(milestone, {
    status: 'FUNDED',
    authorizationId: authorization.id,
    authorizedAt: now(),
    honorExpiresAt: addDays(now(), HONOR_DAYS),
    authExpiresAt: authorization.expiration_time || addDays(now(), 29),
  });
  if (payer?.email_address) project.client.paypalEmail = payer.email_address;
  refreshProjectStatus(project);
  store.log(project, 'payment', `💰 ${fmt(project, milestone.amount)} held for "${milestone.title}" (PayPal authorization ${authorization.id})`, { authorizationId: authorization.id });
  return milestone;
});

// ------------------------------------------------------------------ AI: submit & verify
route('POST', '/api/projects/:pid/milestones/:mid/submit', async ({ params, body }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  must(['FUNDED', 'REVISION', 'SUBMITTED'].includes(milestone.status), 409, 'Milestone must be funded before submitting work');
  const links = (Array.isArray(body.links) ? body.links : String(body.links || '').split(/[\s,]+/))
    .map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)).slice(0, 4);
  const images = (body.images || []).slice(0, 3).map((d) => {
    const m = String(d).match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    return m ? { mimeType: m[1], data: m[2] } : null;
  }).filter(Boolean);
  const submission = { id: store.id('sub'), at: now(), notes: String(body.notes || '').slice(0, 6000), links, screenshots: images.length };
  must(submission.notes || links.length || images.length, 400, 'Add notes, a link or a screenshot');

  const fetched = await fetchLinks(links);
  submission.fetched = fetched.map((f) => ({ url: f.url, ok: f.ok, error: f.error, chars: (f.text || '').length }));
  submission.verification = await ai.verifyDeliverable({ project, milestone, submission, fetched, images });
  milestone.submissions.push(submission);
  milestone.status = 'SUBMITTED';
  const v = submission.verification;
  store.log(project, 'ai', `🤖 AI Verifier scored "${milestone.title}" ${v.score}/100 → ${v.verdict} (recommends releasing ${v.recommendedReleasePercent}%)`);
  return { milestone, submission };
});

// ------------------------------------------------------------------ PayPal: release (capture) / revise / void / reauthorize
route('POST', '/api/projects/:pid/milestones/:mid/release', async ({ params, query, body }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  requireClient(project, query);
  must(['FUNDED', 'SUBMITTED', 'REVISION'].includes(milestone.status), 409, `Cannot release a ${milestone.status} milestone`);
  const pct = Math.max(1, Math.min(100, Math.round(Number(body.percent) || 100)));
  const amount = +((milestone.amount * pct) / 100).toFixed(2);
  const capture = await paypal.captureAuthorization(milestone.authorizationId, project.currency, amount, `${project.title} — ${milestone.title}`);
  milestone.captures.push({ id: capture.id, amount, at: now(), status: capture.status });
  milestone.released = amount;
  milestone.status = pct === 100 ? 'RELEASED' : 'PARTIAL';
  milestone.releasedAt = now();
  store.log(project, 'payment', pct === 100
    ? `✅ ${fmt(project, amount)} released to ${project.freelancer.name} for "${milestone.title}" (capture ${capture.id})`
    : `⚖️ Partial release: ${fmt(project, amount)} (${pct}%) for "${milestone.title}"; remaining hold voided automatically (capture ${capture.id})`, { captureId: capture.id });
  refreshProjectStatus(project);
  return milestone;
});

route('POST', '/api/projects/:pid/milestones/:mid/revision', async ({ params, query, body }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  requireClient(project, query);
  must(milestone.status === 'SUBMITTED', 409, 'Nothing to send back');
  milestone.status = 'REVISION';
  milestone.revisionNote = String(body.note || '').slice(0, 2000);
  store.log(project, 'review', `↩️ Client requested a revision on "${milestone.title}"${milestone.revisionNote ? `: “${milestone.revisionNote}”` : ''}`);
  return milestone;
});

// Only the freelancer can void a hold (gives the client their money back) — the client can't
// unilaterally pull funds after work has started. Real disputes go through PayPal's resolution center.
route('POST', '/api/projects/:pid/milestones/:mid/void', async ({ params }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  must(['FUNDED', 'SUBMITTED', 'REVISION'].includes(milestone.status), 409, 'Nothing is on hold');
  await paypal.voidAuthorization(milestone.authorizationId);
  milestone.status = 'VOIDED';
  store.log(project, 'payment', `🔓 Hold for "${milestone.title}" voided by freelancer — funds returned to client`);
  refreshProjectStatus(project);
  return milestone;
});

route('POST', '/api/projects/:pid/milestones/:mid/reauthorize', async ({ params }) => {
  const { project, milestone } = loadMilestone(params.pid, params.mid);
  must(['FUNDED', 'SUBMITTED', 'REVISION'].includes(milestone.status), 409, 'Nothing is on hold');
  must(!milestone.reauthorizedAt, 409, 'This hold was already re-authorized once');
  const auth = await paypal.reauthorize(milestone.authorizationId, project.currency, milestone.amount);
  Object.assign(milestone, {
    previousAuthorizationId: milestone.authorizationId,
    authorizationId: auth.id,
    reauthorizedAt: now(),
    honorExpiresAt: addDays(now(), HONOR_DAYS),
    authExpiresAt: auth.expiration_time || milestone.authExpiresAt,
  });
  store.log(project, 'payment', `🔁 Hold for "${milestone.title}" re-authorized (new authorization ${auth.id})`);
  return milestone;
});

// ------------------------------------------------------------------ AI Scope Guard + PayPal Invoicing change orders
route('POST', '/api/projects/:pid/messages', async ({ params, query, body }) => {
  const project = loadProject(params.pid);
  const from = body.from === 'client' ? 'client' : 'freelancer';
  if (from === 'client') requireClient(project, query);
  const text = String(body.text || '').trim().slice(0, 4000);
  must(text, 400, 'Empty message');
  const msg = { id: store.id('msg'), from, text, at: now() };
  if (from === 'client') {
    msg.analysis = await ai.analyzeMessage({ project, text });
    if (msg.analysis.classification === 'OUT_OF_SCOPE') {
      store.log(project, 'ai', `🛡️ Scope Guard flagged a new request as out of scope (≈${fmt(project, msg.analysis.changeOrder?.total || 0)} change order drafted)`);
    }
  }
  project.messages.push(msg);
  store.save();
  return from === 'client' ? clientView(project).messages.at(-1) : msg;
});

route('POST', '/api/projects/:pid/messages/:msgId/change-order', async ({ params, body }) => {
  const project = loadProject(params.pid);
  const msg = project.messages.find((m) => m.id === params.msgId);
  must(msg && msg.analysis && msg.analysis.changeOrder, 404, 'No change order on this message');
  must(!msg.changeOrder, 409, 'Change order already sent');
  const co = { ...msg.analysis.changeOrder, ...(body.changeOrder || {}) };
  co.items = (co.items || []).map((i) => ({ ...i, quantity: Number(i.quantity), unitAmount: Number(i.unitAmount) })).filter((i) => i.quantity > 0 && i.unitAmount > 0);
  must(co.items.length, 400, 'Change order needs at least one priced item');
  const total = +co.items.reduce((s, i) => s + i.quantity * i.unitAmount, 0).toFixed(2);
  const inv = await paypal.createAndSendInvoice({
    currency: project.currency,
    recipientEmail: project.client.paypalEmail || project.client.email,
    recipientName: project.client.name,
    freelancerName: project.freelancer.name,
    title: co.title,
    note: `${co.description}\n\nClient request: “${msg.text}”\n\nThis is outside the original agreement for “${project.title}”. Existing milestones are unchanged.`,
    items: co.items,
    reference: `${project.title} — change order`,
  });
  msg.changeOrder = { invoiceId: inv.id, status: inv.status, url: inv.url, total, sentAt: now(), mock: !!inv.mock };
  store.log(project, 'payment', `🧾 Change-order invoice ${inv.id} sent via PayPal Invoicing (${fmt(project, total)})`, { invoiceId: inv.id });
  if (body.reply) project.messages.push({ id: store.id('msg'), from: 'freelancer', text: String(body.reply).slice(0, 4000), at: now() });
  store.save();
  return msg;
});

// ------------------------------------------------------------------ PayPal webhooks
route('POST', '/api/webhooks/paypal', async ({ body, rawBody, headers }) => {
  let verification = { verified: false };
  try { verification = await paypal.verifyWebhook(headers, rawBody); } catch (e) { verification = { verified: false, reason: e.message }; }
  if (process.env.PAYPAL_WEBHOOK_ID && !verification.verified) throw new HttpError(400, 'Webhook signature verification failed');
  const r = body.resource || {};
  const type = body.event_type || '';
  const ref = r.supplementary_data?.related_ids?.authorization_id || r.supplementary_data?.related_ids?.order_id || r.id;
  if (type.startsWith('INVOICING.')) {
    const invoiceId = r.invoice?.id || r.id;
    const { project, message } = store.findByInvoice(invoiceId);
    if (project) {
      message.changeOrder.status = r.invoice?.status || r.status || type.split('.').pop();
      store.log(project, 'webhook', `📬 PayPal webhook ${type} for change order ${invoiceId}`);
    }
  } else {
    const { project, milestone } = store.findByOrderOrAuth(ref);
    if (project) store.log(project, 'webhook', `📬 PayPal webhook ${type} confirmed for "${milestone.title}"${verification.verified ? ' (signature verified)' : ''}`);
  }
  return { received: true };
});

// ------------------------------------------------------------------ http plumbing
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!match) return send(res, 404, { error: 'Not found' });
  try {
    const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : '';
    let body = {};
    if (rawBody) { try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, 'Invalid JSON'); } }
    const values = url.pathname.match(match.re).slice(1);
    const params = Object.fromEntries(match.keys.map((k, i) => [k, decodeURIComponent(values[i])]));
    const result = await match.handler({ params, query: url.searchParams, body, rawBody, headers: req.headers });
    send(res, 200, result);
  } catch (e) {
    const status = e.status && e.status < 600 ? (e instanceof paypal.PayPalError ? 502 : e.status) : 500;
    if (status >= 500) console.error('[error]', e.message, e.details ? JSON.stringify(e.details).slice(0, 800) : '');
    send(res, status, { error: e.message, debugId: e.debugId, details: e.details?.details });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  MilestonePay running → http://localhost:${PORT}`);
    console.log(`  PayPal: ${paypal.mode().toUpperCase()}   AI: ${gemini.mode()}`);
    if (paypal.MOCK) console.log('  ⚠  PAYPAL_CLIENT_ID/SECRET not set — running with simulated PayPal calls.');
    if (gemini.MOCK) console.log('  ⚠  GEMINI_API_KEY not set — running with heuristic mock AI.');
    console.log('');
  });
}

module.exports = server;
