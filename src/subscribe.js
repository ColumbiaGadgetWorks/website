// Email updates signup, mounted by src/index.js (Cloudflare Worker):
//   POST /api/subscribe    add an address to the list
//   GET  /api/subscribers  export the list as CSV (optional, see below)
//
// Bindings:
//   SUBSCRIBERS  (KV namespace) - declared in wrangler.jsonc WITHOUT an id, so
//                Wrangler creates it automatically on the first deploy. Nothing
//                to set up by hand. It appears under Storage & Databases -> KV.
//   TURNSTILE_SECRET (secret, optional) - the same Turnstile widget as the
//                contact form. Add it only AFTER params.turnstileSiteKey has
//                deployed, or every signup is rejected.
//   SUBSCRIBERS_EXPORT_TOKEN (secret, optional) - enables the CSV export.
//                Without it the export returns 404. The addresses can always be
//                read in the dashboard instead: each key is `sub:<email>`.
//   DISCORD_SIGNUP_WEBHOOK_URL (secret, optional) - posts each new signup to a
//                Discord channel.

import { verifyTurnstile } from './turnstile.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNUPS_PER_HOUR = 5;

export async function handleSubscribe(request, env) {
  const ct = request.headers.get('content-type') || '';
  let data;
  try {
    if (ct.includes('application/json')) data = await request.json();
    else data = Object.fromEntries((await request.formData()).entries());
  } catch {
    return done(request, '/', 'error', 400, 'Could not read the form');
  }

  const back = safePath(data.back);
  const email = (data.email || '').toString().trim().slice(0, 200);
  const honeypot = (data.website || '').toString();

  if (honeypot) return done(request, back, 'ok', 200); // bot: pretend success
  if (!EMAIL_RE.test(email)) return done(request, back, 'invalid', 400, 'Invalid email address');

  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'subscribe');
  if (!ts.ok) return done(request, back, 'captcha', 400, 'Captcha failed');

  if (!env.SUBSCRIBERS) return done(request, back, 'error', 500, 'Mailing list is not configured');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env.SUBSCRIBERS, ip)) return done(request, back, 'slow', 429, 'Too many signups');

  // Keyed by lowercased email, so signing up twice updates one record.
  const key = `sub:${email.toLowerCase()}`;
  const existing = await env.SUBSCRIBERS.get(key, { type: 'json' }).catch(() => null);
  const now = new Date().toISOString();
  const record = {
    email,
    subscribed: (existing && existing.subscribed) || now,
    updated: now,
    page: back,
    country: request.headers.get('CF-IPCountry') || '',
  };
  await env.SUBSCRIBERS.put(key, JSON.stringify(record));
  if (!existing) await ping(env, record);

  return done(request, back, 'ok', 200);
}

export async function handleExport(request, env) {
  if (!env.SUBSCRIBERS_EXPORT_TOKEN || !env.SUBSCRIBERS) return new Response('Not found', { status: 404 });
  const given = new URL(request.url).searchParams.get('token') || bearer(request);
  if (!timingSafeEqual(given || '', env.SUBSCRIBERS_EXPORT_TOKEN)) return new Response('Not found', { status: 404 });

  const rows = [];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const rec = await env.SUBSCRIBERS.get(k.name, { type: 'json' }).catch(() => null);
      if (rec) rows.push(rec);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  rows.sort((a, b) => (a.subscribed || '').localeCompare(b.subscribed || ''));
  const csv = [
    'email,subscribed,updated,page,country',
    ...rows.map(r => [r.email, r.subscribed, r.updated, r.page, r.country].map(cell).join(',')),
  ].join('\n') + '\n';
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="cgw-subscribers.csv"',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

async function isRateLimited(kv, ip) {
  const key = `rl:${ip}`;
  const n = parseInt((await kv.get(key)) || '0', 10);
  if (n >= SIGNUPS_PER_HOUR) return true;
  await kv.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}

async function ping(env, record) {
  if (!env.DISCORD_SIGNUP_WEBHOOK_URL) return;
  await fetch(env.DISCORD_SIGNUP_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'Email updates',
      embeds: [{ title: 'New signup', color: 0xBF4D28, fields: [{ name: 'Address', value: record.email }], timestamp: record.subscribed }],
    }),
  }).catch(() => {}); // a failed ping must not fail the signup
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function cell(v) {
  const s = v === null || v === undefined ? '' : v.toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// Only same-site paths, so the redirect cannot be pointed at another domain.
function safePath(v) {
  const s = (v || '/').toString().split(/[?#]/)[0];
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

function done(request, back, status, code, error) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  if (wantsJson) return Response.json(error ? { ok: false, error } : { ok: true }, { status: code });
  return Response.redirect(new URL(`${back}?updates=${status}#updates`, request.url).toString(), 303);
}
