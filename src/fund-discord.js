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
//   GIVEBUTTER_API_KEY, GIVEBUTTER_SYNC  see src/fund-givebutter.js
//   FUND_LOG_CHANNEL_ID  optional channel id; the Givebutter sync posts what it
//                        counted and what needs review there

import { getCampaign, totals, recentDonations } from './fund.js';
import { trainingCommand } from './training.js';
import {
  ensureGivebutterSchema,
  givebutterConfigured,
  givebutterLive,
  syncGivebutter,
  assignTransaction,
  setReview,
  GivebutterError,
} from './fund-givebutter.js';

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
  if (interaction.type === 2 && interaction.data?.name === 'training') {
    try {
      return reply(await trainingCommand(interaction, env));
    } catch (err) {
      console.error('training command failed:', err);
      return reply(message("That didn't go through. Check the website Worker's logs for details.", true));
    }
  }
  if (!env.FUND_DB) return reply(message('The fund database is not connected yet.', true));
  if (interaction.type === 4) return reply({ type: 8, data: { choices: await autocomplete(interaction, env) } });
  if (interaction.type !== 2 || interaction.data?.name !== 'fund') {
    return reply(message('Unknown command.', true));
  }

  try {
    await ensureGivebutterSchema(env.FUND_DB);
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
  const privileged = ['create', 'link', 'add', 'board', 'undo', 'map', 'sync', 'review', 'assign', 'dismiss', 'history', 'remove'];
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
      // Only hand-entered gifts: a Givebutter gift would come back on the next
      // sync. /fund remove takes those out for good.
      const { name } = opts;
      const last = await db
        .prepare('SELECT id, amount FROM donation WHERE guild_id = ? AND name = ? AND external_id IS NULL ORDER BY id DESC LIMIT 1')
        .bind(guildId, name)
        .first();
      if (!last) return message('No hand-entered donation to undo. See `/fund history` for Givebutter gifts.', true);
      await db.prepare('DELETE FROM donation WHERE id = ?').bind(last.id).run();
      ctx.waitUntil(refreshBoard(env, guildId, name));
      return message(`Removed last donation of ${money(last.amount)}.`, true);
    }

    case 'map': {
      const { name } = opts;
      if (await missing(name)) return noCampaign(name);
      const clean = (v) => String(v ?? '').trim() || null;
      const fund = clean(opts.fund);
      const campaign = clean(opts.campaign);
      const keywords = clean(opts.keywords);
      await db
        .prepare('UPDATE campaign SET gb_fund = ?, gb_campaign = ?, gb_keywords = ? WHERE guild_id = ? AND name = ?')
        .bind(fund, campaign, keywords, guildId, name)
        .run();
      if (!fund && !campaign && !keywords) {
        return message(`**${name}** is no longer linked to Givebutter. Gifts already counted stay.`, true);
      }
      const parts = [];
      if (fund) parts.push(`Fund \`${fund}\``);
      if (campaign) parts.push(`campaign \`${campaign}\``);
      const lines = [
        parts.length
          ? `Givebutter gifts to ${parts.join(' and ')} now count toward **${name}**.`
          : `No Fund or campaign code set, so nothing is counted toward **${name}** automatically.`,
      ];
      if (keywords) lines.push(`Other gifts whose message mentions ${keywords.split(',').map((k) => `"${k.trim()}"`).join(', ')} go to \`/fund review\`.`);
      lines.push('Run `/fund sync full:True` to bring in earlier gifts.');
      if (!givebutterConfigured(env)) lines.push('The Givebutter API key is not set yet, so nothing will sync until it is.');
      return message(lines.join('\n'), true);
    }

    case 'sync': {
      if (!givebutterConfigured(env)) return message('Set the GIVEBUTTER_API_KEY secret on the website Worker first.', true);
      const full = Boolean(opts.full);
      ctx.waitUntil(
        followUp(interaction, async () => {
          const r = await runSync(env, { full, fromCommand: true });
          return r.text;
        }),
      );
      return { type: 5, data: { flags: EPHEMERAL } };
    }

    case 'review': {
      const { results } = await db
        .prepare("SELECT external_id, guess, amount, donor, note, ts FROM gb_review WHERE guild_id = ? AND status = 'open' ORDER BY ts DESC LIMIT 15")
        .bind(guildId)
        .all();
      if (!results.length) return message('Nothing waiting for review.', true);
      const lines = results.map(
        (r) =>
          `\`${r.external_id}\` ${day(r.ts)} · ${money(r.amount)} · ${r.donor || 'Anonymous'}` +
          (r.note ? ` · "${r.note.slice(0, 80)}"` : '') +
          (r.guess ? ` → **${r.guess}**?` : ''),
      );
      lines.push('', 'Count one with `/fund assign`, or skip it with `/fund dismiss`.');
      return message(lines.join('\n').slice(0, 1990), true);
    }

    case 'assign': {
      const { name } = opts;
      const tx = String(opts.transaction ?? '').trim();
      if (await missing(name)) return noCampaign(name);
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(tx)) return message('Give the Givebutter transaction id, as shown in `/fund review`.', true);
      ctx.waitUntil(
        followUp(interaction, async () => {
          let r;
          try {
            r = await assignTransaction(env, guildId, tx, name);
          } catch (err) {
            return givebutterProblem(err);
          }
          if (r.error === 'no-key') return 'Set the GIVEBUTTER_API_KEY secret on the website Worker first.';
          if (r.error === 'not-found') return `Givebutter has no transaction \`${tx}\`.`;
          if (r.error === 'not-paid') return `Transaction \`${tx}\` is ${r.tx.status || 'not paid'}, so it was not counted.`;
          await refreshBoard(env, guildId, name);
          if (r.before && r.before.name !== name) await refreshBoard(env, r.before.guild_id, r.before.name);
          return `Counted ${money(r.tx.amount)} from ${r.tx.donor || 'Anonymous'} toward **${name}**.` +
            (r.before && r.before.name !== name ? ` Moved from **${r.before.name}**.` : '');
        }),
      );
      return { type: 5, data: { flags: EPHEMERAL } };
    }

    case 'dismiss': {
      const tx = String(opts.transaction ?? '').trim();
      const row = await db.prepare('SELECT guild_id, amount, donor, ts FROM gb_review WHERE external_id = ?').bind(tx).first();
      if (!row || row.guild_id !== guildId) return message(`No Givebutter gift \`${tx}\` in the review list.`, true);
      await setReview(db, guildId, tx, 'dismissed', row);
      return message(`Skipped \`${tx}\`. It won't be counted or listed again.`, true);
    }

    case 'history': {
      const { name } = opts;
      if (await missing(name)) return noCampaign(name);
      const { results } = await db
        .prepare('SELECT id, amount, donor, ts, external_id FROM donation WHERE guild_id = ? AND name = ? ORDER BY id DESC LIMIT 20')
        .bind(guildId, name)
        .all();
      if (!results.length) return message(`No donations recorded for **${name}** yet.`, true);
      const lines = results.map(
        (r) =>
          `#${r.id} · ${day(r.ts)} · ${money(r.amount)} · ${r.donor || 'Anonymous'} · ` +
          (r.external_id ? `Givebutter \`${r.external_id}\`` : 'entered by hand'),
      );
      lines.push('', 'Take one out with `/fund remove`.');
      return message(`**${name}**, latest 20\n` + lines.join('\n').slice(0, 1900), true);
    }

    case 'remove': {
      const { name, entry } = opts;
      const row = await db
        .prepare('SELECT id, amount, donor, ts, external_id FROM donation WHERE id = ? AND guild_id = ? AND name = ?')
        .bind(entry, guildId, name)
        .first();
      if (!row) return message(`No entry #${entry} in **${name}**. See \`/fund history\`.`, true);
      await db.prepare('DELETE FROM donation WHERE id = ?').bind(row.id).run();
      // Otherwise the next sync would count the Givebutter gift again.
      if (row.external_id) await setReview(db, guildId, row.external_id, 'dismissed', row);
      ctx.waitUntil(refreshBoard(env, guildId, name));
      return message(
        `Removed #${row.id}, ${money(row.amount)} from ${row.donor || 'Anonymous'}.` +
          (row.external_id ? ' The sync will leave that Givebutter gift out from now on.' : ''),
        true,
      );
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

function day(ts) {
  return String(ts || '').slice(0, 10);
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

// ---------- slow commands and the Givebutter sync ----------

// Runs work after a deferred ("thinking…") reply and puts its text in that reply.
async function followUp(interaction, work) {
  let content;
  try {
    content = await work();
  } catch (err) {
    console.error('fund follow-up failed:', err);
    content = "That didn't go through. Check the website Worker's logs for details.";
  }
  const res = await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: String(content).slice(0, 1990) }),
  });
  if (!res.ok) console.error('fund follow-up: edit failed', res.status);
}

function givebutterProblem(err) {
  if (err instanceof GivebutterError) {
    if (err.status === 401 || err.status === 403) return 'Givebutter refused the API key. Check GIVEBUTTER_API_KEY.';
    if (err.status === 429) return 'Givebutter is rate limiting us. Try again in a few minutes.';
    return `Givebutter answered ${err.status}. Try again later.`;
  }
  throw err;
}

// One sync, from the cron or /fund sync. Refreshes affected boards and posts
// what changed to FUND_LOG_CHANNEL_ID. Returns the summary as text.
export async function runSync(env, { full = false, fromCommand = false } = {}) {
  const apply = givebutterLive(env);
  let r;
  try {
    r = await syncGivebutter(env, { apply, full });
  } catch (err) {
    const text = givebutterProblem(err);
    console.error('givebutter sync:', text);
    return { text };
  }
  const text = summarize(r);
  if (apply) {
    for (const t of r.touched) await refreshBoard(env, t.guild_id, t.name);
    const changed = r.added.length || r.moved.length || r.removed.length || r.review.length;
    if (changed && env.FUND_LOG_CHANNEL_ID && env.DISCORD_BOT_TOKEN && !fromCommand) {
      const res = await discordApi(env, 'POST', `/channels/${env.FUND_LOG_CHANNEL_ID}/messages`, {
        content: text.slice(0, 1990),
        allowed_mentions: { parse: [] },
      });
      if (!res.ok) console.error('givebutter sync: log post failed', res.status);
    }
  }
  console.log(
    `givebutter sync${apply ? '' : ' (dry run)'}: ${r.scanned} read, ${r.added.length} added, ` +
      `${r.moved.length} moved, ${r.removed.length} removed, ${r.review.length} to review`,
  );
  return { text, result: r };
}

function summarize(r) {
  if (r.empty) return 'No campaign is linked to Givebutter yet. Link one with `/fund map`.';
  const lines = [r.apply ? '**Givebutter sync**' : '**Givebutter sync preview** (dry run: nothing was saved)'];
  lines.push(`Read ${r.scanned} transaction${r.scanned !== 1 ? 's' : ''}${r.full ? ', full history' : ''}.`);
  const gift = (t) => `${money(t.amount)} from ${t.donor || 'Anonymous'} (\`${t.id}\`, ${day(t.ts)})`;
  const section = (title, items, fmt) => {
    if (!items.length) return;
    lines.push('', `${title}: ${items.length}`);
    for (const t of items.slice(0, 12)) lines.push(`• ${fmt(t)}`);
    if (items.length > 12) lines.push(`• …and ${items.length - 12} more`);
  };
  section(r.apply ? 'Counted' : 'Would count', r.added, (t) => `${gift(t)} → **${t.name}**`);
  section(r.apply ? 'Moved' : 'Would move', r.moved, (t) => `${gift(t)}: **${t.from}** → **${t.name}**`);
  section(r.apply ? 'Taken out (refunded or failed)' : 'Would take out (refunded or failed)', r.removed, (t) => `${gift(t)} out of **${t.name}**`);
  section('Needs review', r.review, (t) => `${gift(t)}${t.note ? ` "${t.note.slice(0, 60)}"` : ''} → **${t.name}**?`);
  if (!r.added.length && !r.moved.length && !r.removed.length && !r.review.length) lines.push('Nothing new.');
  if (r.review.length && r.apply) lines.push('', 'See `/fund review`.');
  if (!r.apply) lines.push('', 'Set GIVEBUTTER_SYNC to `on` on the website Worker to start counting.');
  return lines.join('\n');
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
