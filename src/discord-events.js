// Keeps the Discord server's Events list in step with the website calendar.
// Run hourly by the cron trigger in wrangler.jsonc (scheduled() in src/index.js).
//
// Every timed event in the next DISCORD_EVENTS_DAYS days becomes a Discord
// scheduled event at the event's location. An event changed on the calendar is
// changed in Discord, and one removed from the calendar is removed from Discord.
// Only events this bot created are ever edited or deleted, so events people add
// in Discord by hand are left alone. All-day entries (closures, notices) are not
// sent: Discord shows every event as something to attend at a time.
//
// Bindings:
//   DISCORD_BOT_TOKEN  (secret) the same bot as /fund. Its role needs the
//                      "Create Events" permission (or "Manage Events").
//   DISCORD_GUILD_ID   (var, optional) the server. When unset, the server is
//                      found automatically if the bot is in exactly one.
//   DISCORD_EVENTS_DAYS (var, optional) how far ahead to post, default 14.
//   CALENDAR_ICS_URL   (secret) the calendar, see src/calendar.js.

import { occurrences } from './calendar.js';

const API = 'https://discord.com/api/v10';
const DEFAULT_DAYS = 14;
const MAX_WRITES = 25; // per run, well inside Discord's rate limits and the Worker's subrequest budget
const DEFAULT_LOCATION = 'Columbia Gadget Works, 1404 Grand Ave, Columbia, MO 65203';
const MORE = 'https://columbiagadgetworks.org/calendar/';
const SCHEDULED = 1;

export function discordEventsConfigured(env) {
  return Boolean(env.DISCORD_BOT_TOKEN && env.CALENDAR_ICS_URL);
}

export async function syncDiscordEvents(env) {
  if (!discordEventsConfigured(env)) return 'not configured';

  const me = await api(env, 'GET', '/users/@me');
  if (!me.ok) throw new Error(`Discord /users/@me answered ${me.status}`);
  const botId = me.data.id;

  let guildId = env.DISCORD_GUILD_ID;
  if (!guildId) {
    const guilds = await api(env, 'GET', '/users/@me/guilds');
    if (!guilds.ok || guilds.data.length !== 1) {
      throw new Error('set DISCORD_GUILD_ID: the bot is in ' + (guilds.ok ? guilds.data.length : '?') + ' servers');
    }
    guildId = guilds.data[0].id;
  }

  const days = Math.min(Math.max(parseInt(env.DISCORD_EVENTS_DAYS || '', 10) || DEFAULT_DAYS, 1), 60);
  const now = Date.now();
  // A little past now: Discord refuses an event that starts in the past.
  const from = new Date(now + 5 * 60 * 1000);
  const to = new Date(now + days * 864e5);
  const wanted = new Map();
  for (const o of await occurrences(env, new Date(now - 864e5), to)) {
    if (o.allDay || new Date(o.start) < from) continue;
    const ev = toDiscord(o);
    wanted.set(keyOf(ev.name, ev.scheduled_start_time), ev);
  }

  const listed = await api(env, 'GET', `/guilds/${guildId}/scheduled-events`);
  if (!listed.ok) throw new Error(`listing events answered ${listed.status}`);
  const ours = listed.data.filter((e) => e.creator_id === botId && e.status === SCHEDULED);

  let writes = 0, created = 0, updated = 0, removed = 0, failed = 0;
  const write = async (method, path, body) => {
    if (writes >= MAX_WRITES) return null;
    writes++;
    const r = await api(env, method, path, body);
    if (!r.ok) {
      failed++;
      console.error('discord events:', method, path, r.status, JSON.stringify(r.data).slice(0, 300));
    }
    return r.ok;
  };

  for (const e of ours) {
    const key = keyOf(e.name, e.scheduled_start_time);
    const want = wanted.get(key);
    if (!want) {
      if (await write('DELETE', `/guilds/${guildId}/scheduled-events/${e.id}`)) removed++;
      continue;
    }
    wanted.delete(key);
    if (differs(e, want) && (await write('PATCH', `/guilds/${guildId}/scheduled-events/${e.id}`, want))) updated++;
  }
  for (const want of wanted.values()) {
    if (await write('POST', `/guilds/${guildId}/scheduled-events`, want)) created++;
  }
  const left = writes >= MAX_WRITES ? ' (more next run)' : '';
  return `${created} created, ${updated} updated, ${removed} removed, ${failed} failed${left}`;
}

function toDiscord(o) {
  const text = plain(o.description || '');
  const footer = `More: ${MORE}`;
  const room = 1000 - footer.length - 2;
  const body = text.length > room ? text.slice(0, room - 3).replace(/\s+\S*$/, '') + '...' : text;
  return {
    name: o.title.slice(0, 100),
    privacy_level: 2,
    entity_type: 3, // external: somewhere other than a Discord channel
    entity_metadata: { location: (o.location || DEFAULT_LOCATION).slice(0, 100) },
    // Normalised to whole seconds so a re-read compares equal to what Discord echoes back.
    scheduled_start_time: iso(o.start),
    scheduled_end_time: iso(o.end && o.end > o.start ? o.end : new Date(new Date(o.start).getTime() + 36e5).toISOString()),
    description: body ? `${body}\n\n${footer}` : footer,
  };
}

function differs(e, want) {
  return (
    iso(e.scheduled_end_time) !== want.scheduled_end_time ||
    (e.description || '') !== want.description ||
    ((e.entity_metadata && e.entity_metadata.location) || '') !== want.entity_metadata.location
  );
}

function keyOf(name, start) {
  return `${iso(start)}|${name}`;
}

function iso(t) {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Google Calendar descriptions are often HTML. Discord shows plain text.
function plain(s) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (m, href, label) => (label.includes(href) ? label : `${label} (${href})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function api(env, method, path, body, retried) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'columbiagadgetworks.org calendar sync (https://columbiagadgetworks.org, 1)',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // One short wait on a rate limit; anything longer is left for the next run.
  if (res.status === 429 && !retried) {
    const wait = Number((await res.clone().json().catch(() => ({}))).retry_after || 1);
    if (wait <= 5) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      return api(env, method, path, body, true);
    }
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
