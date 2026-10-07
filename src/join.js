// Membership signup, mounted by src/index.js (Cloudflare Worker):
//   GET  /api/join/docs           the waiver and agreement text
//   POST /api/join/start          step 1: name, email, Discord, notifications
//   POST /api/join/status         where an applicant is in the signup
//   POST /api/join/sign           step 2: sign the waiver or the agreement
//   POST /api/join/id             step 2: upload the ID photo
//   POST /api/givebutter-webhook  Givebutter tells us about dues payments
//
// The Worker keeps nothing about applicants. Everything is forwarded to the
// onboarding module in Dolibarr (github.com/ColumbiaGadgetWorks/dolibarr-onboarding),
// which is the record of who has signed and who has paid.
//
// Secrets (Worker dashboard, Settings, Variables and Secrets):
//   DOLIBARR_URL      address of Dolibarr, no trailing slash. The Worker runs on
//                     Cloudflare, so this must be reachable from the internet
//                     (a public hostname or a Cloudflare Tunnel).
//   DOLIBARR_API_KEY  the "Key for the website" from the module's setup page.
//   GIVEBUTTER_WEBHOOK_SECRET  the signing secret Givebutter shows for the webhook.
//   TURNSTILE_SECRET  already used by the contact form; protects step 1 too.
// Without the first two, the join page says signup is unavailable and the
// membership page still links to Givebutter directly.

import { verifyTurnstile } from './turnstile.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const STARTS_PER_HOUR = 5;
const MAX_ID_BYTES = 6 * 1024 * 1024;

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (error, status) => json({ ok: false, error }, status);
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max);

export function joinConfigured(env) {
  return Boolean(env.DOLIBARR_URL && env.DOLIBARR_API_KEY);
}

async function dolibarr(env, action, body) {
  const url = `${env.DOLIBARR_URL.replace(/\/+$/, '')}/custom/onboarding/public/api.php?action=${action}`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Onboarding-Key': env.DOLIBARR_API_KEY },
      body: JSON.stringify(body || {}),
    });
  } catch {
    return { status: 502, data: { ok: false, error: 'unreachable' } };
  }
  let data;
  try {
    data = await r.json();
  } catch {
    return { status: 502, data: { ok: false, error: 'bad-answer' } };
  }
  // A wrong key or a disabled module is our misconfiguration, not the visitor's.
  if (r.status === 401 || r.status === 503) return { status: 502, data: { ok: false, error: 'config' } };
  return { status: r.status, data };
}

async function readJson(request, maxBytes) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return null;
  try {
    const text = await request.text();
    if (text.length > maxBytes) return null;
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export async function handleJoin(request, env, pathname) {
  if (!joinConfigured(env)) return fail('config', 503);
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (pathname === '/api/join/docs') {
    const r = await dolibarr(env, 'docs');
    return json(r.data, r.status);
  }
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });

  if (pathname === '/api/join/id') {
    // Base64 inflates the photo by a third. The page shrinks photos before sending.
    const data = await readJson(request, Math.ceil(MAX_ID_BYTES * 1.4));
    if (!data || !TOKEN_RE.test(str(data.token, 64))) return fail('token', 400);
    if (typeof data.data !== 'string' || data.data.length < 100) return fail('type', 400);
    const r = await dolibarr(env, 'id', { token: data.token, data: data.data });
    return json(r.data, r.status);
  }

  // Large enough for a drawn signature, which arrives as a base64 PNG.
  const data = await readJson(request, 400000);
  if (!data) return fail('invalid', 400);

  if (pathname === '/api/join/start') {
    if (str(data.website, 200)) return json({ ok: true, check_email: true }); // bot: pretend success
    const body = {
      firstname: str(data.firstname, 100),
      lastname: str(data.lastname, 100),
      email: str(data.email, 200),
      discord: str(data.discord, 100),
      notify_events: Boolean(data.notify_events),
      notify_news: Boolean(data.notify_news),
      ip,
    };
    if (!body.firstname || !body.lastname || !EMAIL_RE.test(body.email)) return fail('invalid', 400);
    const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'join');
    if (!ts.ok) return fail('captcha', 400);
    if (await isRateLimited(env, ip)) return fail('slow', 429);
    const r = await dolibarr(env, 'start', body);
    return json(r.data, r.status);
  }

  const token = str(data.token, 64);
  if (!TOKEN_RE.test(token)) return fail('token', 400);

  if (pathname === '/api/join/status') {
    const r = await dolibarr(env, 'status', { token });
    return json(r.data, r.status);
  }
  if (pathname === '/api/join/sign') {
    const r = await dolibarr(env, 'sign', {
      token,
      doc: str(data.doc, 20),
      name: str(data.name, 200),
      version: str(data.version, 64),
      signature: str(data.signature, 380000),
      ip,
    });
    return json(r.data, r.status);
  }
  return new Response('Not found', { status: 404 });
}

// Givebutter posts {event, data} with a Signature header carrying the webhook's
// signing secret. Accept that, or an HMAC-SHA256 of the body keyed with it, so a
// change on their side to proper signing does not break dues tracking.
export async function handleGivebutterWebhook(request, env) {
  if (!joinConfigured(env) || !env.GIVEBUTTER_WEBHOOK_SECRET) return new Response('Not configured', { status: 503 });
  const raw = await request.text();
  const given = request.headers.get('signature') || '';
  const secret = env.GIVEBUTTER_WEBHOOK_SECRET;
  const ok = timingSafeEqual(given, secret) || timingSafeEqual(given.toLowerCase(), await hmacHex(secret, raw));
  if (!ok) return new Response('Bad signature', { status: 401 });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  const r = await dolibarr(env, 'givebutter', { event: str(body.event, 64), data: body.data });
  // A non-2xx answer makes Givebutter show the delivery as failed, which is
  // what we want when Dolibarr could not be reached: the hourly sync covers it.
  return json(r.data, r.status);
}

async function isRateLimited(env, ip) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `rlj:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= STARTS_PER_HOUR) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
