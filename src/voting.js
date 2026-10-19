// Member votes. Dolibarr runs them (class/vote.class.php in the onboarding
// module): the Secretary and the President work them from their email buttons,
// and every voter gets a personal ballot link by email. The site only shows those
// pages and lets a voter ask for a lost ballot email again.
//
//   GET|POST /voting/link/?v=…&m=…&w=…&k=…  the email buttons (ballot, running for
//                                            a seat, the officers' panel), shown
//                                            inside the site from Dolibarr's
//                                            public/vote.php
//   POST /api/voting/resend  {email, pin, cf-turnstile-response}
//                            Dolibarr emails the ballot link again to the address
//                            on the member card if the email and the last two
//                            digits of the member number match. The answer is the
//                            same either way, so it tells nobody who can vote.
//
// Uses DOLIBARR_URL and DOLIBARR_API_KEY (see src/join.js), TURNSTILE_SECRET if set,
// and the SUBSCRIBERS KV for the per-address limit.
import { verifyTurnstile } from './turnstile.js';
import { dolibarr, joinConfigured } from './join.js';
import { proxyLinkPage } from './training.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RESENDS_PER_HOUR = 10;

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const fail = (error, status) => json({ ok: false, error }, status);

export function handleVotingLink(request, env) {
  return proxyLinkPage(request, env, { file: 'vote.php', shell: '/voting/link/', marker: 'VOTING_LINK', title: 'Member vote' });
}

export async function handleVoting(request, env, pathname) {
  if (pathname !== '/api/voting/resend') return fail('not-found', 404);
  if (request.method !== 'POST') return new Response('POST only', { status: 405 });
  if (!joinConfigured(env)) return fail('unavailable', 503);
  let data;
  try {
    const text = await request.text();
    data = text.length < 4000 ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const email = String(data?.email || '').trim().toLowerCase().slice(0, 200);
  const pin = String(data?.pin || '').trim();
  if (!EMAIL_RE.test(email) || !/^\d{1,2}$/.test(pin)) return fail('invalid', 400);
  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'voting');
  if (!ts.ok) return fail('captcha', 400);
  if (await isRateLimited(env, request.headers.get('CF-Connecting-IP') || '')) return fail('slow', 429);
  const r = await dolibarr(env, 'voteresend', { email, pin });
  if (r.status >= 500 || !r.data?.ok) return fail('unavailable', 503);
  return json({ ok: true });
}

async function isRateLimited(env, ip) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `rlv:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= RESENDS_PER_HOUR) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}
