
Quick fixes

0 / 8

Small changes with outsized effect on how the site reads to a reviewer. All of these are doable in an afternoon.
Add a heading block to the homepage

Real body text above the post loop, not a theme header image, not an image caption. An H1, the mission sentence, the Thursday Open Hack line, and two buttons: Plan Your Visit and Donate. Right now a reviewer landing on the homepage sees six post thumbnails and no statement of what CGW is.
Rebuild the menu from the page list

Select pages from the page picker rather than pasting URLs, then assign the menu to every location the theme offers, including the front page template. The homepage and interior pages currently show two different menus, which is the exact "confusing navigation" failure Google names.

Appearance → Menus
Move Discord and the Wiki to the footer

Both point off-domain. A primary nav made largely of external links works against you, since ads can only ever land on columbiagadgetworks.org.
Rename "Donation/Membership" to "Donate"

Shorter, clearer, and it matches the page slug.
Reorder the Donate page

Lead with what donations fund, then the 501(c)(3) and tax-deductible statement with EIN 27-3926809, then the donate button, and put membership below that. It currently opens with membership benefits, which reads as a sales pitch with charity as an afterthought.
Turn bare URLs into buttons and links

Both Givebutter links on /donate and the Discord link on /visit are sitting there as raw https://… text. That's what "a page that's mostly links to other sites" looks like to a reviewer.
Embed the Givebutter widget on /donate

Let donations complete on your own domain instead of bouncing the visitor off-site. Google wants a donation path that works without leaving the page.
Close or moderate homepage comments

An open comment form is a spam-link vector, and reviewers flag sites hosting outbound spam. Turn comments off, or require approval.

Jetpack → Discussion
Pages to write

0 / 7

The site has roughly 1,000 words of original text across four pages. Thin content is the single most common reason Ad Grant applications get rejected, and this section is the fix.
Create /tools

Laser cutter, CNC router, mill and lathe, 3D printers, casting setup, electronics bench, woodshop. A paragraph and a photo for each, plus a note on what requires training first. Target 600+ words.

This is the highest-value page you don't have. It fixes the most content volume at once, and it's what people actually search for, "laser cutter near me" brings strangers to your door.
Create /classes

Open Hack Night, plus the classes you've already run, metal casting, soldering, metalworking, milling. How to propose one, and how to hear about upcoming ones. Link out to the existing blog posts so they stop being orphaned.
Create /contact

Address, embedded Google Map, hours, phone, and a working contact form.
Create /privacy

A privacy policy, needed because Site Kit and Analytics are running. Reviewers do check for one.
Expand /visit past 80 words

What a first-timer should expect: where to park on Grand, that they need to bring nothing, that no experience is required, who greets them, and what they'll walk in on. Lead with the Thursday visit and move Discord to the end.
Expand /about toward 400 words

Add the founding story from 2017 to now, leadership or board, a link to the Form 990, and community impact. The mission copy that's there already is good, this is about giving it company.
Add a calendar with recurring events

A real events calendar does double duty: it adds indexable content that refreshes itself, and it answers the question most first-time visitors actually have.

    Open Hack Night, 6–8pm Every Thursday
    City of Columbia grant classes First Thursday, Nov 5 2026 – Oct 7 2027
    Annual member meeting Last Saturday in April
    Board meeting, 8pm after Open Hack Last Thursday, quarterly

Technical checks

0 / 9

Speed and mobile performance are scored on real measurements, so these have to be run rather than reasoned about.
Resize and compress the source images

The post thumbnails are full-resolution phone photos, pxl_20260213_005721747.jpg, pxl_20260116_014121971.jpg, pxl_20260227_010125431_1.jpg. Cap the long edge near 1600px and re-upload.
Run PageSpeed Insights on mobile

Test the homepage and /donate at minimum, on the mobile tab. Fix whatever it flags.
Run Google's Mobile-Friendly Test

Then tap through the nav on an actual phone once the menus are consolidated.
Check every page for mixed content

Open DevTools and confirm nothing is loading over plain HTTP. Mixed-content warnings fail the security check outright.
Run a broken-link scan

Across the whole site. Confirm the Discord invite hasn't expired while you're at it.
Fix the Givebutter profile URL

The Givebutter donation page links back to http://columbiagadgetworks.org/. Change it to https:// in your Givebutter org settings.
Empty the WordPress trash

So no deleted page keeps squatting on the donate slug and forces WordPress to hand you donate-2.
Standardize on mail@columbiagadgetworks.org

The footer currently shows a Gmail address while the About page shows the domain address. Use the domain address everywhere, it reads as a real organization, which is what Google is assessing.
Submit an XML sitemap to Search Console

Once the new pages exist, so they're indexed before the application is reviewed.

Starting fresh. Progress will be shared with anyone holding this link once you check something off.
