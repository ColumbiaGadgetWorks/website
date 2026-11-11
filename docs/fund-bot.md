# The /fund Discord commands: history, decisions and caveats

Setup and the Givebutter sync are in the README ("Shop fund database and the
/fund Discord commands"). This file keeps what came over from the retired
`fundbot` repository: what each command does and who may run it, why things
are built the way they are, and the known sharp edges.

## History

The commands started as **fundbot** (`github.com/adman234/fundbot`, now
archived): a Python process with a discord.py bot and an aiohttp web page in one
Docker container on an Unraid server, storing everything in SQLite. Its page
served the shop touchscreen at `fundbot.adman.casa`.

In October 2026 everything moved into this site:

| fundbot | Now |
|---|---|
| `bot.py`, always connected to the Discord gateway | `src/fund-discord.js`, answers each command at `/api/discord/interactions`; no process runs |
| SQLite file in the container | `fundraiser` D1 database, same tables (`db/fund-schema.sql`), Discord ids stored as text |
| `/api/campaigns` | `/api/fund/campaigns` (`src/fund.js`), same JSON |
| `web/index.html` | `layouts/kiosk.html`, served at `/kiosk/` |
| `/fund add` only | `/fund add` plus the Givebutter sync (`src/fund-givebutter.js`) |

The command names, options and reply wording were kept so nothing changed for
the people using them.

Decisions from fundbot that no longer apply, because there is no container any
more: self-hosting instead of a free bot host, the hand-built Unraid template,
the GHCR image, running the web server inside the bot process, and synchronous
SQLite.

## Commands

The original commands. The Givebutter ones (`map`, `sync`, `review`, `assign`,
`dismiss`, `history`, `remove`) are in the README.

| Command | Who | Does |
|---|---|---|
| `/fund list` | anyone | every campaign, with progress and donate links |
| `/fund show <name>` | anyone | one campaign in detail |
| `/fund create <name> <goal> [currency] [link]` | Manage Server | create or update a campaign |
| `/fund link <name> [url]` | Manage Server | set or clear the donate link |
| `/fund add <name> <amount> [donor]` | Manage Server | log a donation |
| `/fund board <name>` | Manage Server | pin a live-updating tracker |
| `/fund undo <name>` | Manage Server | remove the most recent hand-entered donation |

"Manage Server" also lets Administrators through. `list` and `show` are public
on purpose.

## Decisions that still hold

### Link buttons, not interactive components

The Donate button on replies and pinned boards is a link button (style 5),
which sends nothing back when pressed. A pinned board therefore keeps a working
button forever with nothing to register. A button with a callback would need
the Worker to answer component interactions, and changing the style would break
every board already pinned.

### Donate link stored per campaign, with a default

`DONATE_URL` seeds new campaigns, but each campaign row has its own `link`, so
separate fundraisers can point at separate pages. With Givebutter Funds one
donation page now serves every goal, so most campaigns can share the default.

### Kiosk layout keyed on `?kiosk`, not on screen shape

The shop touchscreen (a portrait Debian PC running Firefox in kiosk mode under
kiosk-manager) loads the page with `?kiosk`. Detection is an explicit query
parameter because every implicit signal also matches visitors: portrait and
touch match phones, fullscreen matches anyone who presses F11, and the client
IP is hidden behind the proxy. `?kiosk=0` turns it off.

Visitors give from their own phones by QR code rather than opening a payment
page on a shared screen with no browser controls to get back.

### Open GUI and Minimize are `kioskmgr://` links, not calls to localhost

A web page cannot run a program on the terminal. The options were a link in a
scheme the terminal registers, or a `fetch` to a local port in kiosk-manager.
The page is HTTPS, so a loopback request runs into mixed-content and
private-network rules that vary by browser, needs CORS, and opens a port any
page the kiosk loads could call. A link has none of that: kiosk-manager
registers a handler for `kioskmgr://` and preloads Firefox's `handlers.json` so
it opens without a prompt. Elsewhere the scheme is unknown, so the buttons are
hidden.

### Two panels in one page, not two pages

The fund panel and the CGW panel (calendar, Discord and membership QR codes)
both ship in the page and a button slides between them. A second page would
mean a navigation on the touchscreen: slower, a blank flash, and another URL
kiosk-manager's watchdog would have to accept. The `<title>` stays the same on
both panels and must keep "Shop Fund", which is how the watchdog recognises the
page. The CGW panel goes back to the fund panel after 2 minutes untouched.

### Page design: drafting vernacular

The subject is a makerspace, so progress is drawn as an engineering dimension
line (extension ticks, inward arrowheads, a dimensioned value) against a ruler
scale on quadrille paper, with a title block at the foot. The shop's own drawing
conventions are more specific to this project than a generic progress bar.

Tokens: paper `#FBFAF6`, grid `#D2E1E7`, ink `#101A22`, graphite `#61727C`,
rule `#C4CBCE`, cut-red `#C8102E`, met-green `#157F5B`. Type is IBM Plex:
Condensed for display, Sans for body, Mono for data and labels.

## Caveats

- **`/fund add` is an honor-system ledger.** Anyone with Manage Server can enter
  any figure, and the totals are published on `/kiosk/` and `/api/fund/campaigns`.
  Givebutter is the source of truth for anything paid through it; the sync
  exists so those gifts no longer have to be typed in.
- **Donor names are public.** The page shows the six most recent donor names per
  campaign. Someone who gave their name in Discord did not necessarily agree to
  the open internet. `SHOW_DONORS` (in `wrangler.jsonc`, now `true`) set to
  `false` hides names on the page only; the default deserves a deliberate
  decision.
- **Boards in archived threads stop updating.** A board pinned in a forum post
  or thread is edited through its stored channel id. Once the thread is
  archived, Discord refuses the edit, the Worker logs `board refresh failed`, and
  the board stays at its last figure until someone reopens the thread. A board
  whose message was deleted (404) or can no longer be reached (403) is forgotten
  on purpose, so `/fund board` can pin a new one.
- **Permissions are Manage Server, not a role.** Moving the write commands to a
  dedicated role was sketched for fundbot and never done.
