// Registers the /fund slash commands for one Discord server.
//
// Run this after any change to the commands below (for example the Givebutter
// subcommands: map, sync, review, assign, dismiss, history, remove), or if the
// commands go missing:
//
//   DISCORD_BOT_TOKEN=... node scripts/register-fund-commands.mjs <application id> <server id>

const [appId, guildId] = process.argv.slice(2);
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !guildId || !token) {
  console.error('usage: DISCORD_BOT_TOKEN=... node scripts/register-fund-commands.mjs <application id> <server id>');
  process.exit(1);
}

const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
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
    { type: SUB, name: 'undo', description: 'Remove the most recent hand-entered donation', options: [name()] },
    { type: SUB, name: 'map', description: 'Count Givebutter gifts toward a campaign', options: [
      name(),
      { type: STRING, name: 'fund', description: 'Givebutter Fund code (the "designate to" choice)' },
      { type: STRING, name: 'campaign', description: 'Givebutter campaign code, e.g. v7RxV6' },
      { type: STRING, name: 'keywords', description: 'Comma list; untagged gifts mentioning one go to review' },
    ] },
    { type: SUB, name: 'sync', description: 'Check Givebutter for new gifts now', options: [
      { type: BOOLEAN, name: 'full', description: 'Re-read all history, to bring in earlier gifts' },
    ] },
    { type: SUB, name: 'review', description: 'List Givebutter gifts waiting for a decision' },
    { type: SUB, name: 'assign', description: 'Count a Givebutter gift toward a campaign', options: [
      { type: STRING, name: 'transaction', description: 'Givebutter transaction id', required: true },
      name(),
    ] },
    { type: SUB, name: 'dismiss', description: 'Skip a Givebutter gift in the review list', options: [
      { type: STRING, name: 'transaction', description: 'Givebutter transaction id', required: true },
    ] },
    { type: SUB, name: 'history', description: 'List recent donations with their entry numbers', options: [name()] },
    { type: SUB, name: 'remove', description: 'Remove one donation by entry number', options: [
      name(), { type: INTEGER, name: 'entry', description: 'Entry number from /fund history', required: true },
    ] },
  ],
};

// Zone bosses ask for a new tool on the Givebutter training form. Keep the zones
// and fees in step with the form and the Dolibarr onboarding settings.
const ZONES = ['Digital Fab', 'Electronics', 'Woodworking', 'Machining', 'Metalworking', 'Crafting'];
const FEES = [5, 10, 15, 20];
const training = {
  name: 'training',
  description: 'Shop training',
  options: [
    { type: SUB, name: 'request', description: 'Ask for a tool to be added to the training payment form', options: [
      { type: STRING, name: 'tool', description: 'Tool or equipment, as trainees should see it', required: true, max_length: 150 },
      { type: STRING, name: 'zone', description: 'Zone', required: true, choices: ZONES.map((z) => ({ name: z, value: z })) },
      { type: INTEGER, name: 'fee', description: 'Training fee', required: true, choices: FEES.map((f) => ({ name: `$${f}`, value: f })) },
      { type: STRING, name: 'note', description: 'Anything the form editor should know', max_length: 300 },
    ] },
  ],
};

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify([fund, training]),
});
console.log(res.status, res.ok ? 'registered /fund and /training' : await res.text());
process.exit(res.ok ? 0 : 1);
