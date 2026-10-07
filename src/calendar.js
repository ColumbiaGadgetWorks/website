// Calendar feed, mounted at GET /api/calendar by src/index.js.
//
// Reads one iCalendar feed and returns plain JSON occurrences for a date window.
// The feed URL is NEVER taken from the request: a Google "secret address" feed
// is a credential, so it lives only in the Worker as CALENDAR_ICS_URL and is
// never sent to the browser or committed to the repo. Taking a URL from the
// query string here would also turn this endpoint into an open proxy.
//
// Bindings:
//   CALENDAR_ICS_URL (secret or var, required) - the ICS address of the calendar.
//                    Works with either the public or the secret Google address.
//
// The response is cached at the edge for a few minutes so that a burst of
// visitors does not hammer Google, while an edit to the calendar still shows up
// within minutes without rebuilding the site.

import { parseICS, expand } from './ics.js';

const CACHE_SECONDS = 600; // 10 minutes
const MAX_MONTHS = 12;
const MAX_EVENTS = 500;
const SITE_TZ = 'America/Chicago';

export async function handleCalendar(request, env, ctx) {
  const icsUrl = env.CALENDAR_ICS_URL;
  if (!icsUrl) {
    return json({ ok: false, error: 'not-configured', events: [] }, 503, 'no-store');
  }

  const url = new URL(request.url);
  const months = clamp(parseInt(url.searchParams.get('months') || '4', 10) || 4, 1, MAX_MONTHS);
  const from = parseMonth(url.searchParams.get('from')) || startOfCurrentMonth();

  // Cache key is derived from our own normalised parameters, not the raw URL,
  // so odd query strings cannot fragment or poison the cache.
  const cacheKey = new Request(`https://calendar.internal/v1?from=${from}&months=${months}`, { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let text;
  try {
    const res = await fetch(icsUrl, {
      headers: { 'user-agent': 'columbiagadgetworks.org calendar' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!res.ok) return json({ ok: false, error: `feed-${res.status}`, events: [] }, 502, 'no-store');
    text = await res.text();
  } catch {
    return json({ ok: false, error: 'feed-unreachable', events: [] }, 502, 'no-store');
  }

  let events;
  try {
    const [y, m] = from.split('-').map(Number);
    const windowStart = new Date(Date.UTC(y, m - 1, 1));
    const windowEnd = new Date(Date.UTC(y, m - 1 + months, 1));
    events = expand(parseICS(text, SITE_TZ), windowStart, windowEnd, SITE_TZ).slice(0, MAX_EVENTS);
  } catch {
    return json({ ok: false, error: 'feed-unreadable', events: [] }, 502, 'no-store');
  }

  const body = json(
    { ok: true, from, months, timezone: SITE_TZ, updated: new Date().toISOString(), events },
    200,
    `public, max-age=${CACHE_SECONDS}`,
  );
  // Store a clone; the original is still streamed to this visitor.
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, body.clone()));
  else await cache.put(cacheKey, body.clone());
  return body;
}

function json(obj, status, cacheControl) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheControl,
      'x-robots-tag': 'noindex',
    },
  });
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function parseMonth(v) {
  const m = /^(\d{4})-(\d{2})$/.exec((v || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2];
  if (mo < 1 || mo > 12 || y < 2000 || y > 2100) return null;
  return `${m[1]}-${m[2]}`;
}

function startOfCurrentMonth() {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, year: 'numeric', month: '2-digit' })
    .formatToParts(now)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}`;
}
