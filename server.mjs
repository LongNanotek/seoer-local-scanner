// SEOer local scan helper.
//
// Run `npm run scan` and leave it open. It listens on 127.0.0.1:47319. When the
// SEOer dashboard's "Scan on my computer" button calls it, it opens your real
// Chrome (visible), loads the blocked page — getting past Cloudflare the same
// way a normal visit does — extracts the page's SEO signals, and POSTs them
// back to SEOer, which turns them into a report.
//
// Only scan sites you are authorized to audit. This drives your own browser on
// your own connection; it is not a way to evade anyone's access controls.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { extractSignals } from "./scan-extract.js";
import { extractSerp } from "./serp-extract.js";
import { extractCrawlPage, collectLocs, selectPages, toLanding, extractLinks, sitemapsFromRobots } from "./crawl-extract.js";

const PORT = 47319;
const HOST = "127.0.0.1";
const AI_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "CCBot", "Google-Extended", "anthropic-ai"];
const CRAWL_CONCURRENCY = 6;
const MAX_CHILD_SITEMAPS = 10;
const MAX_CANDIDATE_URLS = 500;

function cors(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Lets an HTTPS page (the deployed dashboard) call this loopback server under
  // Chrome's Private Network Access rules.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

// page.goto rejects with ERR_ABORTED when a client-side redirect or script
// navigation interrupts the initial load — yet the page still ends up loaded.
// Treat that as success once the page has settled on a real http(s) URL; only
// rethrow if we genuinely never got a page.
async function gotoTolerant(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (err) {
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    if (!/^https?:/i.test(page.url())) throw err;
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

// Fetch robots.txt / sitemap.xml / llms.txt through the SAME browser context so
// they also clear Cloudflare, and compute the sub-objects the report expects.
async function fetchSiteFiles(context, origin) {
  async function get(path) {
    try {
      const r = await context.request.get(origin + path, { timeout: 15000 });
      if (!r.ok()) return null;
      return await r.text();
    } catch {
      return null;
    }
  }
  const [robotsTxt, sitemapXml, llmsTxt] = await Promise.all([
    get("/robots.txt"),
    get("/sitemap.xml"),
    get("/llms.txt"),
  ]);

  const blocksCommonAiBots = [];
  if (robotsTxt) {
    const blocks = robotsTxt.split(/\r?\n(?=user-agent:)/i);
    for (const bot of AI_BOTS) {
      const block = blocks.find((b) => new RegExp(`user-agent:\\s*${bot}`, "i").test(b));
      if (block && /disallow:\s*\/\s*$/im.test(block)) blocksCommonAiBots.push(bot);
    }
  }

  const sampleUrls = [];
  if (sitemapXml) {
    for (const m of sitemapXml.matchAll(/<loc>(.*?)<\/loc>/g)) {
      sampleUrls.push(m[1]);
      if (sampleUrls.length >= 8) break;
    }
  }

  return {
    robotsTxt: {
      present: robotsTxt !== null,
      excerpt: robotsTxt ? robotsTxt.slice(0, 1500) : null,
      blocksCommonAiBots,
    },
    sitemap: { present: sitemapXml !== null, sampleUrls },
    llmsTxt: { present: llmsTxt !== null },
  };
}

async function scanInBrowser(url) {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoTolerant(page, url);

    // Wait for the challenge to clear: the interstitial sets the title to
    // "Just a moment…" and shows "Verifying you are human".
    await page
      .waitForFunction(
        () => {
          const t = (document.title || "").toLowerCase();
          const b = (document.body?.innerText || "").toLowerCase();
          return (
            !t.includes("just a moment") &&
            !b.includes("verifying you are human") &&
            !b.includes("just a moment") &&
            !b.includes("checking your browser")
          );
        },
        { timeout: 45000 }
      )
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const domSignals = await page.evaluate(extractSignals);
    const origin = new URL(domSignals.finalUrl).origin;
    const siteFiles = await fetchSiteFiles(context, origin);

    return { ...domSignals, ...siteFiles };
  } finally {
    await browser.close();
  }
}

// --- whole-site crawl ---

// Fetch from INSIDE the already-cleared page first: Cloudflare fingerprints the
// TLS handshake, and context.request uses Node's TLS stack, so it gets rejected
// on challenged HTML even with cf_clearance. An in-page fetch() goes through
// Chrome's real network stack + cookies, yet skips rendering — reliable and
// fast. Falls back to context.request for what the page can't read (e.g. a
// sitemap/robots.txt on the apex domain is cross-origin to a www page, and
// those files are rarely challenged).
//
// htmlOnly: page fetches must actually be HTML — a sitemap can list media
// (e.g. a 6 MB .m4a recording), and parsing binary as HTML builds a DOM deep
// enough to overflow cheerio's recursive clone. Sitemaps/robots pass false.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

async function getText(page, context, url, htmlOnly = false) {
  let text = null;
  try {
    text = await page.evaluate(
      async ({ u, htmlOnly, maxBytes }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const r = await fetch(u, { credentials: "include", signal: controller.signal });
          if (!r.ok) return null;
          const ct = r.headers.get("content-type") || "";
          if (htmlOnly && !/html/i.test(ct)) return null;
          if (Number(r.headers.get("content-length") || 0) > maxBytes) return null;
          const body = await r.text();
          return body.length > maxBytes ? null : body;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
      { u: url, htmlOnly, maxBytes: MAX_BODY_BYTES }
    );
  } catch {
    text = null;
  }
  if (text !== null) return text;
  try {
    const r = await context.request.get(url, { timeout: 15000 });
    if (!r.ok()) return null;
    if (htmlOnly && !/html/i.test(r.headers()["content-type"] || "")) return null;
    const body = await r.text();
    return body.length > MAX_BODY_BYTES ? null : body;
  } catch {
    return null;
  }
}

// Discover page URLs from the site's sitemap(s): those declared in robots.txt
// first (the standard), then the conventional paths. Walks sitemap indexes into
// child sitemaps. Every URL is normalized onto the landing origin (apex <-> www)
// and kept only if it's the same site. Mirrors fetchAllSitemapUrls
// (src/lib/site-corpus.ts), plus the robots.txt declaration it doesn't read.
async function discoverFromSitemaps(page, context, origin) {
  const o = new URL(origin);
  const apex = `${o.protocol}//${o.hostname.replace(/^www\./i, "")}`;
  const candidates = [];
  const robots = await getText(page, context, `${origin}/robots.txt`);
  if (robots) candidates.push(...sitemapsFromRobots(robots));
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${apex}/sitemap.xml`, `${apex}/sitemap_index.xml`);

  const tried = new Set();
  const urls = new Set();
  for (const sitemapUrl of candidates) {
    if (tried.has(sitemapUrl) || urls.size >= MAX_CANDIDATE_URLS) continue;
    tried.add(sitemapUrl);
    const text = await getText(page, context, sitemapUrl);
    const result = text ? collectLocs(text) : null;
    if (!result) continue;
    const pageLocs = [];
    if (result.isIndex) {
      for (const child of result.locs.slice(0, MAX_CHILD_SITEMAPS)) {
        if (tried.has(child)) continue;
        tried.add(child);
        const childText = await getText(page, context, child);
        const childResult = childText ? collectLocs(childText) : null;
        if (childResult) pageLocs.push(...childResult.locs);
        if (pageLocs.length >= MAX_CANDIDATE_URLS) break;
      }
    } else {
      pageLocs.push(...result.locs);
    }
    for (const loc of pageLocs) {
      const n = toLanding(loc, origin);
      if (n) urls.add(n);
      if (urls.size >= MAX_CANDIDATE_URLS) break;
    }
    if (urls.size > 0) break; // first sitemap source that yields pages wins
  }
  return [...urls];
}

// Fallback for sites with no usable sitemap: breadth-first follow of same-site
// links from the landing page. Caches fetched HTML so the main crawl doesn't
// fetch each page twice.
async function discoverByLinks(page, context, origin, limit, cache) {
  const start = toLanding(page.url(), origin);
  const seen = new Set([start]);
  let frontier = [start];
  const found = [];
  while (frontier.length && found.length < limit) {
    const batch = frontier.slice(0, limit - found.length);
    frontier = [];
    const htmls = await mapPool(batch, CRAWL_CONCURRENCY, (u) => getText(page, context, u, true));
    batch.forEach((u, i) => {
      const html = htmls[i];
      if (!html) return;
      cache.set(u, html);
      found.push(u);
      let links = [];
      try {
        links = extractLinks(html, u, origin);
      } catch {
        return; // malformed page: keep crawling the rest
      }
      for (const link of links) {
        if (!seen.has(link)) {
          seen.add(link);
          frontier.push(link);
        }
      }
    });
  }
  return found;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function crawlInBrowser(url, maxPages) {
  const browser = await chromium.launch({ channel: "chrome", headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // One real navigation clears the Cloudflare challenge; every page after
    // this is a cheap in-page fetch() (see getText) through that same cleared
    // Chrome session — no rendering per page.
    await gotoTolerant(page, url);
    await page
      .waitForFunction(
        () => {
          const t = (document.title || "").toLowerCase();
          const b = (document.body?.innerText || "").toLowerCase();
          return (
            !t.includes("just a moment") &&
            !b.includes("verifying you are human") &&
            !b.includes("just a moment") &&
            !b.includes("checking your browser")
          );
        },
        { timeout: 45000 }
      )
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    const origin = new URL(page.url()).origin;
    const landing = toLanding(page.url(), origin);
    const cache = new Map();

    let discovered = await discoverFromSitemaps(page, context, origin);
    let discoveredBy = "sitemap";
    if (discovered.length < 5) {
      discovered = await discoverByLinks(page, context, origin, Math.min(MAX_CANDIDATE_URLS, maxPages * 2), cache);
      discoveredBy = "links";
    }
    const candidates = [...new Set([landing, ...discovered])];
    const totalDiscovered = candidates.length;
    const selected = selectPages(candidates, maxPages);
    console.log(`[crawl] discovered ${totalDiscovered} pages via ${discoveredBy}; fetching ${selected.length}`);

    const schemaTypesSeen = new Set();
    const results = await mapPool(selected, CRAWL_CONCURRENCY, async (u) => {
      const text = cache.get(u) ?? (await getText(page, context, u, true));
      if (!text) return null;
      // Isolate each page: one malformed page must never sink the whole crawl.
      let data;
      try {
        data = extractCrawlPage(text, u);
      } catch (err) {
        console.warn(`[crawl] skipped ${u}: ${err instanceof Error ? err.message : err}`);
        return null;
      }
      // Defensive: never record a challenge interstitial as a real page.
      if (/just a moment/i.test(data.title || "")) return null;
      data.structuredDataTypes.forEach((t) => schemaTypesSeen.add(t));
      return data;
    });
    const pages = results.filter(Boolean);

    return {
      siteUrl: origin,
      pagesCrawled: pages.length,
      totalDiscovered,
      schemaTypesSeen: [...schemaTypesSeen].slice(0, 200),
      pages,
    };
  } finally {
    await browser.close();
  }
}

// --- Google rankings (Canada) ---
//
// Searches each keyword on Google in a dedicated, persistent Chrome profile (so
// Google sees a returning browser), at a human pace. Never solves or evades a
// CAPTCHA: if one shows, it waits for the user to solve it in the window.
// Agreed with the user: 3h cache per keyword (repeat searches are served from
// cache) and 5-10s between searches. No hourly cap.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(HERE, ".chrome-profile");
const STATE_DIR = path.join(HERE, ".serp-state");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SERP_CACHE_MS = 3 * 60 * 60 * 1000;
const CAPTCHA_WAIT_MS = 3 * 60 * 1000;

function loadSerpState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { searches: s.searches ?? [], cache: s.cache ?? {} };
  } catch {
    return { searches: [], cache: {} };
  }
}

function saveSerpState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripWwwHost = (h) => h.replace(/^www\./i, "").toLowerCase();

function hostMatches(url, hosts) {
  try {
    const h = stripWwwHost(new URL(url).hostname);
    return hosts.some((x) => h === x || h.endsWith(`.${x}`));
  } catch {
    return false;
  }
}

// One Google results page. Returns {results} or {blocked:true}.
async function googleSearch(page, keyword, start) {
  const q = new URL("https://www.google.com/search");
  q.searchParams.set("q", keyword);
  q.searchParams.set("gl", "ca");
  q.searchParams.set("hl", "en");
  if (start) q.searchParams.set("start", String(start));
  await gotoTolerant(page, q.toString());
  await page.waitForSelector("#search, #rso, #captcha-form, form[action*='sorry']", { timeout: 15000 }).catch(() => {});

  let out = await page.evaluate(extractSerp);
  let sawCaptcha = false;
  if (out.needsUser) {
    sawCaptcha = true;
    console.log(`[serp] Google needs you: solve the CAPTCHA / consent in the Chrome window ("${keyword}")`);
    const deadline = Date.now() + CAPTCHA_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        out = await page.evaluate(extractSerp);
      } catch {
        continue; // page mid-navigation after the user solved it
      }
      if (!out.needsUser) break;
    }
    if (out.needsUser) return { blocked: true, sawCaptcha };
    console.log(`[serp] thanks — continuing`);
    // After the CAPTCHA, Google redirects to the results — wait for them to
    // actually render before reading (reading mid-load returned 0 results).
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForSelector("#search, #rso", { timeout: 15000 }).catch(() => {});
    out = await page.evaluate(extractSerp).catch(() => ({ needsUser: false, results: [] }));
  }
  if (!out.needsUser && out.results.length === 0) {
    // Not blocked but nothing parsed — keep a snapshot so the cause can be
    // diagnosed (e.g. Google changed its markup) instead of failing silently.
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, "last-empty-serp.html"), await page.content());
      console.warn(`[serp] "${keyword}": no results parsed — saved .serp-state/last-empty-serp.html`);
    } catch {
      /* best effort */
    }
  }
  return { results: out.results, sawCaptcha };
}

async function serpInBrowser({ keywords, ourHosts, competitorHosts }) {
  const state = loadSerpState();
  const now = Date.now();

  const keyOf = (k) => k.trim().toLowerCase();
  const fresh = (k) => {
    const c = state.cache[keyOf(k)];
    // An entry with no results (a failed read) is never reused.
    return c && c.results?.length && now - c.at < SERP_CACHE_MS ? c : null;
  };
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel: "chrome", headless: false });
  let searchedOnce = false;
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const out = [];

    for (const keyword of keywords) {
      let entry = fresh(keyword) ? { ...fresh(keyword) } : null;
      let blocked = false;

      const doSearch = async (start) => {
        if (searchedOnce) await sleep(5000 + Math.random() * 5000);
        searchedOnce = true;
        state.searches.push(Date.now());
        const r = await googleSearch(page, keyword, start);
        return r;
      };

      if (!entry) {
        const r = await doSearch(0);
        if (!r || r.blocked) {
          blocked = true;
          entry = { at: Date.now(), depth: 0, results: [] };
        } else {
          entry = { at: Date.now(), depth: 10, results: r.results.map((x, i) => ({ ...x, position: i + 1 })) };
        }
      } else {
        console.log(`[serp] "${keyword}": using results from ${Math.round((now - entry.at) / 60000)} min ago (no new search)`);
      }

      // Page 2 only if neither site is on page 1.
      const found = (hosts) => entry.results.some((r) => hostMatches(r.url, hosts));
      if (!blocked && entry.depth < 20 && !found(ourHosts) && !found(competitorHosts)) {
        const r2 = await doSearch(10);
        if (r2 && !r2.blocked) {
          const base = entry.results.length;
          const seen = new Set(entry.results.map((r) => r.url));
          const more = r2.results.filter((r) => !seen.has(r.url)).map((x, i) => ({ ...x, position: base + i + 1 }));
          entry = { ...entry, depth: 20, results: [...entry.results, ...more] };
        }
      }

      if (!blocked && entry.results.length) state.cache[keyOf(keyword)] = entry;
      saveSerpState(state);
      out.push({ keyword, depth: blocked ? 0 : entry.results.length, blocked, results: entry.results.slice(0, 20) });
      console.log(
        blocked
          ? `[serp] "${keyword}": blocked`
          : `[serp] "${keyword}": ${entry.results.length} results checked`
      );
    }

    // Open the pages that actually rank (ours + competitor's) to analyse them.
    // Google's result links are opaque redirects, so follow each one (like a
    // click) to land on — and learn — the exact page, then record that real URL
    // on the result.
    const hits = [];
    for (const k of out) {
      for (const hosts of [ourHosts, competitorHosts]) {
        const hit = k.results.find((r) => hostMatches(r.url, hosts));
        if (hit) hits.push(hit);
      }
    }
    const rankingPages = [];
    const resolved = new Map(); // google href -> real url
    const tab = await context.newPage();
    for (const hit of hits) {
      const target = hit.href || hit.url;
      if (resolved.has(target)) {
        hit.url = resolved.get(target);
        continue;
      }
      if (rankingPages.length >= 20) break;
      try {
        await gotoTolerant(tab, target);
        await tab
          .waitForFunction(() => !(document.title || "").toLowerCase().includes("just a moment"), { timeout: 30000 })
          .catch(() => {});
        const landed = new URL(tab.url());
        landed.hash = "";
        // Only trust the landing page if it's on the site Google showed.
        if (stripWwwHost(landed.hostname) !== hit.domain && !landed.hostname.toLowerCase().endsWith(`.${hit.domain}`)) {
          console.warn(`[serp] ${hit.domain} result landed on ${landed.hostname} — skipped`);
          continue;
        }
        const realUrl = landed.toString();
        resolved.set(target, realUrl);
        hit.url = realUrl;
        const data = extractCrawlPage(await tab.content(), realUrl);
        if (!/just a moment/i.test(data.title || "")) rankingPages.push(data);
      } catch (err) {
        console.warn(`[serp] couldn't analyse ranking page for ${hit.domain}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Send only what the server needs (the opaque Google redirect stays local).
    const keywordsOut = out.map((k) => ({
      ...k,
      results: k.results.map(({ position, url, title, domain, display }) => ({ position, url, title, domain, display })),
    }));
    return { gl: "ca", hl: "en", searchedAt: new Date().toISOString(), keywords: keywordsOut, rankingPages };
  } finally {
    saveSerpState(state);
    await context.close();
  }
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && req.url === "/scan") {
    const body = await readBody(req);
    if (!body || typeof body.url !== "string" || typeof body.token !== "string" || typeof body.importUrl !== "string") {
      json(res, 400, { ok: false, error: "Expected { url, token, importUrl }." });
      return;
    }
    console.log(`\n[scan] opening ${body.url}`);
    try {
      const signals = await scanInBrowser(body.url);
      console.log(`[scan] extracted signals (${signals.wordCount} words); importing…`);
      const imp = await fetch(body.importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: body.token, signalsJson: signals }),
      });
      const impData = await imp.json().catch(() => ({}));
      if (!imp.ok) {
        console.error(`[scan] import failed: ${impData.error || imp.status}`);
        json(res, 502, { ok: false, error: impData.error || `Import failed (HTTP ${imp.status}).` });
        return;
      }
      console.log(`[scan] done — report ready for scan ${impData.id}`);
      json(res, 200, { ok: true, scanId: impData.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scan failed.";
      console.error(`[scan] error: ${message}`);
      json(res, 500, { ok: false, error: message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/crawl") {
    const body = await readBody(req);
    if (!body || typeof body.url !== "string" || typeof body.token !== "string" || typeof body.importUrl !== "string") {
      json(res, 400, { ok: false, error: "Expected { url, token, importUrl, maxPages }." });
      return;
    }
    const maxPages = Math.min(Math.max(1, Number(body.maxPages) || 150), 300);
    console.log(`\n[crawl] opening ${body.url} (maxPages=${maxPages})`);
    try {
      const crawl = await crawlInBrowser(body.url, maxPages);
      console.log(`[crawl] crawled ${crawl.pagesCrawled}/${crawl.totalDiscovered} pages; importing…`);
      const imp = await fetch(body.importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: body.token, crawlJson: crawl }),
      });
      const impData = await imp.json().catch(() => ({}));
      if (!imp.ok) {
        console.error(`[crawl] import failed: ${impData.error || imp.status}`);
        json(res, 502, { ok: false, error: impData.error || `Import failed (HTTP ${imp.status}).` });
        return;
      }
      console.log(`[crawl] done — ${impData.pagesCrawled} pages imported`);
      json(res, 200, { ok: true, pagesCrawled: crawl.pagesCrawled, totalDiscovered: crawl.totalDiscovered });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Crawl failed.";
      console.error(`[crawl] error: ${message}`);
      json(res, 500, { ok: false, error: message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/serp") {
    const body = await readBody(req);
    const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (
      !body ||
      typeof body.token !== "string" ||
      typeof body.importUrl !== "string" ||
      !strArr(body.keywords) ||
      !strArr(body.ourHosts) ||
      !strArr(body.competitorHosts)
    ) {
      json(res, 400, { ok: false, error: "Expected { token, importUrl, keywords, ourHosts, competitorHosts }." });
      return;
    }
    const keywords = [...new Set(body.keywords.map((k) => k.trim()).filter(Boolean))].slice(0, 10);
    console.log(`
[serp] checking Google (Canada) for ${keywords.length} keyword(s)`);
    try {
      const serp = await serpInBrowser({
        keywords,
        ourHosts: body.ourHosts.map(stripWwwHost),
        competitorHosts: body.competitorHosts.map(stripWwwHost),
      });
      const imp = await fetch(body.importUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: body.token, serpJson: serp }),
      });
      const impData = await imp.json().catch(() => ({}));
      if (!imp.ok) {
        console.error(`[serp] import failed: ${impData.error || imp.status}`);
        json(res, 502, { ok: false, error: impData.error || `Import failed (HTTP ${imp.status}).` });
        return;
      }
      console.log(`[serp] done`);
      json(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Google check failed.";
      console.error(`[serp] error: ${message}`);
      json(res, 429, { ok: false, error: message });
    }
    return;
  }

  json(res, 404, { ok: false, error: "Not found." });
});

server.listen(PORT, HOST, () => {
  console.log(`SEOer local scan helper listening on http://${HOST}:${PORT}`);
  console.log(`Leave this running, then click "Scan on my computer" in the dashboard.`);
});
