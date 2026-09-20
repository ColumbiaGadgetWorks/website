// Class and event mailing list, mounted by src/index.js (Cloudflare Worker):
//   POST /api/subscribe    add an address
//   GET  /api/subscribers  export the list as CSV
//
// Bindings (Workers & Pages -> website -> Settings):
//   SUBSCRIBERS              (KV namespace, required) - the list itself
//   TURNSTILE_SECRET         (secret, optional)       - same widget as the contact form
//   SUBSCRIBERS_EXPORT_TOKEN (secret, required for export) - without it the export 404s
//   DISCORD_SIGNUP_WEBHOOK_URL (secret, optional)     - ping on signup, falls back to
//                                                       DISCORD_WEBHOOK_URL
//
// Rollout order matters exactly as it does for the contact form: deploy
// params.turnstileSiteKey in hugo.toml FIRST, then add TURNSTILE_SECRET. With the
// secret set but no widget on the page, no token is sent and every signup is
// rejected with ?subscribe=captcha.
//
// Keys are `sub:<lowercased email>` so signing up twice updates one record
// instead of creating a duplicate.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNUPS_PER_HOUR = 5;

export async function handleSubscribe(request, env) {
  const ct = request.headers.get('content-type') || '';
  let data;
  try {
    if (ct.includes('application/json')) data = await request.json();
    else data = Object.fromEntries((await request.formData()).entries());
  } catch {
    return done(request, '/classes/?subscribe=error', 400, 'Could not read the form');
  }

  const email = (data.email || '').toString().trim().slice(0, 200);
  const name = (data.name || '').toString().trim().slice(0, 120);
  const honeypot = (data.website || '').toString();
  const consent = (data.consent || '').toString();
  const redirect = safeRedirect(data.redirect);

  if (honeypot) return done(request, redirect, 200); // bot: pretend success
  if (!EMAIL_RE.test(email))
    return done(request, '/classes/?subscribe=invalid', 400, 'That does not look like an email address');
  if (!consent)
    return done(request, '/classes/?subscribe=consent', 400, 'Consent box not ticked');

  if (env.TURNSTILE_SECRET) {
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: data['cf-turnstile-response'],
        remoteip: request.headers.get('CF-Connecting-IP'),
      }),
    }).then(r => r.json()).catch(() => ({ success: false }));
    if (!v.success) return done(request, '/classes/?subscribe=captcha', 400, 'Captcha failed');
  }

  if (!env.SUBSCRIBERS)
    return done(request, '/classes/?subscribe=config', 500, 'Mailing list is not configured');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env.SUBSCRIBERS, ip))
    return done(request, '/classes/?subscribe=slow', 429, 'Too many signups from this connection');

  const key = `sub:${email.toLowerCase()}`;
  const existing = await env.SUBSCRIBERS.get(key, { type: 'json' }).catch(() => null);
  const now = new Date().toISOString();
  const record = {
    email,
    name,
    subscribed: (existing && existing.subscribed) || now,
    updated: now,
    source: (data.source || 'website').toString().slice(0, 60),
    country: request.headers.get('CF-IPCountry') || '',
  };
  await env.SUBSCRIBERS.put(key, JSON.stringify(record));
  if (!existing) await ping(env, record);

  return done(request, redirect, 200);
}

export async function handleExport(request, env) {
  // With no token configured the endpoint does not exist, so the list cannot
  // leak through a half-finished setup.
  if (!env.SUBSCRIBERS_EXPORT_TOKEN || !env.SUBSCRIBERS)
    return new Response('Not found', { status: 404 });

  const url = new URL(request.url);
  const given = url.searchParams.get('token') || bearer(request);
  if (!timingSafeEqual(given || '', env.SUBSCRIBERS_EXPORT_TOKEN))
    return new Response('Not found', { status: 404 });

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
    'email,name,subscribed,updated,source,country',
    ...rows.map(r => [r.email, r.name, r.subscribed, r.updated, r.source, r.country].map(cell).join(',')),
  ].join('\n');

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="cgw-subscribers.csv"',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

// Coarse throttle so one script cannot stuff the list.
async function isRateLimited(kv, ip) {
  const key = `rl:${ip}`;
  const n = parseInt((await kv.get(key)) || '0', 10);
  if (n >= SIGNUPS_PER_HOUR) return true;
  await kv.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}

async function ping(env, record) {
  const url = env.DISCORD_SIGNUP_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  const who = record.name ? `${record.name} <${record.email}>` : record.email;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'Class and event list',
      embeds: [{
        title: 'New email signup',
        color: 0xBF4D28,
        fields: [{ name: 'Address', value: who }],
        timestamp: record.subscribed,
      }],
    }),
  }).catch(() => {}); // a failed ping must not fail the signup
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function cell(v) {
  const s = (v === null || v === undefined) ? '' : v.toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Compare without leaking length or position through timing.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function safeRedirect(v) {
  const s = (v || '/classes/?subscribe=ok').toString();
  return s.startsWith('/') && !s.startsWith('//') ? s : '/classes/?subscribe=ok';
}

function done(request, redirect, status, error) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  if (wantsJson) return Response.json(error ? { ok: false, error } : { ok: true }, { status });
  return Response.redirect(new URL(redirect, request.url).toString(), 303);
}
