// Registers the /fund slash commands for one Discord server.
//
// Funds and gifts come from Givebutter, so the commands only look at them
// (list, show, board), set a goal, or run the sync. Run this after any change
// to the commands below, or if the commands go missing:
//
//   DISCORD_BOT_TOKEN=... node scripts/register-fund-commands.mjs <application id> <server id>

const [appId, guildId] = process.argv.slice(2);
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !guildId || !token) {
  console.error('usage: DISCORD_BOT_TOKEN=... node scripts/register-fund-commands.mjs <application id> <server id>');
  process.exit(1);
}

const STRING = 3;
const BOOLEAN = 5;
const NUMBER = 10;
const SUB = 1;
const name = () => ({ type: STRING, name: 'name', description: 'Fund name', required: true, autocomplete: true });

const fund = {
  name: 'fund',
  description: 'Fundraising tracker',
  options: [
    { type: SUB, name: 'show', description: 'Show current progress', options: [name()] },
    { type: SUB, name: 'list', description: 'List every fund' },
    { type: SUB, name: 'board', description: 'Post a live-updating tracker in this channel', options: [name()] },
    { type: SUB, name: 'goal', description: 'Set or clear a fund goal', options: [
      name(), { type: NUMBER, name: 'amount', description: 'Goal amount; leave empty for no goal' },
    ] },
    { type: SUB, name: 'sync', description: 'Check Givebutter for new funds and gifts now', options: [
      { type: BOOLEAN, name: 'full', description: 'Re-read all history, to bring in earlier gifts' },
    ] },
  ],
};

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify([fund]),
});
console.log(res.status, res.ok ? 'registered /fund' : await res.text());
process.exit(res.ok ? 0 : 1);
