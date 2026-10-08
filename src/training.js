// "What am I trained on?" lookup, mounted by src/index.js:
//   POST /api/training/lookup  {email, cf-turnstile-response}
//
// Training records live in Dolibarr (the onboarding module records them from
// the Givebutter training campaign). This asks Dolibarr for one address and
// passes back tool, zone and date only. Anyone can type any address, so it is
// behind Turnstile and a per-IP hourly limit.

import { verifyTurnstile } from './turnstile.js';
import { dolibarr, joinConfigured } from './join.js';

const LOOKUPS_PER_HOUR = 20;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function handleTrainingLookup(request, env) {
  if (!joinConfigured(env)) return json({ ok: false, error: 'config' }, 503);
  let data;
  try {
    data = JSON.parse((await request.text()).slice(0, 5000));
  } catch {
    return json({ ok: false, error: 'invalid' }, 400);
  }
  const email = String(data?.email ?? '').trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'invalid' }, 400);

  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'training');
  if (!ts.ok) return json({ ok: false, error: 'captcha' }, 400);
  if (await isRateLimited(env, request.headers.get('CF-Connecting-IP') || '')) return json({ ok: false, error: 'slow' }, 429);

  const r = await dolibarr(env, 'trainings', { email });
  if (!r.data?.ok) return json({ ok: false, error: r.data?.error || 'unavailable' }, r.status >= 400 ? r.status : 502);
  const trainings = (Array.isArray(r.data.trainings) ? r.data.trainings : []).map((t) => ({
    tool: String(t.tool || ''),
    zone: String(t.zone || ''),
    date: String(t.date || ''),
  }));
  return json({ ok: true, trainings });
}

async function isRateLimited(env, ip) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `rlt:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= LOOKUPS_PER_HOUR) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}
