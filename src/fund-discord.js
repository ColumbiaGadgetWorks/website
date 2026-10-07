// The Discord /fund commands, mounted at POST /api/discord/interactions.
//
// This replaces the fundbot bot's always-connected gateway client. Discord
// sends each slash command and autocomplete request here (the app's
// "Interactions Endpoint URL"), signed with the app's key; this answers it
// from the `fundraiser` D1 database. Behaviour and wording follow the old
// bot.py so nothing changes for the people using it.
//
// Bindings:
//   FUND_DB            D1 database (db/fund-schema.sql)
//   DISCORD_PUBLIC_KEY app public key (Developer Portal > General Information)
//   DISCORD_BOT_TOKEN  secret, used only to edit and pin the live /fund board
//   DONATE_URL         default donate link for new campaigns and /fund list

import { getCampaign, totals, recentDonations } from './fund.js';

const API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;
const BLURPLE = 0x5865f2;
const GREEN = 0x2ecc71;

// The app's public key as 64 hex characters, or null. Tolerates the spaces
// and line breaks a pasted secret tends to pick up.
export function discordPublicKey(env) {
  const key = String(env.DISCORD_PUBLIC_KEY || '').trim();
  return /^[0-9a-f]{64}$/i.test(key) ? key : null;
}

export async function handleDiscord(request, env, ctx) {
  const publicKey = discordPublicKey(env);
  if (!publicKey) {
    console.error('discord: DISCORD_PUBLIC_KEY is missing or not 64 hex characters');
    return new Response('Not configured', { status: 503 });
  }
  const body = await request.text();
  if (!(await verify(request, body, publicKey))) {
    console.warn('discord: rejected a request with a bad signature');
    return new Response('Bad signature', { status: 401 });
  }
  const interaction = JSON.parse(body);

  // Discord checks the endpoint with a PING before saving it; answer that even
  // before the database is bound.
  if (interaction.type === 1) return reply({ type: 1 });
  if (!env.FUND_DB) return reply(message('The fund database is not connected yet.', true));
  if (interaction.type === 4) return reply({ type: 8, data: { choices: await autocomplete(interaction, env) } });
  if (interaction.type !== 2 || interaction.data?.name !== 'fund') {
    return reply(message('Unknown command.', true));
  }

  try {
    return reply(await runCommand(interaction, env, ctx));
  } catch (err) {
    console.error('fund command failed:', err);
    return reply(message("That didn't go through. Check the website Worker's logs for details.", true));
  }
}

// ---------- signature ----------

async function verify(request, body, publicKeyHex) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

function hex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// ---------- commands ----------

async function runCommand(interaction, env, ctx) {
  const sub = interaction.data.options?.[0];
  const opts = Object.fromEntries((sub?.options || []).map((o) => [o.name, o.value]));
  const guildId = interaction.guild_id;
  if (!guildId) return message('Use this in the server.', true);

  const db = env.FUND_DB;
  const isAdmin = canManage(interaction);
  const privileged = ['create', 'link', 'add', 'board', 'undo'];
  if (privileged.includes(sub?.name) && !isAdmin) {
    return message("You don't have permission to use that.", true);
  }

  const missing = async (name) => !(await getCampaign(db, guildId, name));
  const noCampaign = (name) => message(`No campaign named **${name}**.`, true);

  switch (sub?.name) {
    case 'create': {
      const { name, goal } = opts;
      const currency = opts.currency ?? '$';
      if (!(goal > 0)) return message('Goal must be greater than zero.', true);
      const link = (opts.link || env.DONATE_URL || '').trim() || null;
      if (link && !validLink(link)) return message('Donate link must start with https://', true);
      await db
        .prepare(
          'INSERT INTO campaign (guild_id, name, goal, currency, link) VALUES (?, ?, ?, ?, ?) ' +
            'ON CONFLICT(guild_id, name) DO UPDATE SET goal = excluded.goal, currency = excluded.currency, link = excluded.link',
        )
        .bind(guildId, name, goal, currency, link)
        .run();
      ctx.waitUntil(refreshBoard(env, guildId, name));
      return message(
        `Campaign **${name}** set to ${currency}${money(goal)}.` + (link ? `\nDonate link: ${link}` : '\nNo donate link set.'),
        true,
      );
    }

    case 'link': {
      const { name } = opts;
      if (await missing(name)) return noCampaign(name);
      const url = (opts.url || '').trim() || null;
      if (url && !validLink(url)) return message('Donate link must start with https://', true);
      await db.prepare('UPDATE campaign SET link = ? WHERE guild_id = ? AND name = ?').bind(url, guildId, name).run();
      ctx.waitUntil(refreshBoard(env, guildId, name));
      return message(`Donate link for **${name}** ${url ? 'set to ' + url : 'cleared'}.`, true);
    }

    case 'add': {
      const { name, amount } = opts;
      if (await missing(name)) return noCampaign(name);
      await db
        .prepare('INSERT INTO donation (guild_id, name, amount, donor, ts) VALUES (?, ?, ?, ?, ?)')
        .bind(guildId, name, amount, opts.donor ?? null, new Date().toISOString())
        .run();
      ctx.waitUntil(refreshBoard(env, guildId, name));
      return campaignMessage(db, guildId, name);
    }

    case 'show': {
      const { name } = opts;
      if (await missing(name)) return noCampaign(name);
      return campaignMessage(db, guildId, name);
    }

    case 'list':
      return listMessage(db, guildId, env);

    case 'board': {
      const { name } = opts;
      if (await missing(name)) return noCampaign(name);
      // Post now; once Discord has created the message, pin it and remember it.
      ctx.waitUntil(rememberBoard(env, interaction, name));
      return campaignMessage(db, guildId, name);
    }

    case 'undo': {
      const { name } = opts;
      const last = await db
        .prepare('SELECT id, amount FROM donation WHERE guild_id = ? AND name = ? ORDER BY id DESC LIMIT 1')
        .bind(guildId, name)
        .first();
      if (!last) return message('Nothing to undo.', true);
      await db.prepare('DELETE FROM donation WHERE id = ?').bind(last.id).run();
      ctx.waitUntil(refreshBoard(env, guildId, name));
      return message(`Removed last donation of ${money(last.amount)}.`, true);
    }

    default:
      return message('Unknown command.', true);
  }
}

function canManage(interaction) {
  try {
    const p = BigInt(interaction.member?.permissions ?? '0');
    return (p & MANAGE_GUILD) !== 0n || (p & ADMINISTRATOR) !== 0n;
  } catch {
    return false;
  }
}

async function autocomplete(interaction, env) {
  const sub = interaction.data.options?.[0];
  const focused = (sub?.options || []).find((o) => o.focused);
  const current = String(focused?.value ?? '');
  const { results } = await env.FUND_DB
    .prepare('SELECT name FROM campaign WHERE guild_id = ? AND name LIKE ? LIMIT 25')
    .bind(interaction.guild_id, `%${current}%`)
    .all();
  return results.map((r) => ({ name: r.name, value: r.name }));
}

// ---------- rendering (one place, so the donate link is never missed) ----------

async function campaignMessage(db, guildId, name) {
  const row = await getCampaign(db, guildId, name);
  return { type: 4, data: { embeds: [await buildEmbed(db, guildId, row)], components: donateButtons(row.link) } };
}

async function buildEmbed(db, guildId, row) {
  const { name, goal, currency: cur, link } = row;
  const { raised, count } = await totals(db, guildId, name);
  const pct = goal ? raised / goal : 0;
  const fields = [
    { name: 'Raised', value: `${cur}${money(raised)}`, inline: true },
    { name: 'Goal', value: `${cur}${money(goal)}`, inline: true },
    { name: 'Remaining', value: `${cur}${money(Math.max(0, goal - raised))}`, inline: true },
  ];
  const recent = await recentDonations(db, guildId, name, 5);
  if (recent.length) {
    fields.push({
      name: 'Recent',
      value: recent.map((d) => `${d.donor || 'Anonymous'} — ${cur}${money(d.amount)}`).join('\n'),
      inline: false,
    });
  }
  if (validLink(link)) fields.push({ name: 'Give', value: `[Donate to ${name}](${link})`, inline: false });

  return {
    title: `\u{1F3AF} ${name}`,
    url: validLink(link) ? link : undefined,
    description: `\`${bar(pct)}\`  **${(pct * 100).toFixed(1)}%**`,
    color: pct >= 1 ? GREEN : BLURPLE,
    timestamp: new Date().toISOString(),
    fields,
    footer: { text: `${count} donation${count !== 1 ? 's' : ''} · updated` },
  };
}

async function listMessage(db, guildId, env) {
  const { results: rows } = await db
    .prepare('SELECT name, goal, currency, link FROM campaign WHERE guild_id = ? ORDER BY name')
    .bind(guildId)
    .all();
  if (!rows.length) return message('No campaigns yet. Start one with `/fund create`.', true);

  let grandRaised = 0;
  let grandGoal = 0;
  const fields = [];
  for (const r of rows) {
    const { raised, count } = await totals(db, guildId, r.name);
    grandRaised += raised;
    grandGoal += r.goal;
    const pct = r.goal ? raised / r.goal : 0;
    let value =
      `\`${bar(pct, 16)}\` **${Math.round(pct * 100)}%**\n` +
      `${r.currency}${money(raised)} of ${r.currency}${money(r.goal)} · ${count} gift${count !== 1 ? 's' : ''}`;
    if (validLink(r.link)) value += ` · [Donate](${r.link})`;
    fields.push({ name: (pct >= 1 ? '✅ ' : '') + r.name, value, inline: false });
  }
  return {
    type: 4,
    data: {
      embeds: [
        {
          title: '\u{1F4CB} Active fundraisers',
          color: BLURPLE,
          timestamp: new Date().toISOString(),
          fields,
          footer: {
            text: `${rows.length} campaign${rows.length !== 1 ? 's' : ''} · ${money(grandRaised)} of ${money(grandGoal)} overall`,
          },
        },
      ],
      // Button uses the shared default link, since campaigns may differ.
      components: donateButtons(env.DONATE_URL),
    },
  };
}

function donateButtons(url) {
  if (!validLink(url)) return [];
  return [{ type: 1, components: [{ type: 2, style: 5, label: 'Donate', url, emoji: { name: '\u{1F49B}' } }] }];
}

function message(content, ephemeral) {
  return { type: 4, data: { content, flags: ephemeral ? EPHEMERAL : 0 } };
}

function reply(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });
}

function bar(pct, width = 22) {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function money(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function validLink(url) {
  return Boolean(url) && String(url).startsWith('https://');
}

// ---------- the pinned live board ----------

async function discordApi(env, method, path, body) {
  return fetch(API + path, {
    method,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'columbiagadgetworks.org fund (https://columbiagadgetworks.org, 1)',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Edit the pinned tracker message, if one exists. A board that was deleted or
// can no longer be reached is forgotten, as the old bot did.
async function refreshBoard(env, guildId, name) {
  if (!env.DISCORD_BOT_TOKEN) return;
  const row = await getCampaign(env.FUND_DB, guildId, name);
  if (!row || !row.channel_id || !row.message_id) return;
  const res = await discordApi(env, 'PATCH', `/channels/${row.channel_id}/messages/${row.message_id}`, {
    embeds: [await buildEmbed(env.FUND_DB, guildId, row)],
    components: donateButtons(row.link),
  });
  if (res.status === 404 || res.status === 403) {
    await env.FUND_DB
      .prepare('UPDATE campaign SET channel_id = NULL, message_id = NULL WHERE guild_id = ? AND name = ?')
      .bind(guildId, name)
      .run();
  } else if (!res.ok) {
    console.error('board refresh failed:', res.status, await res.text());
  }
}

async function rememberBoard(env, interaction, name) {
  // The response is sent before this runs; give Discord a moment to create it.
  let original = null;
  for (let attempt = 0; attempt < 5 && !original; attempt++) {
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    const res = await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`);
    if (res.ok) original = await res.json();
  }
  if (!original) {
    console.error('board: could not read the posted message');
    return;
  }
  if (env.DISCORD_BOT_TOKEN) {
    // Missing Manage Messages just means an unpinned board, as before.
    const pin = await discordApi(env, 'PUT', `/channels/${interaction.channel_id}/messages/pins/${original.id}`);
    if (!pin.ok) console.warn('board: pin failed', pin.status);
  }
  await env.FUND_DB
    .prepare('UPDATE campaign SET channel_id = ?, message_id = ? WHERE guild_id = ? AND name = ?')
    .bind(interaction.channel_id, original.id, interaction.guild_id, name)
    .run();
}
