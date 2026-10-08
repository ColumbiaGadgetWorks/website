// Training records live in Dolibarr (the onboarding module). This file has:
//
//   POST /api/training/lookup  "What am I trained on?", mounted by src/index.js
//   /training request          Discord command, routed here by src/fund-discord.js
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

// /training request tool:<name> zone:<zone> fee:<5|10|15|20> [note]
// Files a request in Dolibarr to add a tool to the Givebutter training form;
// whoever edits the form is emailed and marks it done there.
export async function trainingCommand(interaction, env) {
  const sub = interaction.data.options?.[0];
  const opts = Object.fromEntries((sub?.options || []).map((o) => [o.name, o.value]));
  if (sub?.name !== 'request') return say('Unknown command.');
  if (!joinConfigured(env)) return say('Training requests are not connected to Dolibarr yet.');
  const user = interaction.member?.user || interaction.user || {};
  const r = await dolibarr(env, 'toolrequest', {
    tool: String(opts.tool ?? ''),
    zone: String(opts.zone ?? ''),
    price: Number(opts.fee),
    note: String(opts.note ?? ''),
    requested_by: user.username || '',
  });
  const d = r.data || {};
  if (d.ok) {
    return say(
      `Asked for **${opts.tool}** (${opts.zone}, $${opts.fee}) to be added to the training form. ` +
        (d.notify ? 'You will get an email when it is on.' : 'Your Discord name is not on a member card, so watch the form or ask in the server.'),
    );
  }
  const why = {
    exists: d.status === 'active' ? 'That tool is already on the training form.' : 'That tool has already been requested.',
    zone: 'Pick one of the zones offered.',
    price: 'Pick one of the fees offered.',
    tool: 'Give the tool or equipment a name.',
  };
  return say(why[d.error] || "That didn't go through. Try again later.");
}

function say(content) {
  return { type: 4, data: { content, flags: 64 } };
}

async function isRateLimited(env, ip) {
  if (!env.SUBSCRIBERS || !ip) return false;
  const key = `rlt:${ip}`;
  const n = parseInt((await env.SUBSCRIBERS.get(key)) || '0', 10);
  if (n >= LOOKUPS_PER_HOUR) return true;
  await env.SUBSCRIBERS.put(key, String(n + 1), { expirationTtl: 3600 });
  return false;
}
