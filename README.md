# Columbia Gadget Works website

Source for <https://columbiagadgetworks.org>. Built with [Hugo](https://gohugo.io) (no external theme; layouts live in `layouts/`), hosted on Cloudflare Pages.

## Editing content

Everything a volunteer normally touches is a Markdown or YAML file:

| What | Where |
|---|---|
| Pages (Visit, About, Donate, …) | `content/<page>.md` |
| News posts | `content/news/<slug>.md` — copy an existing one; set `date`, `title`, optional `image` |
| Tool pages | `content/tools/<tool>.md` — front matter holds specs, training flag, wiki link |
| Events calendar | `data/events.yaml` — `recurring` always shows; `upcoming` items disappear after their date |
| Photos | `assets/img/` — drop in a JPG/PNG (long edge ≤ 1600 px is plenty); reference by filename |
| Contact info, links, EIN, Givebutter IDs | `hugo.toml` under `[params]` |
| Menu | `hugo.toml` under `[menus]` |

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
