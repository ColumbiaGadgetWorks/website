# Columbia Gadget Works website

Source for <https://columbiagadgetworks.org>. Built with [Hugo](https://gohugo.io) (no external theme; layouts live in `layouts/`), hosted on Cloudflare Pages.

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
| Video | `static/video/` (MP4, muxed with `-movflags +faststart`; embed with the `video` shortcode) |
| Contact info, links, EIN, Givebutter IDs | `hugo.toml` under `[params]` |
| Menu | `hugo.toml` under `[menus]` |

## Shop zones

`/tools/` groups every tool page under the zone it belongs to. Zones are defined once in `data/zones.yaml`:

```yaml
- id: woodworking          # must match the `zone:` value in a tool's front matter
  name: Woodworking
  accent: "#B4551D"        # text and rules; keep it dark enough to read on white
  tint: "#FBEADF"          # pale wash behind the zone header
  summary: One sentence describing the zone.
```

Each tool page sets `zone: woodworking` in its front matter. The accent colour is emitted into the stylesheet as a CSS custom property (`.zone-woodworking { --zone-accent: ... }`), so adding a zone needs no CSS edits. Order on the page follows the order of `zones.yaml`, and tools within a zone follow their `weight`.

## Video

Drop an MP4 in `static/video/` and a poster still in `assets/img/`, then embed it:

```
{{</* video src="/video/thing.mp4" poster="thing.jpg" caption="What is happening." */>}}
```

Nothing loads until the visitor presses play (`preload="none"`), and the poster reserves the layout box. Re-mux phone footage with `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` so playback can start before the file finishes downloading.

Images referenced from front matter (`image: foo.jpg`) or with the shortcode `{{</* img src="foo.jpg" alt="…" */>}}` are automatically resized and served as WebP with `srcset`.

Edits can be made directly on GitHub (pencil icon → commit). Every push to `main` deploys; every pull request gets a preview URL.

## Running locally

```sh
hugo server          # http://localhost:1313, live reload
hugo --minify        # production build into public/
```

Requires Hugo **extended** ≥ 0.146 (image processing). Pin the same version in Cloudflare (`HUGO_VERSION`).

## Cloudflare Pages setup

1. Pages → Create project → connect this repo.
2. Framework preset: **Hugo**. Build command `hugo --minify --gc`. Output directory `public`.
3. Environment variables:
   - `HUGO_VERSION` = `0.165.0` (build)
   - `DISCORD_WEBHOOK_URL` = webhook for the contact form channel (secret; see `functions/api/contact.js`)
   - `TURNSTILE_SECRET` (optional) with `turnstileSiteKey` in `hugo.toml`
4. Custom domain: add `columbiagadgetworks.org` and `www` (the zone should already be on Cloudflare DNS).
5. `static/_redirects` maps the old WordPress URLs; `static/_headers` sets caching and security headers.

## After launch checklist

- Google Search Console: verify the domain, submit `/sitemap.xml`.
- Givebutter: fix the org profile URL to `https://`, create a **widget** for the donation campaign and paste its ID into `givebutterWidgetId`.
- Update `data/events.yaml` whenever a class is scheduled.

## License

Site code: MIT. Content and photos: CC BY-SA 4.0 unless noted.
