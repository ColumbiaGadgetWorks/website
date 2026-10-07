// Shop fund figures for the touchscreen page, mounted at GET /api/fund/campaigns.
//
// The campaigns and donations still live in the fundbot Discord bot's database;
// this passes its read-only /api/campaigns through so /kiosk/ needs no cross-site
// request. The upstream URL comes only from FUNDBOT_API_URL, never from the
// request, so this cannot be used as an open proxy.
//
// Cached at the edge for a few seconds: the kiosk polls every 30 s, and a new
// donation should show up on the next poll.

const CACHE_SECONDS = 15;

export async function handleFund(request, env, ctx) {
  const upstream = env.FUNDBOT_API_URL;
  if (!upstream) return json({ ok: false, error: 'not-configured' }, 503);

  const cacheKey = new Request('https://fund.internal/v1/campaigns', { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let data;
  try {
    const res = await fetch(upstream, { headers: { accept: 'application/json' } });
    if (!res.ok) return json({ ok: false, error: `upstream-${res.status}` }, 502);
    data = await res.json();
  } catch {
    return json({ ok: false, error: 'upstream-unreachable' }, 502);
  }
  if (!data || !Array.isArray(data.campaigns)) {
    return json({ ok: false, error: 'upstream-unreadable' }, 502);
  }

  const body = new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      'x-robots-tag': 'noindex',
    },
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, body.clone()));
  else await cache.put(cacheKey, body.clone());
  return body;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
