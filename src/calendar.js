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

// Subscribable feed, mounted at GET /api/calendar.ics by src/index.js.
//
// Visitors add this address to their own calendar app. It is rebuilt from the
// same occurrences the page shows, NOT a copy of the source feed: the source
// address is a credential, and its raw events can carry organizer and attendee
// addresses that were never meant to be published. Each occurrence becomes a
// plain event, so recurrence rules and exceptions are already resolved.
const FEED_MONTHS_BACK = 1;
const FEED_MONTHS_AHEAD = 12;

export async function handleCalendarFeed(request, env, ctx) {
  const icsUrl = env.CALENDAR_ICS_URL;
  if (!icsUrl) return new Response('Calendar not configured', { status: 503, headers: { 'cache-control': 'no-store' } });

  const cacheKey = new Request('https://calendar.internal/v1/feed.ics', { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let text;
  try {
    const res = await fetch(icsUrl, {
      headers: { 'user-agent': 'columbiagadgetworks.org calendar' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });
    if (!res.ok) return new Response('Calendar unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
    text = await res.text();
  } catch {
    return new Response('Calendar unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }

  let body;
  try {
    const [y, m] = startOfCurrentMonth().split('-').map(Number);
    const windowStart = new Date(Date.UTC(y, m - 1 - FEED_MONTHS_BACK, 1));
    const windowEnd = new Date(Date.UTC(y, m - 1 + FEED_MONTHS_AHEAD, 1));
    const events = expand(parseICS(text, SITE_TZ), windowStart, windowEnd, SITE_TZ).slice(0, MAX_EVENTS * 2);
    body = await toICS(events, new URL(request.url).host);
  } catch {
    return new Response('Calendar unavailable', { status: 502, headers: { 'cache-control': 'no-store' } });
  }

  const res = new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="columbia-gadget-works.ics"',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      'access-control-allow-origin': '*',
      'x-robots-tag': 'noindex',
    },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  else await cache.put(cacheKey, res.clone());
  return res;
}

export async function toICS(events, host) {
  const stamp = icsUtc(new Date().toISOString());
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Columbia Gadget Works//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Columbia Gadget Works',
    `X-WR-TIMEZONE:${SITE_TZ}`,
    // How often a subscribed app should check for changes.
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events) {
    // The source UID is not passed through, so derive a stable one from the
    // occurrence. Editing an event's title makes apps see it as replaced.
    const uid = `${await sha1(`${e.start}|${e.title}`)}@${host}`;
    out.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp}`);
    if (e.allDay) {
      out.push(`DTSTART;VALUE=DATE:${e.start.slice(0, 10).replace(/-/g, '')}`);
      out.push(`DTEND;VALUE=DATE:${e.end.slice(0, 10).replace(/-/g, '')}`);
    } else {
      out.push(`DTSTART:${icsUtc(e.start)}`, `DTEND:${icsUtc(e.end)}`);
    }
    out.push(`SUMMARY:${icsText(e.title)}`);
    if (e.location) out.push(`LOCATION:${icsText(e.location)}`);
    if (e.description) out.push(`DESCRIPTION:${icsText(e.description)}`);
    if (/^https?:\/\//i.test(e.url)) out.push(`URL:${e.url}`);
    out.push('END:VEVENT');
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

function icsUtc(iso) {
  return iso.replace(/\.\d{3}/, '').replace(/[-:]/g, '');
}

function icsText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// RFC 5545 lines are at most 75 octets; longer ones continue on lines that
// start with a space. Split on characters, never inside a multi-byte one.
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) { parts.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch; bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

async function sha1(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The calendar's occurrences between two instants, for code outside a request
// (the Discord events sync). Throws when the feed is missing or unreadable.
export async function occurrences(env, windowStart, windowEnd) {
  if (!env.CALENDAR_ICS_URL) throw new Error('CALENDAR_ICS_URL is not set');
  const res = await fetch(env.CALENDAR_ICS_URL, {
    headers: { 'user-agent': 'columbiagadgetworks.org calendar' },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`calendar feed answered ${res.status}`);
  return expand(parseICS(await res.text(), SITE_TZ), windowStart, windowEnd, SITE_TZ).slice(0, MAX_EVENTS);
}
