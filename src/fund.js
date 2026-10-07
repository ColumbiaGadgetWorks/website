// Shop fund data: campaigns and donations in the `fundraiser` D1 database
// (binding FUND_DB, schema in db/fund-schema.sql). Written only by the Discord
// /fund commands (src/fund-discord.js); read here for the /kiosk/ page at
// GET /api/fund/campaigns.
//
// Until FUND_DB is bound, the endpoint passes through the old fundbot bot's
// /api/campaigns (FUNDBOT_API_URL) instead, so the kiosk keeps working during
// the move. Neither source URL ever comes from the request.

const CACHE_SECONDS = 15;

// ---------- queries shared with the Discord commands ----------

export async function getCampaign(db, guildId, name) {
  return db
    .prepare('SELECT name, goal, currency, channel_id, message_id, link FROM campaign WHERE guild_id = ? AND name = ?')
    .bind(guildId, name)
    .first();
}

export async function totals(db, guildId, name) {
  const row = await db
    .prepare('SELECT COALESCE(SUM(amount), 0) AS raised, COUNT(*) AS count FROM donation WHERE guild_id = ? AND name = ?')
    .bind(guildId, name)
    .first();
  return { raised: row.raised, count: row.count };
}

export async function recentDonations(db, guildId, name, limit) {
  const { results } = await db
    .prepare('SELECT donor, amount FROM donation WHERE guild_id = ? AND name = ? ORDER BY id DESC LIMIT ?')
    .bind(guildId, name, limit)
    .all();
  return results;
}

// ---------- GET /api/fund/campaigns ----------

export async function handleFund(request, env, ctx) {
  const cacheKey = new Request('https://fund.internal/v2/campaigns', { method: 'GET' });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let data;
  try {
    data = env.FUND_DB ? await fromD1(env) : await fromFundbot(env);
  } catch (err) {
    console.error('fund campaigns:', err);
    return json({ ok: false, error: 'unavailable' }, 502, 'no-store');
  }
  if (!data) return json({ ok: false, error: 'not-configured' }, 503, 'no-store');

  const body = json(data, 200, `public, max-age=${CACHE_SECONDS}`);
  if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, body.clone()));
  else await cache.put(cacheKey, body.clone());
  return body;
}

// Same JSON the fundbot bot served, so the page needs no change.
async function fromD1(env) {
  const db = env.FUND_DB;
  const showDonors = String(env.SHOW_DONORS ?? 'true').toLowerCase() === 'true';
  const donateUrl = (env.DONATE_URL || '').trim() || null;
  const { results: rows } = await db
    .prepare('SELECT guild_id, name, goal, currency, link FROM campaign ORDER BY name')
    .all();

  const campaigns = [];
  for (const r of rows) {
    const { raised, count } = await totals(db, r.guild_id, r.name);
    const recent = showDonors
      ? (await recentDonations(db, r.guild_id, r.name, 6)).map((d) => ({ donor: d.donor || 'Anonymous', amount: d.amount }))
      : [];
    campaigns.push({
      name: r.name,
      goal: r.goal,
      raised,
      currency: r.currency,
      count,
      pct: r.goal ? raised / r.goal : 0,
      link: r.link || donateUrl,
      recent,
    });
  }
  return {
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    donate_url: donateUrl,
    campaigns,
  };
}

async function fromFundbot(env) {
  const upstream = env.FUNDBOT_API_URL;
  if (!upstream) return null;
  const res = await fetch(upstream, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.campaigns)) throw new Error('upstream unreadable');
  return data;
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
