// Givebutter donations counted toward shop fund goals.
//
// A /fund campaign is tied to Givebutter with /fund map: a Fund code (the
// "designate to" dropdown on the donation form), a Givebutter campaign code, or
// both. Every five minutes the cron trigger reads recent transactions from the
// Givebutter API and records each successful gift that matches a mapping as a
// donation row, keyed by the Givebutter transaction id so a gift is never
// counted twice. Refunded or failed gifts are taken back out.
//
// Gifts that match no mapping but whose message mentions one of a campaign's
// keywords are not counted. They wait in a review list (/fund review) until
// someone assigns or dismisses them.
//
// Bindings:
//   FUND_DB             D1 database (db/fund-schema.sql)
//   GIVEBUTTER_API_KEY  secret, Givebutter dashboard > Settings > Integrations > API
//   GIVEBUTTER_SYNC     "on" records gifts. Anything else (the default) is a dry
//                       run: the cron does nothing and /fund sync only previews.

const API = 'https://api.givebutter.com/v1';
const COUNTED = new Set(['succeeded', 'completed', 'paid']);
// A routine run re-reads the last few days so refunds and edits are picked up.
const OVERLAP_MS = 3 * 24 * 60 * 60 * 1000;
const ROUTINE_PAGES = 5;
const FULL_PAGES = 40;

export function givebutterConfigured(env) {
  return Boolean(String(env.GIVEBUTTER_API_KEY || '').trim());
}

export function givebutterLive(env) {
  return String(env.GIVEBUTTER_SYNC || '').trim().toLowerCase() === 'on';
}

// ---------- schema ----------

// Adds the Givebutter columns and tables to a database created before them.
// Same rule as the old bot: check PRAGMA table_info, add, never drop or recreate.
let schemaReady = false;

export async function ensureGivebutterSchema(db) {
  if (schemaReady) return;
  const columns = async (table) =>
    new Set((await db.prepare(`PRAGMA table_info(${table})`).all()).results.map((r) => r.name));
  const campaign = await columns('campaign');
  const donation = await columns('donation');
  const statements = [];
  if (!campaign.has('gb_fund')) statements.push('ALTER TABLE campaign ADD COLUMN gb_fund TEXT');
  if (!campaign.has('gb_campaign')) statements.push('ALTER TABLE campaign ADD COLUMN gb_campaign TEXT');
  if (!campaign.has('gb_keywords')) statements.push('ALTER TABLE campaign ADD COLUMN gb_keywords TEXT');
  if (!donation.has('external_id')) statements.push('ALTER TABLE donation ADD COLUMN external_id TEXT');
  statements.push('CREATE UNIQUE INDEX IF NOT EXISTS donation_by_external ON donation (external_id)');
  statements.push(
    'CREATE TABLE IF NOT EXISTS gb_review (external_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, ' +
      "guess TEXT, amount REAL NOT NULL, donor TEXT, note TEXT, ts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open')",
  );
  statements.push('CREATE TABLE IF NOT EXISTS gb_state (key TEXT PRIMARY KEY, value TEXT)');
  for (const sql of statements) await db.prepare(sql).run();
  schemaReady = true;
}

// ---------- Givebutter API ----------

export class GivebutterError extends Error {
  constructor(status) {
    super(`givebutter ${status}`);
    this.status = status;
  }
}

async function gb(env, path) {
  const res = await fetch(API + path, {
    headers: {
      authorization: `Bearer ${String(env.GIVEBUTTER_API_KEY).trim()}`,
      accept: 'application/json',
    },
  });
  if (!res.ok) throw new GivebutterError(res.status);
  return res.json();
}

export async function fetchTransaction(env, id) {
  const data = await gb(env, `/transactions/${encodeURIComponent(id)}`);
  return data && data.data && typeof data.data === 'object' ? data.data : data;
}

const when = (t) => Date.parse(t.transacted_at || t.created_at || '') || 0;

// Pages of transactions, newest first, whichever order the API lists them in.
async function* newestFirst(env, maxPages) {
  const first = await gb(env, '/transactions?page=1');
  const list = Array.isArray(first.data) ? first.data : [];
  const lastPage = Number(first.meta?.last_page) || 0;
  const ascending = list.length > 1 && when(list[0]) < when(list[list.length - 1]);

  if (ascending && lastPage > 1) {
    for (let p = lastPage, n = 0; p >= 1 && n < maxPages; p--, n++) {
      const rows = p === 1 ? list : (await gb(env, `/transactions?page=${p}`)).data || [];
      yield [...rows].sort((a, b) => when(b) - when(a));
    }
    return;
  }
  yield [...list].sort((a, b) => when(b) - when(a));
  let next = first.links?.next;
  for (let p = 2; next && p <= maxPages; p++) {
    const data = await gb(env, `/transactions?page=${p}`);
    yield [...(data.data || [])].sort((a, b) => when(b) - when(a));
    next = data.links?.next;
  }
}

// ---------- reading a transaction ----------

const lower = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim().toLowerCase());
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function readTransaction(t) {
  const fieldText = (t.custom_fields || []).map((f) => (f && typeof f.value === 'string' ? f.value : ''));
  return {
    id: String(t.id),
    status: lower(t.status) || '',
    // The gift itself: not ticket or item sales, not the fee a donor chose to cover.
    amount: num(t.donated) ?? num(t.amount) ?? 0,
    // The name Givebutter shows publicly, which already honours "give anonymously".
    donor: String(t.giving_space?.name || '').trim().slice(0, 100) || null,
    ts: t.transacted_at || t.created_at || new Date().toISOString(),
    funds: [t.fund_code, t.fund_id, t.fund?.code, t.fund?.id].map(lower).filter(Boolean),
    campaigns: [t.campaign_code, t.campaign_id].map(lower).filter(Boolean),
    note: [t.giving_space?.message, t.dedication?.name, ...fieldText]
      .filter((s) => typeof s === 'string' && s.trim())
      .join(' · ')
      .slice(0, 500),
  };
}

export async function loadMappings(db) {
  const { results } = await db
    .prepare(
      'SELECT guild_id, name, gb_fund, gb_campaign, gb_keywords FROM campaign ' +
        'WHERE gb_fund IS NOT NULL OR gb_campaign IS NOT NULL OR gb_keywords IS NOT NULL',
    )
    .all();
  return results.map((r) => ({
    guild_id: r.guild_id,
    name: r.name,
    fund: lower(r.gb_fund),
    campaign: lower(r.gb_campaign),
    keywords: String(r.gb_keywords || '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length >= 3),
  }));
}

// The /fund campaign a gift counts toward. A mapping matches when every code it
// sets matches; the one with more codes set wins.
export function matchMapping(tx, mappings) {
  let best = null;
  let bestScore = 0;
  for (const m of mappings) {
    if (!m.fund && !m.campaign) continue;
    if (m.fund && !tx.funds.includes(m.fund)) continue;
    if (m.campaign && !tx.campaigns.includes(m.campaign)) continue;
    const score = (m.fund ? 1 : 0) + (m.campaign ? 1 : 0);
    if (score > bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best;
}

export function keywordGuess(tx, mappings) {
  const text = tx.note.toLowerCase();
  if (!text) return null;
  return mappings.find((m) => m.keywords.some((k) => text.includes(k))) || null;
}

// ---------- the sync ----------

async function getState(db, key) {
  const row = await db.prepare('SELECT value FROM gb_state WHERE key = ?').bind(key).first();
  return row ? row.value : null;
}

async function setState(db, key, value) {
  await db
    .prepare('INSERT INTO gb_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

// Reads Givebutter and brings the donation table in line with it. With
// apply=false nothing is written and the result says what would have changed.
// `full` re-reads up to FULL_PAGES pages instead of just the last few days, for
// importing gifts made before a mapping existed.
export async function syncGivebutter(env, { apply, full = false } = {}) {
  const db = env.FUND_DB;
  await ensureGivebutterSchema(db);
  const result = { apply, full, added: [], moved: [], removed: [], review: [], scanned: 0, touched: [] };

  const mappings = await loadMappings(db);
  if (!mappings.length) return { ...result, empty: true };

  const counted = new Map(
    (await db.prepare('SELECT id, guild_id, name, amount, donor, external_id FROM donation WHERE external_id IS NOT NULL').all())
      .results.map((r) => [r.external_id, r]),
  );
  const reviewed = new Map(
    (await db.prepare('SELECT external_id, status FROM gb_review').all()).results.map((r) => [r.external_id, r.status]),
  );

  const lastRun = full ? null : await getState(db, 'last_sync');
  const cutoff = lastRun ? Date.parse(lastRun) - OVERLAP_MS : 0;
  const started = new Date().toISOString();
  const touched = new Map();
  const touch = (guildId, name) => touched.set(`${guildId}\u0000${name}`, { guild_id: guildId, name });

  for await (const page of newestFirst(env, lastRun ? ROUTINE_PAGES : FULL_PAGES)) {
    for (const raw of page) {
      result.scanned++;
      const tx = readTransaction(raw);
      const existing = counted.get(tx.id);
      const status = reviewed.get(tx.id);

      if (!COUNTED.has(tx.status) || !(tx.amount > 0)) {
        if (existing) {
          result.removed.push({ ...tx, name: existing.name });
          touch(existing.guild_id, existing.name);
          if (apply) await db.prepare('DELETE FROM donation WHERE id = ?').bind(existing.id).run();
        }
        continue;
      }
      // Someone assigned or dismissed it by hand: leave their decision alone.
      if (status === 'assigned' || status === 'dismissed') continue;

      const m = matchMapping(tx, mappings);
      if (m) {
        if (!existing) {
          result.added.push({ ...tx, name: m.name });
          touch(m.guild_id, m.name);
          if (apply) {
            await db
              .prepare('INSERT INTO donation (guild_id, name, amount, donor, ts, external_id) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(m.guild_id, m.name, tx.amount, tx.donor, tx.ts, tx.id)
              .run();
          }
        } else if (existing.name !== m.name || existing.guild_id !== m.guild_id || existing.amount !== tx.amount || existing.donor !== tx.donor) {
          result.moved.push({ ...tx, name: m.name, from: existing.name });
          touch(existing.guild_id, existing.name);
          touch(m.guild_id, m.name);
          if (apply) {
            await db
              .prepare('UPDATE donation SET guild_id = ?, name = ?, amount = ?, donor = ? WHERE id = ?')
              .bind(m.guild_id, m.name, tx.amount, tx.donor, existing.id)
              .run();
          }
        }
        if (status === 'open' && apply) await db.prepare('DELETE FROM gb_review WHERE external_id = ?').bind(tx.id).run();
        continue;
      }

      if (!existing && !status) {
        const guess = keywordGuess(tx, mappings);
        if (guess) {
          result.review.push({ ...tx, name: guess.name });
          if (apply) {
            await db
              .prepare('INSERT OR IGNORE INTO gb_review (external_id, guild_id, guess, amount, donor, note, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(tx.id, guess.guild_id, guess.name, tx.amount, tx.donor, tx.note, tx.ts)
              .run();
          }
        }
      }
    }
    const oldest = Math.min(...page.map(when));
    if (cutoff && page.length && oldest < cutoff) break;
  }

  if (apply) await setState(db, 'last_sync', started);
  result.touched = [...touched.values()];
  return result;
}

// Records one Givebutter gift toward a campaign by hand, from the review list
// or by transaction id for a gift that was never picked up.
export async function assignTransaction(env, guildId, txId, name) {
  const db = env.FUND_DB;
  await ensureGivebutterSchema(db);
  let tx;
  const queued = await db.prepare('SELECT * FROM gb_review WHERE external_id = ?').bind(txId).first();
  if (queued) {
    tx = { id: txId, amount: queued.amount, donor: queued.donor, ts: queued.ts, status: 'succeeded' };
  } else {
    if (!givebutterConfigured(env)) return { error: 'no-key' };
    try {
      tx = readTransaction(await fetchTransaction(env, txId));
    } catch (err) {
      if (err instanceof GivebutterError && err.status === 404) return { error: 'not-found' };
      throw err;
    }
    if (!COUNTED.has(tx.status) || !(tx.amount > 0)) return { error: 'not-paid', tx };
  }
  const before = await db.prepare('SELECT guild_id, name FROM donation WHERE external_id = ?').bind(txId).first();
  await db
    .prepare(
      'INSERT INTO donation (guild_id, name, amount, donor, ts, external_id) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(external_id) DO UPDATE SET guild_id = excluded.guild_id, name = excluded.name',
    )
    .bind(guildId, name, tx.amount, tx.donor, tx.ts, txId)
    .run();
  await setReview(db, guildId, txId, 'assigned', tx);
  return { tx, before };
}

// Marks a gift as handled so the sync never counts it again, whether it was
// waiting for review or had already been counted.
export async function setReview(db, guildId, txId, status, tx = {}) {
  await ensureGivebutterSchema(db);
  await db
    .prepare(
      'INSERT INTO gb_review (external_id, guild_id, amount, donor, ts, status) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(external_id) DO UPDATE SET status = excluded.status',
    )
    .bind(txId, guildId, tx.amount ?? 0, tx.donor ?? null, tx.ts ?? new Date().toISOString(), status)
    .run();
}
