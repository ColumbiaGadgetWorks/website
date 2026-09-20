// Cloudflare Pages Function: GET /api/subscribers?token=...
// Exports the class and event list as CSV, so it can be pasted into whatever
// sends the mail without digging through the Cloudflare dashboard.
//
// Bindings:
//   SUBSCRIBERS              (KV namespace, required)
//   SUBSCRIBERS_EXPORT_TOKEN (secret, required) - without it this endpoint 404s,
//                              so the list is never exposed by accident.
//
// Usage: curl "https://columbiagadgetworks.org/api/subscribers?token=THE_TOKEN"

export async function onRequestGet({ request, env }) {
  // No token configured means the endpoint does not exist at all.
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
    ...rows.map(r => [r.email, r.name, r.subscribed, r.updated, r.source, r.country].map(csvCell).join(',')),
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

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function csvCell(v) {
  const s = (v ?? '').toString();
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
