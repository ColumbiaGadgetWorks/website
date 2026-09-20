# Columbia Gadget Works website

Source for <https://columbiagadgetworks.org>. Built with [Hugo](https://gohugo.io) (no external theme; layouts live in `layouts/`), deployed as a Cloudflare Worker with static assets.

## Editing content

Everything a volunteer normally touches is a Markdown or YAML file:

| What | Where |
|---|---|
| Pages (Visit, About, Donate, …) | `content/<page>.md` |
| News posts | `content/news/<slug>.md` (copy an existing one; set `date`, `title`, optional `image`) |
| Tool pages | `content/tools/<tool>.md` (front matter holds `zone`, specs, training flag, wiki link) |
| Shop zones | `data/zones.yaml` (name, summary, and the accent colour each zone is themed with) |
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
   - `SUBSCRIBERS_EXPORT_TOKEN`, required to export the mailing list (see below)
   - `DISCORD_SIGNUP_WEBHOOK_URL` (optional), pings a channel on each list signup
4. Custom domain: Settings → Domains & Routes → add `columbiagadgetworks.org` and `www` (the zone must be in the same account).
5. `static/_redirects` maps the old WordPress URLs; `static/_headers` sets caching and security headers. Both are honored by Workers static assets.

Manual deploy from a machine with Wrangler logged in: `npm run deploy`.

## Shop zones

`/tools/` groups every tool page under the zone it belongs to. Zones are defined once in `data/zones.yaml`:

```yaml
- id: woodworking          # must match the `zone:` value in a tool's front matter
  name: Woodworking
  accent: "#AB501B"        # text and rules; keep it dark enough to read on white
  summary: One sentence describing the zone.
```

Each tool page sets `zone: woodworking`. The accent is emitted into the stylesheet as a
CSS custom property (`.zone-woodworking { --zone-accent: ... }`), so adding a zone needs
no CSS edit. Zone order follows `zones.yaml`; tools within a zone follow their `weight`.

## Video

Drop an MP4 in `static/video/` and a poster still in `assets/img/`, then:

```
{{</* video src="/video/thing.mp4" poster="thing.jpg" caption="What is happening." */>}}
```

Nothing loads until the visitor presses play (`preload="none"`), and the poster reserves
the layout box. Re-mux phone footage with `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`
so playback can start before the file finishes downloading.

## Class and event email list

`{{</* subscribe */>}}` renders the signup form. It is on `/classes/` and `/events/`, and
linked from the footer. Addresses are stored in Cloudflare KV, not a third-party mailing
service, so the list stays ours.

1. Create the namespace: `npx wrangler kv namespace create SUBSCRIBERS`
2. Paste the id it prints into the commented `kv_namespaces` block in `wrangler.jsonc`.
3. Add `SUBSCRIBERS_EXPORT_TOKEN` as a secret (`openssl rand -hex 32`).

Export the list:

```sh
curl "https://columbiagadgetworks.org/api/subscribers?token=$SUBSCRIBERS_EXPORT_TOKEN" -o subscribers.csv
```

Without that secret the export returns 404, so the list is never exposed by accident.
Records are keyed by lowercased email, so signing up twice updates one row. To remove
someone, delete the `sub:<their email>` key from the namespace.

`GET /api/health` reports which bindings the Worker can see (names only, never values).

## Spam protection (Turnstile)

The contact form and the signup form both use Turnstile when it is configured.
**Set both halves or neither:**

- `params.turnstileSiteKey` in `hugo.toml` (public, safe in git)
- `TURNSTILE_SECRET` as a Worker secret

The handlers verify only when the secret is present. If the secret is set but the site key
has not deployed, the forms render no widget, send no token, and every submission is
rejected. Deploy the site key first, then add the secret.

When creating the widget, list `columbiagadgetworks.org` (subdomains are covered
automatically) and the `workers.dev` hostname if you test there.

## After launch checklist

- Google Search Console: verify the domain, submit `/sitemap.xml`.
- Givebutter: fix the org profile URL to `https://`. (The donation widget is configured; `givebutterAccount` and `givebutterWidgetId` are set in `hugo.toml`.)
- Update `data/events.yaml` whenever a class is scheduled.

## License

Site code: MIT. Content and photos: CC BY-SA 4.0 unless noted.
