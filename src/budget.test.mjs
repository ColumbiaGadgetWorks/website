// Tests for the budget and purchase request handlers in budget.js.
// Run from the repository root with:  node src/budget.test.mjs
// No dependencies and no test runner. Dolibarr is a fake fetch, so this checks what
// the Worker sends and refuses, not Dolibarr's own rules (the module's sandbox
// tests cover those).
import { handleBudget, handlePurchase } from './budget.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

const env = (extra = {}) => ({ DOLIBARR_URL: 'https://dolibarr.example.test', DOLIBARR_API_KEY: 'k', ...extra });
const FILE = 'A'.repeat(200); // base64-looking, long enough to pass the size floor

// A fake Dolibarr. `answers` maps an action to the JSON (and status) it replies with.
function fakeDolibarr(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = new URL(url).searchParams.get('action');
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ action, body, key: init?.headers?.['X-Onboarding-Key'] });
    const a = answers[action] || { status: 200, json: { ok: true } };
    return new Response(JSON.stringify(a.json), { status: a.status || 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const post = (data, headers = {}) =>
  new Request('https://columbiagadgetworks.org/api/purchase', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.5', ...headers },
    body: JSON.stringify(data),
  });
const good = (over = {}) => ({
  email: 'Pres@Example.test', pin: '05', zone: 'Woodworking', kind: 'reimburse', amount: '40.00', vendor: 'Home Depot',
  purchase_date: '2026-10-01', description: 'Clamps', pay_method: 'venmo', pay_handle: '@pres', ack_tax: true, files: [{ data: FILE }], ...over,
});
const read = async (res) => ({ status: res.status, ...(await res.json()) });

// 1. Not configured.
{
  const r = await read(await handlePurchase(post(good()), {}));
  check('not configured: 503', r.status === 503 && r.error === 'config');
  const b = await read(await handleBudget(new Request('https://x.test/api/budget'), {}, {}));
  check('budget not configured: 503', b.status === 503);
}

// 2. The budget: totals per zone, coerced and trimmed, nothing else passed on.
{
  fakeDolibarr({ budget: { json: { ok: true, zones: [{ zone: 'Woodworking', allocated: '250', training: '35.5', spent: 40, committed: 0, available: 210, secret: 'x', email: 'a@b.test' }] } } });
  const r = await read(await handleBudget(new Request('https://x.test/api/budget'), env(), {}));
  check('budget: ok with zones', r.status === 200 && r.ok && r.zones.length === 1);
  check('budget: numbers are numbers', r.zones[0].allocated === 250 && r.zones[0].available === 210 && r.zones[0].training === 35.5);
  check('budget: unknown fields are dropped', !('secret' in r.zones[0]) && !('email' in r.zones[0]));
  fakeDolibarr({ budget: { status: 502, json: { ok: false, error: 'config' } } });
  const bad = await read(await handleBudget(new Request('https://x.test/api/budget'), env(), {}));
  check('budget: Dolibarr down is not cached as ok', bad.ok === false);
}

// 3. Shape checks happen before Dolibarr is bothered.
{
  const calls = fakeDolibarr({});
  const no = async (data, field) => {
    const r = await read(await handlePurchase(post(data), env()));
    return r.status === 400 && r.field === field;
  };
  check('bad kind', await no(good({ kind: 'gift' }), 'kind'));
  check('bad email', await no(good({ email: 'nope' }), 'email'));
  check('reimburse with no receipt', await no(good({ files: [] }), 'files'));
  check('six receipts', await no(good({ files: Array(6).fill({ data: FILE }) }), 'files'));
  check('a receipt that is not base64 text', await no(good({ files: [{ data: 5 }] }), 'files'));
  check('a receipt too big', await no(good({ files: [{ data: 'A'.repeat(8 * 1024 * 1024) }] }), 'files'));
  check('nothing reached Dolibarr', calls.length === 0);
}

// 4. A bot that fills the hidden field is told it worked, and nothing is sent.
{
  const calls = fakeDolibarr({});
  const r = await read(await handlePurchase(post(good({ website: 'http://spam.test' })), env()));
  check('honeypot: looks like success', r.status === 200 && r.ok === true);
  check('honeypot: nothing sent to Dolibarr', calls.length === 0);
}

// 5. The three calls, in order, with the right things in them.
{
  const calls = fakeDolibarr({
    purchase: { json: { ok: true, id: 7, token: 'tok', ref: 'PR-0007' } },
    purchasefile: { json: { ok: true, files: 1 } },
    purchasefinish: { json: { ok: true, ref: 'PR-0007', needs: 'board', who: 'the treasurer and the president' } },
  });
  const r = await read(await handlePurchase(post(good({ files: [{ data: FILE }, { data: FILE }] })), env()));
  check('flow: ok with the ref and who decides', r.status === 200 && r.ok && r.ref === 'PR-0007' && r.needs === 'board' && r.who === 'the treasurer and the president');
  check('flow: purchase, two receipts, finish, in that order', calls.map((c) => c.action).join() === 'purchase,purchasefile,purchasefile,purchasefinish');
  check('flow: the email is lower-cased and the IP is passed', calls[0].body.email === 'pres@example.test' && calls[0].body.ip === '203.0.113.5');
  check('flow: the code and the zone go to Dolibarr as typed', calls[0].body.pin === '05' && calls[0].body.zone === 'Woodworking');
  check('flow: receipts carry the draft id and token', calls[1].body.id === 7 && calls[1].body.token === 'tok' && calls[1].body.data === FILE);
  check('flow: the key is sent', calls.every((c) => c.key === 'k'));
  check('flow: the code is not in the answer', !JSON.stringify(r).includes('"pin"'));
}

// 6. A request for purchase needs no receipt.
{
  const calls = fakeDolibarr({ purchase: { json: { ok: true, id: 8, token: 't', ref: 'PR-0008' } }, purchasefinish: { json: { ok: true, ref: 'PR-0008', needs: 'lead' } } });
  const r = await read(await handlePurchase(post(good({ kind: 'purchase', link: 'https://example.test/x', files: [] })), env()));
  check('purchase kind: ok with no files', r.ok && r.needs === 'lead');
  check('purchase kind: link is passed on', calls[0].body.link === 'https://example.test/x');
}

// 6b. Line items: each a link and a price, trimmed, ten at most.
{
  const calls = fakeDolibarr({ purchase: { json: { ok: true, id: 8, token: 't', ref: 'PR-0008' } }, purchasefinish: { json: { ok: true, ref: 'PR-0008', needs: 'lead' } } });
  const items = [{ link: ' https://example.test/a ', price: '12.50', extra: 'x' }, { link: 'https://example.test/b', price: '7.5' }];
  const r = await read(await handlePurchase(post(good({ kind: 'purchase', items, files: [] })), env()));
  check('items: ok', r.ok);
  check('items: passed on trimmed, nothing else', JSON.stringify(calls[0].body.items) === JSON.stringify([{ link: 'https://example.test/a', price: '12.50' }, { link: 'https://example.test/b', price: '7.5' }]));
  const many = await read(await handlePurchase(post(good({ kind: 'purchase', items: Array.from({ length: 11 }, () => ({ link: 'https://example.test/a', price: '1' })), files: [] })), env()));
  check('items: more than ten refused', many.status === 400 && many.field === 'link');
}

// 7. What Dolibarr refuses is passed on, and no receipt is sent for a refused request.
{
  let calls = fakeDolibarr({ purchase: { status: 403, json: { ok: false, error: 'notallowed', allowed: ['Crafting'] } } });
  let r = await read(await handlePurchase(post(good()), env()));
  check('not allowed: 403 with the zones they may use', r.status === 403 && r.error === 'notallowed' && r.allowed.join() === 'Crafting');
  check('not allowed: no receipt uploaded', calls.length === 1);

  calls = fakeDolibarr({ purchase: { status: 403, json: { ok: false, error: 'member', allowed: ['Secret'] } } });
  r = await read(await handlePurchase(post(good()), env()));
  check('wrong code: only "member", nothing about zones', r.status === 403 && r.error === 'member' && !('allowed' in r));

  fakeDolibarr({ purchase: { status: 429, json: { ok: false, error: 'slow' } } });
  r = await read(await handlePurchase(post(good()), env()));
  check('locked: 429', r.status === 429 && r.error === 'slow');

  fakeDolibarr({ purchase: { status: 400, json: { ok: false, error: 'late', field: 'purchase_date', days: 60 } } });
  r = await read(await handlePurchase(post(good()), env()));
  check('too old: the window is passed on', r.status === 400 && r.error === 'late' && r.days === 60);

  fakeDolibarr({ purchase: { json: { ok: true, id: 9, token: 't', ref: 'PR-0009' } }, purchasefile: { status: 400, json: { ok: false, error: 'type' } } });
  r = await read(await handlePurchase(post(good()), env()));
  check('a bad receipt: its own error', r.status === 400 && r.error === 'type');
}

// 8. Ten submissions an hour from one address.
{
  const store = new Map();
  const SUBSCRIBERS = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
  fakeDolibarr({ purchase: { status: 403, json: { ok: false, error: 'member' } } });
  let last;
  for (let i = 0; i < 11; i++) last = await read(await handlePurchase(post(good()), env({ SUBSCRIBERS })));
  check('rate limit: the eleventh try in an hour is refused', last.status === 429 && last.error === 'slow');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
