// Registers the /fund slash commands for one Discord server.
//
// Not needed for the switch from the fundbot bot: Discord keeps the commands
// the bot registered, and they reach the website as soon as the app's
// Interactions Endpoint URL points at it. Run this only if the commands go
// missing or their options change:
//
//   DISCORD_BOT_TOKEN=... node scripts/register-fund-commands.mjs <application id> <server id>

const [appId, guildId] = process.argv.slice(2);
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !guildId || !token) {
  console.error('usage: DISCORD_BOT_TOKEN=... node scripts/register-fund-commands.mjs <application id> <server id>');
  process.exit(1);
}

const STRING = 3;
const NUMBER = 10;
const SUB = 1;
const name = (autocomplete = true) => ({ type: STRING, name: 'name', description: 'Campaign name', required: true, autocomplete });

const fund = {
  name: 'fund',
  description: 'Fundraising tracker',
  options: [
    { type: SUB, name: 'create', description: 'Create or update a campaign goal', options: [
      name(false),
      { type: NUMBER, name: 'goal', description: 'Goal amount', required: true },
      { type: STRING, name: 'currency', description: 'Currency symbol (default $)' },
      { type: STRING, name: 'link', description: 'Donate link (https://)' },
    ] },
    { type: SUB, name: 'link', description: "Set or clear a campaign's donate link", options: [
      name(), { type: STRING, name: 'url', description: 'Donate link (https://); leave empty to clear' },
    ] },
    { type: SUB, name: 'add', description: 'Log a donation', options: [
      name(), { type: NUMBER, name: 'amount', description: 'Amount', required: true },
      { type: STRING, name: 'donor', description: 'Donor name (leave empty for Anonymous)' },
    ] },
    { type: SUB, name: 'show', description: 'Show current progress', options: [name()] },
    { type: SUB, name: 'list', description: 'List every active fundraiser' },
    { type: SUB, name: 'board', description: 'Post a live-updating tracker in this channel', options: [name()] },
    { type: SUB, name: 'undo', description: 'Remove the most recent donation', options: [name()] },
  ],
};

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify([fund]),
});
console.log(res.status, res.ok ? 'registered /fund' : await res.text());
process.exit(res.ok ? 0 : 1);
