// Tool training, mounted by src/index.js (Cloudflare Worker).
//
// Dolibarr (the onboarding module, github.com/ColumbiaGadgetWorks/dolibarr-onboarding)
// holds the tools, trainers, bookings and training records. The Worker keeps its
// own copy of the public part, so the website keeps working while Dolibarr is down:
//
//   training:catalog   tools, prices, trainers' first names, weekly times, closed days.
//                      Dolibarr pushes it on every change (POST /api/training/sync);
//                      the cron pulls it every 15 minutes in case a push was lost.
//   tl:<hash>          the masked answer of "What am I trained on?" per person, keyed
//                      by an HMAC of the email (never the email), pushed by Dolibarr
//                      whenever a training is recorded. Used only when Dolibarr is down.
//
// Routes:
//   GET  /api/training/catalog        the copy above
//   GET  /api/training/slots?tool=ID  open sessions (asks Dolibarr; a minute of edge cache)
//   POST /api/training/trainee        {email, cf-turnstile-response} -> member/non-member/new,
//                                     what is left to sign, and a session for the next calls
//   POST /api/training/new            {session, firstname, lastname, discord, notify_*}
//   POST /api/training/signlink       {session}  emails the signing link
//   POST /api/training/book           {session, tool, slot, start} -> ref, key, amount
//   POST /api/training/status         {ref, key}  has the payment arrived
//   POST /api/training/notify         {email, cf-turnstile-response}  "tell me when booking is back"
//   POST /api/training/lookup         {email, cf-turnstile-response}  masked email and name, tools
//   GET  /api/training/class?c=CODE   what a group class code is for
//   POST /api/training/class          {code, email, firstname, lastname, session | cf-turnstile-response}
//   POST /api/training/sync           Dolibarr's push, header X-Onboarding-Key = DOLIBARR_API_KEY
//
// Anyone can type any email, so the first call of each flow is behind Turnstile and a
// per-IP limit, and the answer about a person is only what the page needs.

import { verifyTurnstile } from './turnstile.js';
import { dolibarr, joinConfigured } from './join.js';
import { occurrences } from './calendar.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SESSION_SECONDS = 2 * 3600;
const CATALOG_KEY = 'training:catalog';
const DOWN_KEY = 'training:down-since';
const NOTIFY_PREFIX = 'tn:';
const ALERT_PREFIX = 'training:alert:';

const json = (body, status = 200, cache = 'no-store') => Response.json(body, { status, headers: { 'cache-control': cache } });
const fail = (error, status) => json({ ok: false, error }, status);
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max);
const ipOf = (request) => request.headers.get('CF-Connecting-IP') || '';

async function readJson(request, max = 400000) {
  try {
    const text = await request.text();
    if (text.length > max) return null;
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
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

// A session ties the later calls of one booking (or class sign-in) to the email
// that passed Turnstile, without asking for Turnstile on every click.
async function makeSession(env, email) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const b64 = btoa(email).replace(/=+$/, '');
  return `${b64}.${exp}.${await hmacHex(env.DOLIBARR_API_KEY, `training:${email}:${exp}`)}`;
}

async function readSession(env, session) {
  const [b64, exp, sig] = String(session || '').split('.');
  if (!b64 || !exp || !sig || Number(exp) < Date.now() / 1000) return '';
  let email;
  try { email = atob(b64); } catch { return ''; }
  return timingSafeEqual(sig, await hmacHex(env.DOLIBARR_API_KEY, `training:${email}:${exp}`)) ? email : '';
}

async function isRateLimited(env, ip, prefix, limit) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `${prefix}:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= limit) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}

// Dolibarr unreachable, or answering with an error of its own making.
const isDown = (r) => r.status >= 500 || r.data?.error === 'unreachable' || r.data?.error === 'bad-answer';

function relay(r) {
  if (isDown(r)) return fail('unavailable', 503);
  return json(r.data, r.status);
}

// ---------------------------------------------------------------- routes

export async function handleTraining(request, env, ctx, pathname) {
  const route = pathname.replace(/^\/api\/training\//, '');
  if (route === 'sync') return handleSync(request, env);
  if (route === 'catalog') {
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });
    return json(await catalog(env), 200, 'public, max-age=60');
  }
  if (route === 'lookup') {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const data = await readJson(request, 5000);
    return data ? handleLookup(request, env, data, ipOf(request)) : fail('invalid', 400);
  }
  if (!joinConfigured(env)) return fail('config', 503);
  if (route === 'slots') return handleSlots(request, env, ctx);
  if (route === 'class' && request.method === 'GET') {
    const code = str(new URL(request.url).searchParams.get('c'), 20);
    if (!code) return fail('closed', 404);
    if (await isRateLimited(env, ipOf(request), 'rlc', 60)) return fail('slow', 429);
    return relay(await dolibarr(env, 'classinfo', { code }));
  }
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  const data = await readJson(request, 5000);
  if (!data) return fail('invalid', 400);
  const ip = ipOf(request);

  if (route === 'trainee') {
    const email = str(data.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) return fail('invalid', 400);
    const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'training-book');
    if (!ts.ok) return fail('captcha', 400);
    if (await isRateLimited(env, ip, 'rlb', 20)) return fail('slow', 429);
    const r = await dolibarr(env, 'trainee', { email });
    if (isDown(r)) return fail('unavailable', 503);
    if (!r.data?.ok) return json(r.data, r.status);
    return json({ ok: true, kind: r.data.kind, needs: r.data.needs || [], session: await makeSession(env, email) });
  }
  if (route === 'new' || route === 'signlink' || route === 'book') {
    const email = await readSession(env, data.session);
    if (!email) return fail('session', 401);
    if (route === 'new') {
      return relay(await dolibarr(env, 'traineenew', {
        email, ip,
        firstname: str(data.firstname, 50), lastname: str(data.lastname, 50), discord: str(data.discord, 100),
        notify_events: Boolean(data.notify_events), notify_news: Boolean(data.notify_news),
      }));
    }
    if (route === 'signlink') {
      if (await isRateLimited(env, ip, 'rls', 10)) return fail('slow', 429);
      return relay(await dolibarr(env, 'signlink', { email }));
    }
    return relay(await dolibarr(env, 'book', { email, ip, tool: str(data.tool, 64), slot: Number(data.slot) || 0, start: str(data.start, 40) }));
  }
  if (route === 'status') return relay(await dolibarr(env, 'bookingstatus', { ref: str(data.ref, 20), key: str(data.key, 64) }));
  if (route === 'notify') {
    const email = str(data.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) return fail('invalid', 400);
    const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'training-book');
    if (!ts.ok) return fail('captcha', 400);
    if (await isRateLimited(env, ip, 'rln', 5)) return fail('slow', 429);
    if (env.SUBSCRIBERS) await env.SUBSCRIBERS.put(NOTIFY_PREFIX + email, '1', { expirationTtl: 48 * 3600 });
    return json({ ok: true });
  }
  if (route === 'class') {
    const code = str(data.code, 20);
    let email = await readSession(env, data.session);
    if (!email) {
      email = str(data.email, 200).toLowerCase();
      if (!EMAIL_RE.test(email)) return fail('invalid', 400);
      const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'training-class');
      if (!ts.ok) return fail('captcha', 400);
      if (await isRateLimited(env, ip, 'rlk', 30)) return fail('slow', 429);
    }
    const r = await dolibarr(env, 'classjoin', { code, email, ip, firstname: str(data.firstname, 50), lastname: str(data.lastname, 50) });
    if (isDown(r)) return fail('unavailable', 503);
    if (!r.data?.ok) return json(r.data, r.status);
    return json({ ...r.data, session: await makeSession(env, email) });
  }
  return new Response('Not found', { status: 404 });
}

async function handleSlots(request, env, ctx) {
  const tool = str(new URL(request.url).searchParams.get('tool'), 64);
  const cacheKey = new Request(`https://training.internal/slots?tool=${encodeURIComponent(tool)}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const r = await dolibarr(env, 'slots', { tool });
  if (isDown(r)) return fail('unavailable', 503);
  const res = json(r.data, r.status, r.data?.ok ? 'public, max-age=60' : 'no-store');
  if (r.data?.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Dolibarr first; while it is down, the masked copy it pushed earlier.
async function handleLookup(request, env, data, ip) {
  const email = str(data.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail('invalid', 400);
  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'training');
  if (!ts.ok) return fail('captcha', 400);
  if (await isRateLimited(env, ip, 'rlt', 20)) return fail('slow', 429);
  const pick = (d) => ({
    ok: true,
    found: Boolean(d.found),
    email: str(d.email, 200),
    name: str(d.name, 200),
    trainings: (Array.isArray(d.trainings) ? d.trainings : []).map((t) => ({ tool: str(t.tool, 150), zone: str(t.zone, 100), date: str(t.date, 10) })),
  });
  if (joinConfigured(env)) {
    const r = await dolibarr(env, 'lookup', { email });
    if (r.data?.ok) return json(pick(r.data));
    if (!isDown(r)) return json(r.data, r.status);
  }
  if (env.SUBSCRIBERS && env.DOLIBARR_API_KEY) {
    const saved = await env.SUBSCRIBERS.get(`tl:${await hmacHex(env.DOLIBARR_API_KEY, `lookup:${email}`)}`, { type: 'json' }).catch(() => null);
    return json({ ...pick(saved || {}), offline: true });
  }
  return fail('unavailable', 503);
}

// ---------------------------------------------------------------- Dolibarr's push

async function handleSync(request, env) {
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  const given = request.headers.get('X-Onboarding-Key') || '';
  if (!env.DOLIBARR_API_KEY || !timingSafeEqual(given, env.DOLIBARR_API_KEY)) return fail('unauthorized', 401);
  const data = await readJson(request, 2000000);
  if (!data) return fail('invalid', 400);
  if (!env.SUBSCRIBERS) return fail('config', 503);
  let version = 0;
  if (data.catalog && Array.isArray(data.catalog.tools)) {
    await env.SUBSCRIBERS.put(CATALOG_KEY, JSON.stringify(data.catalog));
    version = Number(data.catalog.version) || 0;
  }
  let stored = 0;
  for (const row of Array.isArray(data.lookups) ? data.lookups.slice(0, 500) : []) {
    const email = str(row.email, 200).toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    const key = `tl:${await hmacHex(env.DOLIBARR_API_KEY, `lookup:${email}`)}`;
    if (!row.found) {
      await env.SUBSCRIBERS.delete(key);
    } else {
      // Only the masked fields are kept; the email itself is not stored.
      await env.SUBSCRIBERS.put(key, JSON.stringify({ found: true, email: str(row.email_masked, 200), name: str(row.name, 200), trainings: Array.isArray(row.trainings) ? row.trainings : [] }));
    }
    stored++;
  }
  if (!version) version = Number((await catalog(env)).version) || 0;
  return json({ ok: true, version, stored });
}

// The Worker's copy of the catalog, else the snapshot the site was built with
// (data/training.json, published at /training/catalog/index.json).
async function catalog(env) {
  const saved = env.SUBSCRIBERS ? await env.SUBSCRIBERS.get(CATALOG_KEY, { type: 'json' }).catch(() => null) : null;
  if (saved) return { ok: true, ...saved };
  try {
    const r = await env.ASSETS.fetch(new Request('https://assets.internal/training/catalog/index.json'));
    if (r.ok) return { ok: true, snapshot: true, ...(await r.json()) };
  } catch {
    // fall through
  }
  return { ok: true, version: 0, tools: [], closed: [] };
}

// ---------------------------------------------------------------- scheduled

// Every five minutes (src/index.js): every 15 minutes pull the catalog from
// Dolibarr, telling it which version the website held; note when Dolibarr stops
// answering and email the alerts address after ten minutes; once it answers again,
// tell the people who asked to hear. Hourly, send Dolibarr the closed days found on
// the shop calendar.
export async function runTrainingSync(env, now = new Date()) {
  if (!joinConfigured(env) || !env.SUBSCRIBERS) return 'not configured';
  const minute = now.getUTCMinutes();
  const out = [];
  if (minute % 15 < 5) {
    const have = Number((await catalog(env)).version) || 0;
    const r = await dolibarr(env, 'catalog', { have });
    if (r.data?.ok && r.data.catalog) {
      await env.SUBSCRIBERS.put(CATALOG_KEY, JSON.stringify(r.data.catalog));
      await up(env, out);
    } else {
      await down(env, now, r, out);
    }
  }
  if (minute < 5) {
    try {
      out.push(await syncClosures(env, now));
    } catch (e) {
      out.push(`closures: ${e.message}`);
    }
  }
  return out.join('; ') || 'nothing due';
}

async function down(env, now, r, out) {
  const since = Number(await env.SUBSCRIBERS.get(DOWN_KEY)) || 0;
  if (!since) await env.SUBSCRIBERS.put(DOWN_KEY, String(now.getTime()));
  const minutes = since ? Math.round((now.getTime() - since) / 60000) : 0;
  out.push(`Dolibarr not answering (${r.status} ${r.data?.error || ''}) for ${minutes} min`);
  if (since && minutes >= 10) {
    await alert(env, 'dolibarr-down', 'The website cannot reach Dolibarr',
      `The website has not been able to reach Dolibarr for ${minutes} minutes (last answer: HTTP ${r.status} ${r.data?.error || ''}).\n\n` +
      'While it is down, tool pages and "What am I trained on?" still work from the website\'s copy, but booking a training and signing up are paused. ' +
      'People can leave their email to hear when booking is back.\n\nCheck that Dolibarr is running and reachable at DOLIBARR_URL, and that DOLIBARR_API_KEY matches the module\'s "Key for the website".');
  }
}

async function up(env, out) {
  const since = Number(await env.SUBSCRIBERS.get(DOWN_KEY)) || 0;
  if (!since) return;
  await env.SUBSCRIBERS.delete(DOWN_KEY);
  out.push('Dolibarr answering again');
  if (await env.SUBSCRIBERS.get(ALERT_PREFIX + 'dolibarr-down')) {
    await env.SUBSCRIBERS.delete(ALERT_PREFIX + 'dolibarr-down');
    await sendAlert(env, '[Fixed] The website reaches Dolibarr again', 'The website reaches Dolibarr again. Booking and signup work.');
  }
  const emails = [];
  let cursor;
  do {
    const page = await env.SUBSCRIBERS.list({ prefix: NOTIFY_PREFIX, cursor });
    for (const k of page.keys) emails.push(k.name.slice(NOTIFY_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && emails.length < 200);
  if (emails.length) {
    const r = await dolibarr(env, 'notifyback', { emails });
    if (r.data?.ok) for (const e of emails) await env.SUBSCRIBERS.delete(NOTIFY_PREFIX + e);
    out.push(`told ${r.data?.sent || 0} people booking is back`);
  }
}

// Days whose calendar has an "Open Hack Night cancelled" event, from today on.
async function syncClosures(env, now) {
  if (!env.CALENDAR_ICS_URL) return 'closures: no calendar';
  const until = new Date(now.getTime() + 120 * 864e5);
  const days = [];
  for (const e of await occurrences(env, now, until)) {
    if (/open\s*hack\s*night/i.test(e.title) && /cancel/i.test(e.title)) days.push({ day: e.day, reason: e.title.slice(0, 200) });
  }
  const r = await dolibarr(env, 'closeddays', { days });
  return r.data?.ok ? `closures: ${days.length} closed day(s), ${r.data.moved || 0} booking(s) moved` : `closures: Dolibarr answered ${r.status}`;
}

// At most one email an hour per problem. Needs the ALERTS send_email binding
// (Cloudflare Email Routing, see wrangler.jsonc) and ALERT_EMAIL_FROM / ALERT_EMAIL_TO;
// without them the alert only goes to the Worker's log.
async function alert(env, key, subject, body) {
  console.error(`training alert ${key}: ${subject}`);
  const last = Number(await env.SUBSCRIBERS.get(ALERT_PREFIX + key)) || 0;
  if (Date.now() - last < 3600e3) return;
  await env.SUBSCRIBERS.put(ALERT_PREFIX + key, String(Date.now()), { expirationTtl: 7 * 86400 });
  await sendAlert(env, `[Alert] ${subject}`, `${body}\n\nYou get at most one email an hour about this, and one more when it is fixed.`);
}

async function sendAlert(env, subject, body) {
  if (!env.ALERTS || !env.ALERT_EMAIL_TO || !env.ALERT_EMAIL_FROM) return false;
  try {
    const { EmailMessage } = await import('cloudflare:email');
    const raw = [
      `From: Columbia Gadget Works website <${env.ALERT_EMAIL_FROM}>`,
      `To: ${env.ALERT_EMAIL_TO}`,
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${env.ALERT_EMAIL_FROM.split('@')[1] || 'localhost'}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');
    await env.ALERTS.send(new EmailMessage(env.ALERT_EMAIL_FROM, env.ALERT_EMAIL_TO, raw));
    return true;
  } catch (e) {
    console.error('alert email failed:', e.message);
    return false;
  }
}
