// Free classes. Dolibarr keeps them (class/freeclass.class.php in the onboarding
// module): the classes lead makes a class there, which also writes it onto the
// Google Calendar, and people sign up here.
//
//   GET  /api/classes         the classes to come: name, description, time, seats
//                             left. Nothing personal. Cached for a minute.
//   POST /api/classes/signup  {id, name, email, updates, cf-turnstile-response}
//                             Dolibarr matches the email to a member card or
//                             contact, or makes a contact, and emails a
//                             confirmation. The answer is the same whether or not
//                             the email was known.
//   GET|POST /classes/link/?s=…&k=…  the "I can't come" button in the emails, shown
//                             inside the site from Dolibarr's public/freeclass.php
//
// Uses DOLIBARR_URL and DOLIBARR_API_KEY (see src/join.js), TURNSTILE_SECRET if set,
// and the SUBSCRIBERS KV for the per-address limit.
import { verifyTurnstile } from './turnstile.js';
import { dolibarr, joinConfigured } from './join.js';
import { proxyLinkPage } from './training.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const SIGNUPS_PER_HOUR = 10;
const LIST_CACHE_SECONDS = 60;
const LIST_KEY = 'https://classes.internal/v1/list';

const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (error, status, extra = {}) => json({ ok: false, error, ...extra }, status);
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max);

export function handleClassLink(request, env) {
  return proxyLinkPage(request, env, { file: 'freeclass.php', shell: '/classes/link/', marker: 'CLASS_LINK', title: 'Free class' });
}

export async function handleClasses(request, env, ctx, pathname) {
  if (pathname === '/api/classes') {
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });
    return list(env, ctx);
  }
  if (pathname === '/api/classes/signup') {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    return signup(request, env);
  }
  return fail('not-found', 404);
}

async function list(env, ctx) {
  if (!joinConfigured(env)) return fail('config', 503);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(LIST_KEY);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const r = await dolibarr(env, 'freeclasses');
  if (!r.data?.ok || !Array.isArray(r.data.classes)) return fail(r.data?.error || 'unavailable', r.status >= 400 ? r.status : 502);
  const classes = r.data.classes.map((c) => ({
    id: Number(c.id) || 0,
    kind: c.kind === 'oca' ? 'oca' : 'extra',
    title: str(c.title, 200),
    description: str(c.description, 4000),
    start: str(c.start, 30),
    when: str(c.when, 120),
    minutes: Number(c.minutes) || 0,
    seats: Number(c.seats) || 0,
    left: Math.max(0, Number(c.left) || 0),
    full: Boolean(c.full),
    sponsor: str(c.sponsor, 300),
  }));
  const res = json({ ok: true, classes }, 200, { 'cache-control': `public, max-age=${LIST_CACHE_SECONDS}` });
  if (cache) {
    const put = cache.put(key, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

async function signup(request, env) {
  if (!joinConfigured(env)) return fail('config', 503);
  let data;
  try {
    const text = await request.text();
    data = text.length < 8000 ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') return fail('invalid', 400, { field: 'name' });
  if (str(data.website, 200)) return json({ ok: true }); // bot: pretend success
  const id = Number(data.id) || 0;
  const name = str(data.name, 100);
  const email = str(data.email, 200).toLowerCase();
  if (!id) return fail('closed', 409);
  if (name.length < 2) return fail('invalid', 400, { field: 'name' });
  if (!EMAIL_RE.test(email)) return fail('invalid', 400, { field: 'email' });
  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'class-signup');
  if (!ts.ok) return fail('captcha', 400);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (await isRateLimited(env, ip)) return fail('slow', 429);
  const r = await dolibarr(env, 'freeclasssignup', { id, name, email, updates: Boolean(data.updates), ip });
  // The list's seats left are now out of date.
  if (typeof caches !== 'undefined') await caches.default.delete(new Request(LIST_KEY)).catch(() => {});
  if (!r.data?.ok) {
    const error = ['full', 'closed', 'invalid'].includes(r.data?.error) ? r.data.error : 'unavailable';
    return fail(error, r.status >= 400 && r.status < 500 ? r.status : 503, r.data?.field ? { field: str(r.data.field, 20) } : {});
  }
  // Signed up, or already was: the same answer, so it says nothing about who is known.
  return json({ ok: true, left: Math.max(0, Number(r.data.left) || 0) });
}

async function isRateLimited(env, ip) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `rlc:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= SIGNUPS_PER_HOUR) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}
