# Columbia Gadget Works website

Source for <https://columbiagadgetworks.org>. Built with [Hugo](https://gohugo.io) (no external theme; layouts live in `layouts/`), deployed as a Cloudflare Worker with static assets.

## Editing content

Everything a volunteer normally touches is a Markdown or YAML file:

| What | Where |
|---|---|
| Pages (Visit, About, Donate, …) | `content/<page>.md` |
| News posts | `content/news/<slug>.md` (copy an existing one; set `date`, `title`, optional `image`) |
| Tool pages | `content/tools/<tool>.md` (front matter holds specs, training flag, wiki link) |
| Events calendar | `data/events.yaml` (`recurring` always shows; `upcoming` items disappear after their date) |
| Photos | `assets/img/` (drop in a JPG/PNG, long edge 1600 px or less; reference by filename) |
| Video | `static/video/` (MP4 muxed with `-movflags +faststart`; embed with the `video` shortcode) |
| Contact info, links, EIN, Givebutter IDs | `hugo.toml` under `[params]` |
| Menu | `hugo.toml` under `[menus]` |

Images referenced from front matter (`image: foo.jpg`) or with the shortcode `{{</* img src="foo.jpg" alt="…" */>}}` are automatically resized and served as WebP with `srcset`.

Edits can be made directly on GitHub (pencil icon → commit). Every push to `main` deploys; every pull request gets a preview URL.

## Running locally

```sh
hugo server          # http://localhost:1313, live reload
hugo --minify        # production build into public/
```

Requires Hugo **extended** ≥ 0.146 (image processing). `npm install` fetches the pinned version into `node_modules/.bin/hugo` if you'd rather not install Hugo globally.

## Cloudflare setup (Worker with static assets)

The site deploys as a Cloudflare Worker: Hugo's `public/` folder is served as static assets and `src/index.js` handles the contact form at `/api/contact`. Config is in `wrangler.jsonc`.

1. Workers & Pages → Create application → Import a repository → pick `ColumbiaGadgetWorks/website`.
2. Build settings (Settings → Build after creation if the wizard skipped them):
   - Build command: leave empty (or `npm run build`); `wrangler.jsonc` runs the Hugo build itself
   - Deploy command: `npx wrangler deploy`
   - Hugo comes from the `hugo-extended` npm package pinned in `package.json`, so no `HUGO_VERSION` variable is needed
3. Secrets (Settings → Variables and Secrets, type *Secret*):
   - `DISCORD_WEBHOOK_URL`, webhook for the contact form channel (see `src/contact.js`)
   - `TURNSTILE_SECRET` (optional), add only **after** `turnstileSiteKey` in `hugo.toml` has deployed
4. Custom domain: Settings → Domains & Routes → add `columbiagadgetworks.org` and `www` (the zone must be in the same account).
5. `static/_redirects` maps the old WordPress URLs; `static/_headers` sets caching and security headers. Both are honored by Workers static assets.

Manual deploy from a machine with Wrangler logged in: `npm run deploy`.

## Shop touchscreen page (/kiosk/)

`/kiosk/` is the page the shop's touchscreen shows (opened by
[kiosk-manager](https://github.com/ColumbiaGadgetWorks/kiosk-manager) as
`/kiosk/?kiosk`). Nothing on the site links to it, and it is kept out of the
sitemap and search results. It is one standalone template,
`layouts/kiosk.html`, with two panels the visitor swaps between: the shop fund
and a month calendar.

* **Fund figures** come from the fundbot Discord bot. `/api/fund/campaigns`
  (`src/fund.js`) passes through `FUNDBOT_API_URL`, set in `wrangler.jsonc`.
* **Calendar** is the same `/api/calendar` the calendar page uses.
* **QR codes** are drawn by Hugo at build time from `hugo.toml`:
  `givebutterDonate` (credit card), `venmoDonate`, `discord` and the
  `/membership/` page. Change a link there and the next deploy redraws it.
* Keep "Shop Fund" in the page title: kiosk-manager's watchdog uses it to tell
  the right page from an error or login page.

## Shop fund database and the /fund Discord commands

The fund campaigns and donations live in the `fundraiser` D1 database, bound as
`FUND_DB` in `wrangler.jsonc`. To load data into it, paste SQL into the
dashboard (Storage & Databases > D1 > fundraiser > Console) or run
`npx wrangler d1 execute fundraiser --remote --file=<file>.sql` from any folder. The schema is `db/fund-schema.sql`. Discord ids
are stored as text, because they are too large for JavaScript numbers.

The `/fund` slash commands (`create`, `link`, `add`, `show`, `list`, `board`,
`undo`) are answered by `src/fund-discord.js` at `/api/discord/interactions`.
No bot process runs anywhere: Discord sends each command to that address, signed
with the app's key, and the Worker answers it from D1. `/kiosk/` reads the same
database through `/api/fund/campaigns`.

Setup, once:

1. Secrets (Settings > Variables and Secrets, type *Secret*):
   `DISCORD_PUBLIC_KEY` (Developer Portal > your app > General Information >
   Public Key) and `DISCORD_BOT_TOKEN` (Bot > Reset Token; used only to edit
   and pin `/fund board` messages).
2. Deploy, then check `/api/health` shows `FUND_DB`, `DISCORD_PUBLIC_KEY` and
   `DISCORD_BOT_TOKEN` as `true`.
3. Developer Portal > General Information > **Interactions Endpoint URL**:
   `https://columbiagadgetworks.org/api/discord/interactions`, then Save.
   Discord tests the address before accepting it. From then on every `/fund`
   command comes here instead of to a running bot.

The commands the old bot registered keep working. If they ever go missing, run
`scripts/register-fund-commands.mjs` (usage at the top of the file).

Query the data: `npx wrangler d1 execute fundraiser --remote --command "SELECT * FROM donation ORDER BY id DESC LIMIT 10"`.

## Video

Drop an MP4 in `static/video/` and a poster still in `assets/img/`, then:

```
{{</* video src="/video/thing.mp4" poster="thing.jpg" caption="What is happening." */>}}
```

Nothing loads until the visitor presses play (`preload="none"`), and the poster reserves the
layout box. Re-mux phone footage with `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.

## Email updates list

The "Get updates by email" box sits above the footer on every page
(`layouts/_partials/updates-signup.html`). Submissions go to `src/subscribe.js`.

**The list lives in Dolibarr.** With `DOLIBARR_URL` and `DOLIBARR_API_KEY` set (the same secrets
as the membership signup below), each address becomes a Dolibarr contact tagged **Email
updates**, or an existing contact gets that tag. Updates are sent from Dolibarr: Tools,
EMailing, recipients from Contacts filtered by that tag. See the
[module's README](https://github.com/ColumbiaGadgetWorks/dolibarr-onboarding#email-updates).

**Fallback.** Until those secrets are set, or whenever Dolibarr cannot be reached, the address is
stored in the Cloudflare KV namespace bound as `SUBSCRIBERS` instead, so a signup is never lost.
Each key is `sub:<email address>`. The namespace also holds the rate limit (five signups an
hour per connection). The binding has no id on purpose: Wrangler creates it on the first deploy.

To move what is in KV into Dolibarr: set `SUBSCRIBERS_EXPORT_TOKEN` as a secret, download
`/api/subscribers?token=...` (a CSV), and paste it into **Import email list** on the module's
setup page. Without the token that address returns 404.

## Donate button

`/donate/` embeds one Givebutter widget (`givebutterWidgetId`). Its form offers one-time, monthly
and yearly gifts; that choice, and the button's look, are both set in the Givebutter dashboard.

## Spam protection (Turnstile)

The contact form and the email signup both use Cloudflare Turnstile. The site key is set in
`hugo.toml` (`turnstileSiteKey`); it is public and safe in git. The secret lives only in the
Worker as `TURNSTILE_SECRET` (Workers & Pages, website, Settings, Variables and Secrets, type
Secret). Never commit it.

`src/turnstile.js` does the server-side check for both forms. It requires `success`, and also that
the token's `action` matches the form (`contact` or `subscribe`) and its `hostname` matches the site,
so a token minted for one form or another domain is refused.

**Rollout order matters.** With no secret set, the check is skipped. If the secret is added while
the live pages have no widget, every submission is rejected for lacking a token. So the site key
must be deployed first, then the secret added.

For local testing with `wrangler dev`, put Cloudflare's published always-pass test secret
(`1x0000000000000000000000000000000AA`) in `.dev.vars` (gitignored). Test tokens skip the action
and hostname checks, since Cloudflare answers them for a dummy host; the real secret never does.

## Membership signup

`/membership/join/` is a four step signup: details, paperwork (waiver, agreement, ID photo), dues,
done. The page is `content/membership-join.md` plus `layouts/_shortcodes/join.html`; the Worker side
is `src/join.js`. The Worker stores nothing about applicants. It checks Turnstile, then forwards to
the onboarding module in Dolibarr
([dolibarr-onboarding](https://github.com/ColumbiaGadgetWorks/dolibarr-onboarding)), which holds the
record and has a sandbox for trying the whole flow without real money.

Secrets to add to the Worker (Workers & Pages, website, Settings, Variables and Secrets):

- `DOLIBARR_URL`: Dolibarr's address with no trailing slash. The Worker runs on Cloudflare's
  network, so this has to be reachable from the internet: a public hostname or a Cloudflare Tunnel.
- `DOLIBARR_API_KEY`: the "Key for the website" shown on the module's setup page in Dolibarr.
- `GIVEBUTTER_WEBHOOK_SECRET` (optional): only needed if Givebutter should report payments through
  this site at `/api/givebutter-webhook`. The normal setup does not use it: the "Connect Givebutter"
  button in the Dolibarr module points Givebutter straight at Dolibarr.

Until the first two are set the join page says online signup is unavailable and links to Givebutter
directly, so this can be merged before Dolibarr is ready. `/api/health` shows `DOLIBARR` as true
once they are present. The Turnstile widget on step 1 uses the
action `join` with the same site key and secret as the contact form.

## After launch checklist

- Google Search Console: verify the domain, submit `/sitemap.xml`.
- Givebutter: fix the org profile URL to `https://`. (The donation widget is configured.)
- Update `data/events.yaml` whenever a class is scheduled.

## License

Site code: MIT. Content and photos: CC BY-SA 4.0 unless noted.
