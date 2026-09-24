// Cloudflare Worker entry point. Static files built by Hugo (public/) are served as assets;
// only /api/* reaches this script. See wrangler.jsonc.
import { handleContact } from './contact.js';
import { handleSubscribe, handleExport } from './subscribe.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/contact') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleContact(request, env);
    }
    if (pathname === '/api/subscribe') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleSubscribe(request, env);
    }
    if (pathname === '/api/subscribers') {
      if (request.method !== 'GET') return new Response('GET only', { status: 405 });
      return handleExport(request, env);
    }
    if (pathname === '/api/health') {
      // Reports whether each known binding is present, so a misconfigured form is
      // diagnosable. Never reports values, and does not enumerate binding names.
      return Response.json({
        ok: true,
        configured: {
          DISCORD_WEBHOOK_URL: Boolean(env.DISCORD_WEBHOOK_URL),
          TURNSTILE_SECRET: Boolean(env.TURNSTILE_SECRET),
          SUBSCRIBERS: Boolean(env.SUBSCRIBERS),
          SUBSCRIBERS_EXPORT_TOKEN: Boolean(env.SUBSCRIBERS_EXPORT_TOKEN),
          DISCORD_SIGNUP_WEBHOOK_URL: Boolean(env.DISCORD_SIGNUP_WEBHOOK_URL),
        },
      });
    }
    if (pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};
