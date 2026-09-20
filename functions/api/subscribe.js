// Cloudflare Pages Function: POST /api/subscribe
// Adds an address to the class and event announcement list.
//
// Bindings (Pages -> Settings -> Bindings / Variables and secrets):
//   SUBSCRIBERS            (KV namespace, required) - the list itself
//   TURNSTILE_SECRET       (secret, optional)       - verifies the widget when
//                            params.turnstileSiteKey is also set in hugo.toml.
//                            Set BOTH or NEITHER: with the secret set but no
//                            site key deployed, no token is sent and every
//                            signup is rejected.
//   DISCORD_SIGNUP_WEBHOOK_URL (secret, optional)   - pings a channel on signup.
//                            Falls back to DISCORD_WEBHOOK_URL when unset.
//
// Keys are `sub:<lowercased email>` so re-subscribing overwrites rather than
// duplicating. Export with GET /api/subscribers (see subscribers.js).

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RATE_LIMIT_PER_HOUR = 5;

export async function onRequestPost({ request, env }) {
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
    return done(request, '/classes/?subscribe=consent', 400, 'Please tick the box to confirm you want these emails');

  if (env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET, data['cf-turnstile-response'], request);
    if (!ok) return done(request, '/classes/?subscribe=captcha', 400, 'Captcha failed');
  }

  if (!env.SUBSCRIBERS)
    return done(request, '/classes/?subscribe=error', 500, 'Mailing list is not configured');

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await isRateLimited(env.SUBSCRIBERS, ip))
    return done(request, '/classes/?subscribe=slow', 429, 'Too many signups from this connection, try later');

  const key = `sub:${email.toLowerCase()}`;
  const existing = await env.SUBSCRIBERS.get(key, { type: 'json' }).catch(() => null);

  const record = {
    email,
    name,
    subscribed: existing?.subscribed || new Date().toISOString(),
    updated: new Date().toISOString(),
    source: (data.source || 'website').toString().slice(0, 60),
    country: request.headers.get('CF-IPCountry') || '',
  };
  await env.SUBSCRIBERS.put(key, JSON.stringify(record));

  if (!existing) await ping(env, record);

  return done(request, redirect, 200);
}

export function onRequestGet() {
  return new Response('POST only', { status: 405 });
}

async function verifyTurnstile(secret, token, request) {
  if (!token) return false;
  const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      secret,
      response: token,
      remoteip: request.headers.get('CF-Connecting-IP'),
    }),
  }).then(r => r.json()).catch(() => ({ success: false }));
  return !!v.success;
}

// Coarse throttle: a short-lived counter per IP, so one script cannot stuff the list.
async function isRateLimited(kv, ip) {
  const key = `rl:${ip}`;
  const n = parseInt((await kv.get(key)) || '0', 10);
  if (n >= RATE_LIMIT_PER_HOUR) return true;
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

function safeRedirect(v) {
  const s = (v || '/classes/?subscribe=ok').toString();
  return s.startsWith('/') && !s.startsWith('//') ? s : '/classes/?subscribe=ok';
}

function done(request, redirect, status, error) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  if (wantsJson) return Response.json(error ? { ok: false, error } : { ok: true }, { status });
  return Response.redirect(new URL(redirect, request.url).toString(), 303);
}
