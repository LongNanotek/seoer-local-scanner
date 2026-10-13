// Node + cheerio parsing for the whole-site crawl. Runs in the helper (NOT in
// the page) because we fetch same-origin pages via Playwright's context.request
// after the challenge clears. Mirrors the server's extractors
// (src/lib/page-signals.ts, src/lib/site-corpus.ts, src/lib/competitor-page.ts)
// field-for-field so a crawl stays consistent with a single-page scan — keep in
// sync if those change.

import * as cheerio from "cheerio";

// --- sitemap discovery (mirrors collectLocs / fetchAllSitemapUrls) ---

export function collectLocs(xmlText) {
  try {
    const $ = cheerio.load(xmlText, { xmlMode: true });
    const locs = $("loc")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (locs.length === 0) return null;
    return { locs, isIndex: $("sitemapindex").length > 0 };
  } catch {
    return null;
  }
}

// Generic WordPress archive/listing paths — near-duplicate, never primary
// content (same list as site-corpus.ts).
const EXCLUDED_PATH_SEGMENTS = ["/category/", "/tag/", "/author/", "/page/"];

const KEY_PAGE_KEYWORDS = [
  "about", "team", "staff", "leadership", "meet", "management", "founder", "ceo",
  "director", "advisor", "advisers", "author", "bio", "faq", "process",
  "how-it-works", "methodology", "contact", "pricing", "service", "project",
  "portfolio", "invest",
];

function pathOf(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return "";
  }
}

// Paginated/sorted listing variants (/page/3, /sort/2026, ?page=2) — the same
// listing repeated, never unique content.
const PAGINATION = /\/page\/\d+|\/sort\/|[?&](page|paged|p)=\d+/i;

function isExcluded(url) {
  const p = pathOf(url);
  return (
    EXCLUDED_PATH_SEGMENTS.some((seg) => p.includes(seg)) ||
    PAGINATION.test(url) ||
    NON_PAGE_EXT.test(p) // media/documents listed in sitemaps (e.g. .mp3 recordings)
  );
}

function isKeyPage(url) {
  const p = pathOf(url);
  return KEY_PAGE_KEYWORDS.some((kw) => p.includes(kw));
}

function slugWeight(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).pop()?.length ?? 999;
  } catch {
    return 999;
  }
}

// A leading locale segment like /fr/, /zh-hans/, /pt-br/ — translated copies of
// the same pages, which would otherwise crowd out real topic breadth.
const LOCALE_PREFIX = /^\/[a-z]{2}(?:-[a-z]{2,4})?\//i;

function sectionOf(url) {
  const segs = pathOf(url).split("/").filter(Boolean);
  return segs.length === 0 ? "/" : segs.slice(0, Math.min(2, segs.length - 1) || 1).join("/");
}

// Pick a capped, representative sample: drop archive/listing duplicates, drop
// translated copies when the site has a default-language version, then
// round-robin across site sections (key sections first) so the crawl covers
// topic breadth instead of many near-identical pages from one section.
export function selectPages(urls, maxPages) {
  let pool = [...new Set(urls)].filter((u) => !isExcluded(u));
  const defaultLang = pool.filter((u) => !LOCALE_PREFIX.test(pathOf(u)));
  if (defaultLang.length >= 10) pool = defaultLang;

  const groups = new Map();
  for (const u of pool) {
    const s = sectionOf(u);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(u);
  }
  for (const list of groups.values()) list.sort((a, b) => slugWeight(a) - slugWeight(b));
  const ordered = [...groups.entries()]
    .sort((a, b) => {
      const ak = a[1].some(isKeyPage) ? 1 : 0;
      const bk = b[1].some(isKeyPage) ? 1 : 0;
      return bk - ak || b[1].length - a[1].length;
    })
    .map(([, list]) => list);

  const picked = [];
  for (let round = 0; picked.length < maxPages; round++) {
    let added = false;
    for (const list of ordered) {
      if (round < list.length) {
        picked.push(list[round]);
        added = true;
        if (picked.length >= maxPages) break;
      }
    }
    if (!added) break;
  }
  return picked;
}

// --- URL normalization + link discovery (fallback when there's no sitemap) ---

const stripWww = (h) => h.replace(/^www\./i, "").toLowerCase();
// Cheap first filter only — the crawler also rejects any response whose
// Content-Type isn't HTML, since no extension list is ever complete.
const NON_PAGE_EXT =
  /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|zip|rar|7z|gz|tar|exe|dmg|mp4|m4v|mov|avi|wmv|mkv|webm|mp3|m4a|wav|ogg|oga|aac|flac|docx?|xlsx?|pptx?|csv|xml|rss|atom|txt|css|js|json|woff2?|ttf|eot|epub)$/i;

// Map a URL onto the landing origin when it's the same site (apex <-> www),
// so every page stays same-origin for the in-page fetch. Returns null for
// off-site or non-http(s) URLs. Drops the #fragment.
export function toLanding(u, origin) {
  try {
    const url = new URL(u, origin);
    const o = new URL(origin);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (stripWww(url.hostname) !== stripWww(o.hostname)) return null;
    url.protocol = o.protocol;
    url.host = o.host;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

// Same-site page links from a page's HTML, normalized onto the landing origin.
export function extractLinks(html, pageUrl, origin) {
  const $ = cheerio.load(html);
  const out = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return;
    let abs;
    try {
      abs = new URL(href, pageUrl).toString();
    } catch {
      return;
    }
    const n = toLanding(abs, origin);
    if (n && !NON_PAGE_EXT.test(new URL(n).pathname)) out.add(n);
  });
  return [...out];
}

// `Sitemap:` declarations from robots.txt.
export function sitemapsFromRobots(robotsText) {
  return [...robotsText.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
}

// --- per-page extraction (mirrors page-signals.ts) ---

function collectTypes(item, out) {
  if (!item || typeof item !== "object") return;
  const t = item["@type"];
  if (typeof t === "string") out.add(t);
  else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.add(x));
  if (Array.isArray(item["@graph"])) item["@graph"].forEach((i) => collectTypes(i, out));
}

// Collapse whitespace and clamp to a length well under the server's
// siteCrawlSchema caps — a malformed <h2> wrapping a whole section would
// otherwise make the server reject the entire crawl.
const clean = (s, max) => {
  const v = (s || "").replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : null;
};

export function extractCrawlPage(html, url) {
  const $ = cheerio.load(html);
  const title = clean($("title").first().text(), 500);
  const metaDescription = clean($('meta[name="description"]').attr("content"), 1000);
  const h1 = clean($("h1").first().text(), 300);
  const h2s = $("h2")
    .map((_, el) => clean($(el).text(), 300))
    .get()
    .filter(Boolean)
    .slice(0, 15);

  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript").remove();
  bodyClone.find("h1, h2, h3, h4, h5, h6, p, li, br, div, section, article, tr").after("\n");
  const bodyText = bodyClone
    .text()
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  let internalLinkCount = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    try {
      if (new URL(href, url).hostname === host) internalLinkCount++;
    } catch {
      /* ignore */
    }
  });

  const typeSet = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      (Array.isArray(parsed) ? parsed : [parsed]).forEach((i) => collectTypes(i, typeSet));
    } catch {
      /* ignore invalid JSON-LD */
    }
  });

  return {
    url,
    title,
    metaDescription,
    h1,
    h2s,
    wordCount,
    internalLinkCount,
    structuredDataTypes: [...typeSet].map((t) => String(t).slice(0, 200)).slice(0, 50),
  };
}
