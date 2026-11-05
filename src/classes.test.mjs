// Tests for the free class handlers in classes.js.
// Run from the repository root with:  node src/classes.test.mjs
// Dolibarr is a fake fetch, so this checks what the Worker sends, refuses and
// answers, not Dolibarr's own rules (the module's sandbox tests cover those).
import { handleClasses } from './classes.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`); }
}

const env = (extra = {}) => ({ DOLIBARR_URL: 'https://dolibarr.example.test', DOLIBARR_API_KEY: 'k', ...extra });
function fakeDolibarr(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const action = new URL(url).searchParams.get('action');
    calls.push({ action, body: init?.body ? JSON.parse(init.body) : {} });
    const a = answers[action] || { status: 200, json: { ok: true } };
    return new Response(JSON.stringify(a.json), { status: a.status || 200, headers: { 'content-type': 'application/json' } });
  };
  return calls;
}
const get = () => new Request('https://columbiagadgetworks.org/api/classes');
const post = (data) => new Request('https://columbiagadgetworks.org/api/classes/signup', {
  method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: JSON.stringify(data),
});
const read = async (res) => ({ status: res.status, ...(await res.json()) });
const good = (over = {}) => ({ id: 4, name: 'Ann Newcomer', email: 'Ann@Example.test', updates: true, ...over });

// 1. Not configured.
{
  const r = await read(await handleClasses(get(), {}, null, '/api/classes'));
  check('list not configured: 503', r.status === 503 && r.error === 'config');
}

// 2. The list: known fields only, numbers as numbers.
{
  fakeDolibarr({ freeclasses: { json: { ok: true, classes: [{ id: '4', kind: 'oca', title: 'Soldering', description: 'Badges', start: '2026-12-02T00:00:00Z', when: 'Tuesday 1 December, 6:00 PM to 8:00 PM', minutes: 120, seats: '12', left: '3', full: false, sponsor: 'City', email: 'x@y.test', signups: [1] }] } } });
  const r = await read(await handleClasses(get(), env(), null, '/api/classes'));
  check('list: ok', r.status === 200 && r.ok && r.classes.length === 1);
  check('list: numbers', r.classes[0].id === 4 && r.classes[0].seats === 12 && r.classes[0].left === 3);
  check('list: nothing else passed on', !('email' in r.classes[0]) && !('signups' in r.classes[0]));
  fakeDolibarr({ freeclasses: { status: 502, json: { ok: false, error: 'unreachable' } } });
  const bad = await read(await handleClasses(get(), env(), null, '/api/classes'));
  check('list: Dolibarr down is an error', bad.ok === false);
}

// 3. Signing up: checked here first, then passed on lower-cased with the IP.
{
  let calls = fakeDolibarr({ freeclasssignup: { json: { ok: true, result: 'signed', left: 2 } } });
  const r = await read(await handleClasses(post(good()), env(), null, '/api/classes/signup'));
  check('signup: ok with seats left', r.ok && r.left === 2);
  check('signup: email lower-cased, IP and the tick passed', calls[0].body.email === 'ann@example.test' && calls[0].body.ip === '203.0.113.9' && calls[0].body.updates === true && calls[0].body.id === 4);
  check('signup: whether the email was known is not passed on', !('result' in r));

  calls = fakeDolibarr({});
  check('signup: a name is needed', (await read(await handleClasses(post(good({ name: 'A' })), env(), null, '/api/classes/signup'))).field === 'name');
  check('signup: an email is needed', (await read(await handleClasses(post(good({ email: 'nope' })), env(), null, '/api/classes/signup'))).field === 'email');
  check('signup: a class is needed', (await read(await handleClasses(post(good({ id: 0 })), env(), null, '/api/classes/signup'))).error === 'closed');
  check('signup: nothing sent for those', calls.length === 0);
  const bot = await read(await handleClasses(post(good({ website: 'spam' })), env(), null, '/api/classes/signup'));
  check('signup: a bot is told ok and nothing is sent', bot.ok && calls.length === 0);
}

// 4. What Dolibarr refuses comes back plainly.
{
  fakeDolibarr({ freeclasssignup: { status: 409, json: { ok: false, error: 'full' } } });
  let r = await read(await handleClasses(post(good()), env(), null, '/api/classes/signup'));
  check('full: 409', r.status === 409 && r.error === 'full');
  fakeDolibarr({ freeclasssignup: { status: 500, json: { ok: false, error: 'server', detail: 'SQL said no' } } });
  r = await read(await handleClasses(post(good()), env(), null, '/api/classes/signup'));
  check('server trouble: unavailable, no detail', r.status === 503 && r.error === 'unavailable' && !('detail' in r));
}

// 5. Rate limit per address.
{
  const kv = new Map();
  const SUBSCRIBERS = { get: async (k) => kv.get(k) || null, put: async (k, v) => { kv.set(k, v); } };
  fakeDolibarr({ freeclasssignup: { json: { ok: true, left: 1 } } });
  let last;
  for (let i = 0; i < 11; i++) last = await read(await handleClasses(post(good()), env({ SUBSCRIBERS }), null, '/api/classes/signup'));
  check('rate limit: the eleventh in an hour is refused', last.status === 429 && last.error === 'slow');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
