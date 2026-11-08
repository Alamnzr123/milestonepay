// Fetches deliverable links so the Verifier can read them. Basic SSRF guard + size/time limits.
const dns = require('dns').promises;
const net = require('net');

const MAX_CHARS = 12000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

async function assertPublic(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) links are allowed');
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('private host');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('private address');
}

// GitHub repos: read the README and file list instead of the heavy HTML page.
function githubTargets(url) {
  const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  return [
    { label: 'README', url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md` },
    { label: 'Files', url: `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, json: true },
  ];
}

async function get(url, json) {
  await assertPublic(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'MilestonePay-Verifier/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.text()).slice(0, 400_000);
    if (json) {
      const data = JSON.parse(body);
      return (data.tree || []).map((f) => f.path).slice(0, 300).join('\n');
    }
    return /html/i.test(res.headers.get('content-type') || '') ? htmlToText(body) : body;
  } finally {
    clearTimeout(t);
  }
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(h[1-6]|p|li|br|div|section|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return `TITLE: ${title.trim()}\n${text}`;
}

async function fetchLinks(links = []) {
  const out = [];
  for (const url of links.slice(0, 4)) {
    try {
      const gh = githubTargets(url);
      if (gh) {
        const parts = [];
        for (const t of gh) {
          try { parts.push(`## ${t.label}\n${await get(t.url, t.json)}`); } catch (e) { parts.push(`## ${t.label}\n(unavailable: ${e.message})`); }
        }
        out.push({ url, ok: true, text: parts.join('\n\n').slice(0, MAX_CHARS) });
      } else {
        out.push({ url, ok: true, text: (await get(url)).slice(0, MAX_CHARS) });
      }
    } catch (e) {
      out.push({ url, ok: false, error: e.message, text: '' });
    }
  }
  return out;
}

module.exports = { fetchLinks, htmlToText, isPrivateIp };
