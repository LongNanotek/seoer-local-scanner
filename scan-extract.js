// Runs INSIDE the page (via Playwright page.evaluate) against the fully
// rendered DOM — after the Cloudflare challenge has cleared. Produces the
// DOM-derived half of a PageSignals object; the helper (server.mjs) fills in
// robotsTxt / sitemap / llmsTxt from separate fetches and sets finalUrl.
//
// This deliberately mirrors the server's extractPageSignals (src/lib/
// page-signals.ts) field-for-field so scores stay comparable. Must be fully
// self-contained (no imports, no outer-scope references) — it is serialized
// and executed in the browser.
export function extractSignals() {
  const finalUrl = document.location.href;

  function unwrapOptimizedImageUrl(url) {
    const m = url.match(/\/al_opt_content\/IMAGE\/([^/]+)(\/.*?)(?:\?|$)/);
    return m ? "https://" + m[1] + m[2] : url;
  }
  function resolveImageSrc(el) {
    const c = [
      el.getAttribute("data-src"),
      el.getAttribute("bv-data-src"),
      el.getAttribute("data-lazy-src"),
      el.getAttribute("data-original"),
      el.getAttribute("src"),
    ];
    const picked = c.find((x) => x && !x.startsWith("data:")) || c.find(Boolean) || "";
    return unwrapOptimizedImageUrl(picked);
  }

  const title = (document.querySelector("title")?.textContent || "").trim() || null;
  const metaDescription =
    document.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || null;
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;
  const metaRobots = document.querySelector('meta[name="robots"]')?.getAttribute("content")?.trim() || null;
  const lang = document.documentElement.getAttribute("lang") || null;

  const h1s = [...document.querySelectorAll("h1")].map((h) => (h.textContent || "").trim()).filter(Boolean).slice(0, 10);
  const h2s = [...document.querySelectorAll("h2")].map((h) => (h.textContent || "").trim()).filter(Boolean).slice(0, 15);

  // Block-separated body text, scripts/styles stripped — same as the server.
  const bodyClone = document.body.cloneNode(true);
  bodyClone.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
  bodyClone
    .querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, br, div, section, article, tr")
    .forEach((n) => n.after("\n"));
  const bodyText = (bodyClone.textContent || "")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;
  const textExcerpt = bodyText.slice(0, 12000);

  const imgEls = [...document.querySelectorAll("img")];
  const imageCount = imgEls.length;
  const imagesMissingAlt = imgEls.filter((el) => !(el.getAttribute("alt") || "").trim()).length;
  const imagesForAltReview = imgEls
    .slice(0, 30)
    .map((el, index) => {
      const src = resolveImageSrc(el);
      const currentAlt = (el.getAttribute("alt") || "").trim() || null;
      const m = (el.getAttribute("class") || "").match(/\bwp-image-(\d+)\b/);
      const wpMediaId = m ? Number(m[1]) : null;
      const container = el.closest("figure, [class*='card'], div");
      const nearEl = (container || el).querySelector("h1,h2,h3,h4,figcaption,p");
      const nearbyText = nearEl ? (nearEl.textContent || "").trim().slice(0, 120) : "";
      try {
        return {
          index,
          src: new URL(src, finalUrl).toString(),
          currentAlt,
          nearbyText: nearbyText || null,
          wpMediaId,
        };
      } catch {
        return null;
      }
    })
    .filter((x) => x !== null);

  let internalLinkCount = 0;
  let externalLinkCount = 0;
  const seen = new Set();
  const linkedText = [];
  [...document.querySelectorAll("a[href]")].forEach((el) => {
    const href = el.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return;
    let resolved;
    try {
      resolved = new URL(href, finalUrl);
    } catch {
      return;
    }
    if (resolved.hostname === document.location.hostname) internalLinkCount++;
    else externalLinkCount++;
    const t = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (t.length >= 4 && t.length <= 80 && linkedText.length < 60 && !seen.has(t)) {
      seen.add(t);
      linkedText.push({ text: t, href });
    }
  });

  const typeSet = new Set();
  function collectTypes(item) {
    if (!item || typeof item !== "object") return;
    const t = item["@type"];
    if (typeof t === "string") typeSet.add(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && typeSet.add(x));
    if (Array.isArray(item["@graph"])) item["@graph"].forEach(collectTypes);
  }
  [...document.querySelectorAll('script[type="application/ld+json"]')].forEach((el) => {
    try {
      const parsed = JSON.parse(el.textContent || "");
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(collectTypes);
    } catch {
      /* ignore invalid JSON-LD */
    }
  });

  const openGraph = {};
  [...document.querySelectorAll('meta[property^="og:"]')].forEach((el) => {
    const p = el.getAttribute("property");
    const c = el.getAttribute("content");
    if (p && c) openGraph[p] = c;
  });
  const twitterCard = {};
  [...document.querySelectorAll('meta[name^="twitter:"]')].forEach((el) => {
    const n = el.getAttribute("name");
    const c = el.getAttribute("content");
    if (n && c) twitterCard[n] = c;
  });

  const counterStats = [];
  [...document.querySelectorAll("[data-counter], [data-to-value], [data-target], [data-count]")]
    .slice(0, 20)
    .forEach((el) => {
      const value =
        el.getAttribute("data-counter") ??
        el.getAttribute("data-to-value") ??
        el.getAttribute("data-target") ??
        el.getAttribute("data-count");
      if (!value) return;
      const container = el.closest('[class*="widget"], [class*="counter"], [class*="stat"]');
      const titleEl = (container || el).querySelector('[class*="title"], [class*="label"]');
      const label = titleEl ? (titleEl.textContent || "").trim() || null : null;
      counterStats.push({ value, label });
    });

  return {
    finalUrl,
    httpStatus: 200,
    loadTimeMs: Math.round(performance.now()),
    title,
    metaDescription,
    canonicalUrl,
    metaRobots,
    lang,
    h1s,
    h2s,
    wordCount,
    imageCount,
    imagesMissingAlt,
    imagesForAltReview,
    internalLinkCount,
    externalLinkCount,
    linkedText,
    structuredDataTypes: [...typeSet],
    openGraph,
    twitterCard,
    textExcerpt,
    counterStats,
  };
}
