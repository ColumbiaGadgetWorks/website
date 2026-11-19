import test from 'node:test';
import assert from 'node:assert/strict';
import { matchMapping, syncGivebutter } from './fund-givebutter.js';

test('a fund beats the General campaign-only catch-all', () => {
  const maps = [
    { name: 'General', fund: null, campaign: 'v7rxv6' },
    { name: 'Lathe', fund: '71037', campaign: null },
  ];
  const tx = { funds: ['71037'], campaigns: ['v7rxv6'] };
  assert.equal(matchMapping(tx, maps).name, 'Lathe');
  assert.equal(matchMapping({ funds: [], campaigns: ['v7rxv6'] }, maps).name, 'General');
  assert.equal(matchMapping({ funds: [], campaigns: ['other'] }, maps), null);
});

// Minimal D1 stand-in: records campaign inserts, answers the sync's reads.
function fakeDb() {
  const campaigns = [];
  const stmt = (sql) => ({
    bind: (...a) => ({
      run: async () => {
        if (/INSERT OR IGNORE INTO campaign/.test(sql)) campaigns.push({ name: a[1], fund: a[2], campaign: a[3] });
        return {};
      },
      first: async () => null,
      all: async () => ({ results: [] }),
    }),
    run: async () => ({}),
    first: async () => null,
    all: async () => ({
      results: /FROM campaign/.test(sql)
        ? campaigns.map((c) => ({ guild_id: 'g', name: c.name, currency: '$', gb_fund: c.fund, gb_campaign: c.campaign, gb_keywords: null }))
        : /PRAGMA/.test(sql) ? [{ name: 'gb_fund' }, { name: 'gb_campaign' }, { name: 'gb_keywords' }, { name: 'external_id' }] : [],
    }),
  });
  return { prepare: stmt, campaigns, exec: async () => ({}), batch: async () => [] };
}

test('sync creates goal rows for funds and General', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('/funds')
      ? { data: [{ id: 71037, code: 'LATHE', name: 'CGW Lathe' }], meta: { last_page: 1 } }
      : { data: [], meta: { last_page: 1 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const db = fakeDb();
    const env = { FUND_DB: db, GIVEBUTTER_API_KEY: 'k', DISCORD_GUILD_ID: 'g', DONATE_URL: 'https://givebutter.com/v7RxV6' };
    const r = await syncGivebutter(env, { apply: true });
    assert.deepEqual(r.created, ['CGW Lathe', 'General']);
    assert.deepEqual(db.campaigns.map((c) => c.name), ['CGW Lathe', 'General']);
    assert.equal(db.campaigns[1].campaign, 'v7RxV6');
  } finally {
    globalThis.fetch = real;
  }
});
