// Turnstile server-side verification, shared by the contact form and the email
// signup. Checking `success` alone would accept a token minted for a different
// form or on a different site, so the action and hostname are checked too.
//
// TURNSTILE_SECRET is read from the Worker's secrets. With no secret set the
// check is skipped, so the order of rollout matters: the site key in hugo.toml
// must be live (widget on the page) BEFORE the secret is added, or every
// submission is rejected for lacking a token.

export async function verifyTurnstile(request, env, token, action) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, codes: ['missing-input-response'] };

  let v;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('CF-Connecting-IP') || undefined,
      }),
    });
    v = await r.json();
  } catch {
    return { ok: false, codes: ['siteverify-unreachable'] }; // fail closed
  }

  if (!v.success) return { ok: false, codes: v['error-codes'] || [] };

  // Cloudflare's published test secrets answer for a dummy hostname with no
  // action, and flag it. The real secret never sets this flag.
  if (v.metadata && v.metadata.result_with_testing_key) return { ok: true, test: true };

  if (v.action !== action) return { ok: false, codes: ['action-mismatch'] };
  if (v.hostname !== new URL(request.url).hostname) return { ok: false, codes: ['hostname-mismatch'] };
  return { ok: true };
}
