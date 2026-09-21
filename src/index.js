// Cloudflare Worker entry point. Static files built by Hugo (public/) are served as assets;
// only /api/* reaches this script. See wrangler.jsonc.
import { handleContact } from './contact.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/contact') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleContact(request, env);
    }
    if (pathname === '/api/health') {
      // Reports which secrets are present (names only, never values) so a misconfigured form is diagnosable.
      return Response.json({
        ok: true,
        configured: {
          DISCORD_WEBHOOK_URL: Boolean(env.DISCORD_WEBHOOK_URL),
          TURNSTILE_SECRET: Boolean(env.TURNSTILE_SECRET),
        },
        envKeys: Object.keys(env).filter(k => k !== 'ASSETS').sort(),
      });
    }
    if (pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
