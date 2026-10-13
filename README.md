# SEOer local scan helper

Some sites sit behind Cloudflare and return a bot-challenge ("Just a moment…")
page to the server, so SEOer can't scan them directly. This helper scans those
pages in **your own Chrome**, on your own connection — where the challenge
clears like any normal visit — and sends the results back to SEOer.

## Setup (once)

You need **Node.js** (LTS) and **Google Chrome** installed. From this folder:

```
npm install
npm run scan
```

`npm install` downloads Playwright. The helper uses your installed Google
Chrome (Playwright `channel: "chrome"`), so make sure Chrome is installed.

### Or let Claude Code set it up

If you use [Claude Code](https://claude.com/claude-code), paste this into a session
and approve the commands it asks about:

```
Clone https://github.com/LongNanotek/seoer-local-scanner.git, run npm install
in it, then start it with npm run scan in the background and tell me when it
says it is listening on 127.0.0.1:47319. If Node.js or Chrome is missing, tell
me what to install first.
```

Leave the window running. You'll see:

```
SEOer local scan helper listening on http://127.0.0.1:47319
```

## Using it

1. In SEOer, scan a URL. If the site is Cloudflare-blocked, the scan is marked
   **blocked** and the scan page shows a **"Scan on my computer"** button.
2. Make sure this helper is running, then click the button.
3. A Chrome window opens, loads the page, and closes on its own. The report
   appears in SEOer — no copy-paste.

## Google rankings (keywords)

If you enter keywords in the competitor tab, the helper also searches each one
on Google (Canada) in a Chrome window, reads the real positions of your site and
the competitor, and opens the two pages that actually rank to analyse why one
is ahead.

- One line in the keywords box = one search (the whole phrase). Up to 10.
  If neither site is on page 1, it also checks page 2 (top 20).
- Searches are spaced 5–10 seconds apart. A keyword searched in the last
  3 hours is reused from cache, so it isn't searched again.
- **If Google shows a CAPTCHA ("I'm not a robot"), solve it in that Chrome
  window** — the helper waits for you (up to 3 minutes) and continues. It never
  solves or bypasses CAPTCHAs itself.
- It uses its own Chrome profile (`.chrome-profile/`) so Google sees a returning
  browser; after you've solved a CAPTCHA once, later searches usually go
  through without one.
- Scraping Google is against Google's terms of service. Light use is low-risk;
  very heavy use can make Google show CAPTCHAs to your network for a while.

## Notes

- The helper listens only on `127.0.0.1` (your machine). It does nothing until
  the dashboard asks it to scan a specific URL, and each request carries a
  short-lived token tied to one of your blocked scans.
- **Only scan sites you are authorized to audit.** This drives your own browser
  on your own connection; it is not a tool for evading anyone's access controls.
- This helper is a companion to the SEOer web app. Playwright lives only here, so the web app itself never installs a browser.
