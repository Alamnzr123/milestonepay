// Tiny JSON-file store. Good enough for a single-instance demo; swap for Postgres in production.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

let db = { projects: [] };

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.warn('[store] could not load db, starting fresh:', e.message);
    db = { projects: [] };
  }
}

let writeTimer = null;
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(db, null, 2));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) {
      console.warn('[store] write failed:', e.message);
    }
  }, 50);
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const token = () => crypto.randomBytes(16).toString('hex');

function listProjects() {
  return [...db.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function getProject(pid) {
  return db.projects.find((p) => p.id === pid) || null;
}
function addProject(p) {
  db.projects.push(p);
  save();
  return p;
}
function findMilestone(pid, mid) {
  const project = getProject(pid);
  if (!project) return {};
  return { project, milestone: project.milestones.find((m) => m.id === mid) || null };
}
function findByOrderOrAuth(ref) {
  for (const p of db.projects) {
    for (const m of p.milestones) {
      if (m.orderId === ref || m.authorizationId === ref || (m.captures || []).some((c) => c.id === ref)) {
        return { project: p, milestone: m };
      }
    }
  }
  return {};
}
function findByInvoice(invoiceId) {
  for (const p of db.projects) {
    const msg = (p.messages || []).find((m) => m.changeOrder && m.changeOrder.invoiceId === invoiceId);
    if (msg) return { project: p, message: msg };
  }
  return {};
}
function log(project, type, text, meta = {}) {
  project.timeline = project.timeline || [];
  project.timeline.unshift({ at: new Date().toISOString(), type, text, meta });
  save();
}

load();

module.exports = {
  id, token, save, log,
  listProjects, getProject, addProject, findMilestone, findByOrderOrAuth, findByInvoice,
};
