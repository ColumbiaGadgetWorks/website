// Zone budgets and purchase requests, mounted by src/index.js:
//   GET  /api/budget    totals per zone: added, spent, committed, available
//   POST /api/purchase  a member's request to spend from a zone's budget
//
// The page is /budget/ (layouts/_shortcodes/budget.html). Nothing is kept here.
// Everything is forwarded to the onboarding module in Dolibarr
// (github.com/ColumbiaGadgetWorks/dolibarr-onboarding), which checks the member,
// keeps the request and its receipts, and asks the zone lead or the treasurer
// and a director to approve it. Secrets are the same as the join flow's:
// DOLIBARR_URL and DOLIBARR_API_KEY, plus TURNSTILE_SECRET for the form.
//
// What the Worker does itself: Turnstile, a per-IP hourly limit on submissions,
// size limits, and the shape of the fields. The member check and the limits on
// guessing a member code live in Dolibarr, where they cannot be bypassed by
// editing the page.

import { verifyTurnstile } from './turnstile.js';
import { dolibarr, joinConfigured } from './join.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const KINDS = ['reimburse', 'purchase'];
const MAX_FILES = 5;
const MAX_FILE_B64 = Math.ceil(5 * 1024 * 1024 * 1.4); // 5 MB of file, as base64
const MAX_BODY = MAX_FILES * MAX_FILE_B64 + 20000;
const SUBMITS_PER_HOUR = 10;
const BUDGET_CACHE_SECONDS = 300;

const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const str = (v, max) => (v === null || v === undefined ? '' : String(v)).trim().slice(0, max);

// GET /api/budget. Anyone may read it, so it is cached for five minutes: a page
// view costs Dolibarr nothing. It carries totals only, never names or transactions.
export async function handleBudget(request, env, ctx) {
  if (!joinConfigured(env)) return json({ ok: false, error: 'config' }, 503);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request(new URL('/api/budget', request.url).toString());
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const r = await dolibarr(env, 'budget');
  if (!r.data?.ok || !Array.isArray(r.data.zones)) return json({ ok: false, error: r.data?.error || 'unavailable' }, r.status >= 400 ? r.status : 502);
  const zones = r.data.zones.map((z) => ({
    zone: str(z.zone, 100),
    allocated: Number(z.allocated) || 0,
    spent: Number(z.spent) || 0,
    committed: Number(z.committed) || 0,
    available: Number(z.available) || 0,
  }));
  const res = json({ ok: true, zones, updated: new Date().toISOString() }, 200, { 'cache-control': `public, max-age=${BUDGET_CACHE_SECONDS}` });
  if (cache) {
    const put = cache.put(key, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

async function readBody(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return null;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return null;
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function isRateLimited(env, ip) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `rlb:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= SUBMITS_PER_HOUR) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}

// POST /api/purchase. Files are sent to Dolibarr one at a time after the member is
// checked, then the request is submitted. If a step fails the unfinished draft is
// left for Dolibarr to delete after two days.
export async function handlePurchase(request, env) {
  if (!joinConfigured(env)) return json({ ok: false, error: 'config' }, 503);
  const data = await readBody(request);
  if (!data) return json({ ok: false, error: 'invalid', field: 'files' }, 400);
  if (str(data.website, 200)) return json({ ok: true, ref: 'PR-0000', needs: 'lead', who: 'the treasurer' }); // bot: pretend success

  const kind = str(data.kind, 12);
  const email = str(data.email, 200).toLowerCase();
  const files = Array.isArray(data.files) ? data.files : null;
  if (!KINDS.includes(kind)) return json({ ok: false, error: 'invalid', field: 'kind' }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid', field: 'email' }, 400);
  if (!files || files.length > MAX_FILES) return json({ ok: false, error: 'invalid', field: 'files' }, 400);
  if (kind === 'reimburse' && files.length === 0) return json({ ok: false, error: 'invalid', field: 'files' }, 400);
  for (const f of files) {
    if (typeof f?.data !== 'string' || f.data.length < 100 || f.data.length > MAX_FILE_B64) return json({ ok: false, error: 'invalid', field: 'files' }, 400);
  }

  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'purchase');
  if (!ts.ok) return json({ ok: false, error: 'captcha' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (await isRateLimited(env, ip)) return json({ ok: false, error: 'slow' }, 429);

  const start = await dolibarr(env, 'purchase', {
    email,
    pin: str(data.pin, 20),
    zone: str(data.zone, 100),
    kind,
    amount: str(data.amount, 20),
    vendor: str(data.vendor, 200),
    purchase_date: str(data.purchase_date, 10),
    link: str(data.link, 500),
    description: str(data.description, 600),
    pay_method: str(data.pay_method, 20),
    pay_handle: str(data.pay_handle, 200),
    ack_tax: Boolean(data.ack_tax),
    ip,
  });
  if (!start.data?.ok) {
    const { error, field, days, allowed } = start.data || {};
    return json({
      ok: false,
      error: error || 'unavailable',
      ...(field ? { field: str(field, 20) } : {}),
      ...(days ? { days: Number(days) || 0 } : {}),
      // Only said to someone who proved who they are: the zones they may file for.
      ...(error === 'notallowed' ? { allowed: (Array.isArray(allowed) ? allowed : []).map((z) => str(z, 100)) } : {}),
    }, start.status >= 400 ? start.status : 502);
  }

  const { id, token } = start.data;
  for (const f of files) {
    const up = await dolibarr(env, 'purchasefile', { id, token, data: f.data });
    if (!up.data?.ok) return json({ ok: false, error: up.data?.error === 'type' || up.data?.error === 'size' ? up.data.error : 'file' }, up.status >= 400 ? up.status : 502);
  }
  const done = await dolibarr(env, 'purchasefinish', { id, token });
  if (!done.data?.ok) return json({ ok: false, error: done.data?.error || 'unavailable' }, done.status >= 400 ? done.status : 502);
  return json({ ok: true, ref: str(done.data.ref, 20), needs: done.data.needs === 'board' ? 'board' : 'lead', who: str(done.data.who, 200) });
}
