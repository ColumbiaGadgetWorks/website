// Cloudflare Pages Function: POST /api/contact
// Forwards the contact form to a Discord channel via webhook. No third-party form service needed.
// Environment variables (Pages → Settings → Variables and Secrets):
//   DISCORD_WEBHOOK_URL  (secret, required)  — a webhook for the #website-contact channel
//   TURNSTILE_SECRET     (secret, optional)  — enables Cloudflare Turnstile verification when the
//                                              site key is also set in hugo.toml (params.turnstileSiteKey)
//
// Rollout order matters: deploy the site key in hugo.toml FIRST, then add TURNSTILE_SECRET.
// If the secret exists but the page has no widget, no token is sent and every submission is
// rejected with ?error=captcha (the page now shows that error, but nothing gets delivered).
export async function onRequestPost({ request, env }) {
  const ct = request.headers.get('content-type') || '';
  let data;
  if (ct.includes('application/json')) data = await request.json();
  else data = Object.fromEntries((await request.formData()).entries());

  const name = (data.name || '').toString().trim().slice(0, 120);
  const email = (data.email || '').toString().trim().slice(0, 200);
  const topic = (data.topic || '').toString().trim().slice(0, 120);
  const message = (data.message || '').toString().trim().slice(0, 4000);
  const honeypot = (data.website || '').toString();
  const redirect = safeRedirect(data.redirect);

  if (honeypot) return done(request, redirect, 200); // bot: pretend success
  if (!name || !email || !message || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return done(request, '/contact/?error=1', 400, 'Missing or invalid fields');

  if (env.TURNSTILE_SECRET) {
    const token = data['cf-turnstile-response'];
    const ip = request.headers.get('CF-Connecting-IP');
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
    }).then(r => r.json()).catch(() => ({ success: false }));
    if (!v.success) return done(request, '/contact/?error=captcha', 400, 'Captcha failed');
  }

  if (!env.DISCORD_WEBHOOK_URL) return done(request, '/contact/?error=config', 500, 'Form not configured');

  const payload = {
    username: 'Website contact form',
    embeds: [{
      title: topic || 'Contact form message',
      color: 0xBF4D28,
      fields: [
        { name: 'From', value: `${name} <${email}>` },
        { name: 'Message', value: message.slice(0, 1024) || '(empty)' },
      ],
      timestamp: new Date().toISOString(),
    }],
  };
  if (message.length > 1024) payload.content = message.slice(1024, 3000);

  const r = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!r.ok) return done(request, '/contact/?error=send', 502, 'Could not deliver message');
  return done(request, redirect, 200);
}

export function onRequestGet() {
  return new Response('POST only', { status: 405 });
}

function safeRedirect(v) {
  const s = (v || '/contact/?sent=1').toString();
  return s.startsWith('/') && !s.startsWith('//') ? s : '/contact/?sent=1';
}

function done(request, redirect, status, error) {
  const wantsJson = (request.headers.get('accept') || '').includes('application/json');
  if (wantsJson) return Response.json(error ? { ok: false, error } : { ok: true }, { status });
  return Response.redirect(new URL(redirect, request.url).toString(), 303);
}
