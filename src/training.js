// Training, mounted by src/index.js:
//   POST /api/training/lookup  "What am I trained on?" {email, cf-turnstile-response}
//   POST /api/training/start   register a training before paying for it (below)
//
// The lookup:
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

// POST /api/training/start  {tool, trainer, firstname, lastname, email, cf-turnstile-response}
// The /training/pay/ page, before payment. The tool and trainer are checked
// against the catalog the site was built with (data/training.yaml, published
// at /training/catalog/), never trusted from the browser. Dolibarr keeps the
// registration and matches the Givebutter payment to it by email.
export async function handleTrainingStart(request, env) {
  if (!joinConfigured(env)) return json({ ok: false, error: 'config' }, 503);
  let data;
  try {
    data = JSON.parse((await request.text()).slice(0, 5000));
  } catch {
    return json({ ok: false, error: 'invalid' }, 400);
  }
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const email = str(data?.email, 200).toLowerCase();
  const firstname = str(data?.firstname, 100);
  const lastname = str(data?.lastname, 100);
  if (!EMAIL_RE.test(email) || !firstname || !lastname) return json({ ok: false, error: 'invalid' }, 400);

  let catalog;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/training/catalog/index.json', request.url)));
    catalog = await res.json();
  } catch {
    return json({ ok: false, error: 'config' }, 503);
  }
  const tool = (catalog.tools || []).find((t) => t.id === str(data.tool, 100));
  const trainerId = str(data.trainer, 100);
  const trainer = (catalog.trainers || []).find((t) => t.id === trainerId);
  if (!tool || !trainer || !tool.trainers.includes(trainerId)) return json({ ok: false, error: 'tool' }, 400);

  const ts = await verifyTurnstile(request, env, data['cf-turnstile-response'], 'training-pay');
  if (!ts.ok) return json({ ok: false, error: 'captcha' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (await isRateLimited(env, ip, 'rlp', 10)) return json({ ok: false, error: 'slow' }, 429);

  const r = await dolibarr(env, 'trainingstart', {
    email, firstname, lastname, ip,
    tool_id: tool.id, tool: tool.name, zone: tool.zone, fee: tool.fee,
    trainer_id: trainer.id, trainer_name: trainer.name, trainer_member: trainer.member || '',
  });
  if (!r.data?.ok) return json({ ok: false, error: r.data?.error || 'unavailable' }, r.status >= 400 ? r.status : 502);
  return json({ ok: true, amount: tool.fee });
}

async function isRateLimited(env, ip, prefix = 'rlt', limit = LOOKUPS_PER_HOUR) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `${prefix}:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= limit) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}
