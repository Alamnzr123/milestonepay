// PayPal REST client (Orders v2 AUTHORIZE flow, Payments v2, Invoicing v2, Webhooks).
// Zero dependencies: uses Node's global fetch. Falls back to a clearly-labelled MOCK mode
// when PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, so the app can still be explored.
const crypto = require('crypto');

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const ENV = (process.env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase();
const BASE = process.env.PAYPAL_API_BASE || (ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const MOCK = !CLIENT_ID || !CLIENT_SECRET;

const mode = () => (MOCK ? 'mock' : ENV);

// ---------- auth ----------
let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new PayPalError('OAuth failed', res.status, data);
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

class PayPalError extends Error {
  constructor(message, status, details) {
    super(`${message}${details && details.message ? ': ' + details.message : ''}`);
    this.status = status;
    this.details = details;
    this.debugId = details && details.debug_id;
  }
}

async function call(method, path, body, extraHeaders = {}) {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(), // idempotency
      Prefer: 'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) throw new PayPalError(`PayPal ${method} ${path} failed (${res.status})`, res.status, data);
  return data;
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return { raw: t }; } };
const money = (currency, value) => ({ currency_code: currency, value: Number(value).toFixed(2) });

// ---------- mock helpers ----------
const mockId = (p) => `${p}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();

// ---------- Orders v2: create an AUTHORIZE order (funds held, not captured) ----------
async function createAuthorizeOrder({ projectId, milestone, currency, projectTitle }) {
  if (MOCK) return { id: mockId('MOCK-ORDER'), status: 'CREATED', mock: true };
  return call('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{
      reference_id: milestone.id,
      custom_id: `${projectId}:${milestone.id}`,
      description: `${projectTitle} — Milestone ${milestone.idx + 1}: ${milestone.title}`.slice(0, 127),
      soft_descriptor: 'MILESTONEPAY',
      amount: money(currency, milestone.amount),
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'MilestonePay',
          user_action: 'CONTINUE',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    },
  });
}

// Authorize an approved order → returns the authorization (id, status, expiration_time)
async function authorizeOrder(orderId) {
  if (MOCK) {
    return {
      orderId, mock: true,
      authorization: { id: mockId('MOCK-AUTH'), status: 'CREATED', expiration_time: inDays(29) },
      payer: { email_address: 'client@example.com', name: { given_name: 'Demo', surname: 'Client' } },
    };
  }
  const data = await call('POST', `/v2/checkout/orders/${orderId}/authorize`, {});
  const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new PayPalError('No authorization returned', 500, data);
  return { orderId, authorization: auth, payer: data.payer };
}

// Capture all or part of an authorization. final_capture=true voids any remainder.
async function captureAuthorization(authId, currency, amount, note) {
  if (MOCK) return { id: mockId('MOCK-CAP'), status: 'COMPLETED', amount: money(currency, amount), mock: true };
  return call('POST', `/v2/payments/authorizations/${authId}/capture`, {
    amount: money(currency, amount),
    final_capture: true,
    note_to_payer: (note || 'Milestone approved via MilestonePay').slice(0, 255),
  });
}

async function voidAuthorization(authId) {
  if (MOCK) return { status: 'VOIDED', mock: true };
  await call('POST', `/v2/payments/authorizations/${authId}/void`);
  return { status: 'VOIDED' };
}

// Re-authorize after the 3-day honor period (allowed up to day 29).
async function reauthorize(authId, currency, amount) {
  if (MOCK) return { id: mockId('MOCK-AUTH'), status: 'CREATED', expiration_time: inDays(29), mock: true };
  return call('POST', `/v2/payments/authorizations/${authId}/reauthorize`, { amount: money(currency, amount) });
}

// ---------- Invoicing v2: AI-drafted change orders ----------
async function createAndSendInvoice({ currency, recipientEmail, recipientName, freelancerName, title, note, items, reference }) {
  if (MOCK) {
    const id = mockId('MOCK-INV');
    return { id, status: 'SENT', url: `https://www.sandbox.paypal.com/invoice/p/#${id}`, mock: true };
  }
  const [given, ...rest] = String(recipientName || 'Client').split(' ');
  const inv = await call('POST', '/v2/invoicing/invoices', {
    detail: {
      currency_code: currency,
      reference: reference?.slice(0, 120),
      note: note?.slice(0, 4000),
      memo: 'Change order generated by MilestonePay AI scope guard',
      payment_term: { term_type: 'NET_10' },
    },
    invoicer: { business_name: (freelancerName || 'Freelancer').slice(0, 100) },
    primary_recipients: [{
      billing_info: {
        email_address: recipientEmail,
        name: { given_name: given || 'Client', surname: rest.join(' ') || undefined },
      },
    }],
    items: items.map((it) => ({
      name: it.name.slice(0, 200),
      description: (it.description || title || '').slice(0, 1000),
      quantity: String(it.quantity || 1),
      unit_amount: money(currency, it.unitAmount),
      unit_of_measure: it.unitOfMeasure || 'QUANTITY',
    })),
  });
  const id = inv.id || (inv.href || '').split('/').pop();
  await call('POST', `/v2/invoicing/invoices/${id}/send`, {
    send_to_recipient: true,
    send_to_invoicer: false,
    subject: `Change order: ${title}`.slice(0, 200),
  });
  const fresh = await call('GET', `/v2/invoicing/invoices/${id}`);
  return { id, status: fresh.status, url: fresh.detail?.metadata?.recipient_view_url || null };
}

// ---------- Webhooks ----------
async function verifyWebhook(headers, rawBody) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (MOCK || !webhookId) return { verified: false, reason: MOCK ? 'mock mode' : 'PAYPAL_WEBHOOK_ID not set' };
  const data = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: JSON.parse(rawBody),
  });
  return { verified: data.verification_status === 'SUCCESS' };
}

module.exports = {
  mode, MOCK, CLIENT_ID, ENV,
  createAuthorizeOrder, authorizeOrder, captureAuthorization, voidAuthorization, reauthorize,
  createAndSendInvoice, verifyWebhook, PayPalError,
};
