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

## Video

Drop an MP4 in `static/video/` and a poster still in `assets/img/`, then:

```
{{</* video src="/video/thing.mp4" poster="thing.jpg" caption="What is happening." */>}}
```

Nothing loads until the visitor presses play (`preload="none"`), and the poster reserves the
layout box. Re-mux phone footage with `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.

## Spam protection (Turnstile)

The contact form uses Turnstile when configured. **Set both halves or neither:**
`params.turnstileSiteKey` in `hugo.toml`, and `TURNSTILE_SECRET` as a Worker secret.
If the secret is set but the site key has not deployed, the form renders no widget, sends no
token, and every submission is rejected. Deploy the site key first.

## After launch checklist

- Google Search Console: verify the domain, submit `/sitemap.xml`.
- Givebutter: fix the org profile URL to `https://`. (The donation widget is configured.)
- Update `data/events.yaml` whenever a class is scheduled.

## License

Site code: MIT. Content and photos: CC BY-SA 4.0 unless noted.
