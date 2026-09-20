# Launch checklist

Status as of 2026-09-20: the Hugo site is live at https://columbiagadgetworks.org, deployed from this
repo's `main` branch to a Cloudflare Worker in the CGW Cloudflare account. DNS is on Cloudflare;
the registrar is Namecheap. What remains, in order.

## 1. Force HTTPS (Cloudflare, 2 minutes)

1. Cloudflare dashboard → **columbiagadgetworks.org** → **SSL/TLS** → **Edge Certificates**.
2. Turn on **Always Use HTTPS**.
3. Check: `curl -sI http://columbiagadgetworks.org/ | head -3` should show `301` with a `location: https://…` line.

## 2. Redirect www to the root domain (Cloudflare, 2 minutes)

1. Domain → **Rules** → **Overview** → **Create rule** → **Redirect Rule**.
2. Pick the template **Redirect from WWW to Root**, deploy it.
3. Check: `curl -sI https://www.columbiagadgetworks.org/ | head -3` should show `301` to the apex.

## 3. Turn on the contact form (Discord + Cloudflare, 10 minutes)

1. In Discord, create a private text channel, e.g. `#website-contact`, visible to officers and whoever answers inquiries.
2. Server Settings → **Integrations** → **Webhooks** → **New Webhook**. Name it "Website contact form", set its channel, **Copy Webhook URL**.
3. Cloudflare → **Workers & Pages** → **website** → **Settings** → **Variables and Secrets** → **Add**.
   Type **Secret**, name `DISCORD_WEBHOOK_URL`, paste the URL, save. The Worker redeploys on its own.
4. Test: submit https://columbiagadgetworks.org/contact/ with a real message. You should land on a
   "Thanks" notice and see the message in the channel within seconds. If you land on "not sent",
   the secret name is wrong or the webhook was deleted.

Treat the webhook URL as a password: anyone holding it can post into that channel.

## 4. Google Search Console (10 minutes)

1. https://search.google.com/search-console → **Add property** → **Domain** → `columbiagadgetworks.org`.
2. Google looks for a `google-site-verification` TXT record. One already exists in Cloudflare DNS
   (carried over from WordPress), so click **Verify**. If it fails, copy the value Google shows
   and add it as a new TXT record on `@` in Cloudflare DNS, then retry.
3. **Sitemaps** → enter `sitemap.xml` → **Submit**.
4. Optional but useful for the Ad Grant: **Settings → Users** → add another officer as Owner.

## 5. Givebutter (needs the Givebutter admin login, 10 minutes)

1. https://dashboard.givebutter.com → **Settings** → organization profile → set the website to
   `https://columbiagadgetworks.org` (it currently says `http://`).
2. Open the **donation** campaign (the one behind givebutter.com/v7RxV6) → **Share** → **Widgets**
   (or "Embed") → create a **form** widget → copy the widget ID (a short code, not the campaign slug).
3. The embed code has two parts: a `<script … acct=…>` loader (already in `hugo.toml` as `givebutterAccount`) and a
   `<givebutter-widget id="…">` tag. Put that id in `hugo.toml` as `givebutterWidgetId`, commit, push. The donate page
   then embeds the form on our own domain instead of linking out. Until then it shows a button.

## 6. Retire WordPress.com (15 minutes; do after 1–5 are done and the site has been live a few days)

1. WordPress.com → the old site → **Tools → Export** → download the XML, and **Media → download**
   any photos worth keeping. Add keepers to `assets/img/` in this repo.
2. **Me → Purchases** → the site's plan → cancel. The domain is registered at Namecheap, not
   WordPress.com, so cancelling the plan cannot affect the domain. Double-check that the purchases
   list shows no separate "domain registration" line for columbiagadgetworks.org before cancelling.
3. Then in Cloudflare DNS:
   - Edit the SPF TXT record on `@` to `v=spf1 include:_spf.google.com ~all`.
   - Delete the two CNAMEs `wpcloud1._domainkey` and `wpcloud2._domainkey`.
   - Keep everything else, especially the `vgqemn6x7kjj` CNAME (Google domain verification).

## 7. Optional: Turnstile spam check on the contact form

The honeypot field already stops simple bots. If spam shows up anyway:

1. Cloudflare → **Turnstile** → **Add widget**. Name `cgw-contact-form`, hostnames
   `columbiagadgetworks.org` and `website.columbiagadgetworks.workers.dev`, mode **Managed**.
2. Put the **site key** in `hugo.toml` as `turnstileSiteKey`, commit, push, and **wait for that deploy to finish**.
3. Only then add the **secret key** as a Worker secret named `TURNSTILE_SECRET` (same place as step 3).
   Doing it in the other order rejects every submission until the site key deploys.

## 8. Content still marked TODO in the site

Search the repo for `TODO` (`grep -rn TODO content hugo.toml`). As of launch:

- `content/membership.md`: dues tiers and amounts need confirming (Standard $50 / Supporter $100 are from the 2026 notes; the member vote is expected early 2027).
- `content/classes.md`: confirm the planned-class list and the exact name of the City of Columbia grant program.
- `content/tools/metal-shop.md`, `woodshop.md`: real machine makes and models.
- `content/tools/cnc-router.md`, `electronics-bench.md`, `woodshop.md`: need a photo each (drop a JPG in `assets/img/`, set `image:` in the front matter).
- `content/code-of-conduct.md`: draft for the transition committee to adopt.
- `content/about.md`: confirm the board list is current and everyone is fine being named.

## 9. Google for Nonprofits

Eligibility is verified by Goodstack against legal records, not the website. Have ready: the 2022
IRS reinstatement letter, EIN 27-3926809, the legal name exactly as on the letter, and the
1404 Grand Ave address. The Ad Grant, if pursued later, is the part that reviews the website;
this rebuild was designed against that checklist.
