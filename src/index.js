// Cloudflare Worker entry point. Static files built by Hugo (public/) are served as assets;
// only /api/* reaches this script. See wrangler.jsonc.
import { handleContact } from './contact.js';
import { handleSubscribe, handleExport } from './subscribe.js';
import { handleCalendar, handleCalendarFeed } from './calendar.js';
import { handleFund } from './fund.js';
import { handleDiscord, discordPublicKey, runSync } from './fund-discord.js';
import { givebutterConfigured, givebutterLive } from './fund-givebutter.js';
import { handleJoin, handleGivebutterWebhook, joinConfigured } from './join.js';
import { syncDiscordEvents, discordEventsConfigured } from './discord-events.js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/contact') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleContact(request, env);
    }
    if (pathname === '/api/subscribe') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleSubscribe(request, env);
    }
    if (pathname === '/api/calendar') {
      if (request.method !== 'GET') return new Response('GET only', { status: 405 });
      return handleCalendar(request, env, ctx);
    }
    if (pathname === '/api/calendar.ics') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('GET only', { status: 405 });
      return handleCalendarFeed(request, env, ctx);
    }
    if (pathname === '/api/fund/campaigns') {
      if (request.method !== 'GET') return new Response('GET only', { status: 405 });
      return handleFund(request, env, ctx);
    }
    if (pathname === '/api/discord/interactions') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleDiscord(request, env, ctx);
    }
    if (pathname === '/api/subscribers') {
      if (request.method !== 'GET') return new Response('GET only', { status: 405 });
      return handleExport(request, env);
    }
    if (pathname.startsWith('/api/join/')) return handleJoin(request, env, pathname);
    if (pathname === '/api/givebutter-webhook') {
      if (request.method !== 'POST') return new Response('POST only', { status: 405 });
      return handleGivebutterWebhook(request, env);
    }
    if (pathname === '/api/health') {
      // Reports whether each known binding is present, so a misconfigured form is
      // diagnosable. Never reports values, and does not enumerate binding names.
      return Response.json({
        ok: true,
        configured: {
          DISCORD_WEBHOOK_URL: Boolean(env.DISCORD_WEBHOOK_URL),
          TURNSTILE_SECRET: Boolean(env.TURNSTILE_SECRET),
          CALENDAR_ICS_URL: Boolean(env.CALENDAR_ICS_URL),
          FUNDBOT_API_URL: Boolean(env.FUNDBOT_API_URL),
          FUND_DB: Boolean(env.FUND_DB),
          DISCORD_PUBLIC_KEY: Boolean(env.DISCORD_PUBLIC_KEY),
          DISCORD_PUBLIC_KEY_VALID: Boolean(discordPublicKey(env)),
          DISCORD_BOT_TOKEN: Boolean(env.DISCORD_BOT_TOKEN),
          SUBSCRIBERS: Boolean(env.SUBSCRIBERS),
          SUBSCRIBERS_EXPORT_TOKEN: Boolean(env.SUBSCRIBERS_EXPORT_TOKEN),
          DISCORD_SIGNUP_WEBHOOK_URL: Boolean(env.DISCORD_SIGNUP_WEBHOOK_URL),
          DOLIBARR: joinConfigured(env),
          DISCORD_EVENTS_SYNC: discordEventsConfigured(env),
          GIVEBUTTER_WEBHOOK_SECRET: Boolean(env.GIVEBUTTER_WEBHOOK_SECRET),
          GIVEBUTTER_API_KEY: givebutterConfigured(env),
          GIVEBUTTER_SYNC_ON: givebutterLive(env),
          FUND_LOG_CHANNEL_ID: Boolean(env.FUND_LOG_CHANNEL_ID),
        },
      });
    }
    if (pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },

  // Cron triggers (wrangler.jsonc): every five minutes, count new Givebutter
  // gifts toward the shop fund; hourly, copy upcoming calendar events to Discord.
  async scheduled(event, env, ctx) {
    if (event.cron === '*/5 * * * *') {
      if (env.FUND_DB && givebutterConfigured(env) && givebutterLive(env)) {
        ctx.waitUntil(runSync(env).catch((e) => console.error('givebutter sync failed:', e.message)));
      }
      return;
    }
    ctx.waitUntil(
      syncDiscordEvents(env).then(
        (r) => console.log('discord events sync:', r),
        (e) => console.error('discord events sync failed:', e.message),
      ),
    );
  },
};
