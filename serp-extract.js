// Runs INSIDE a Google results page (via page.evaluate). Returns the organic
// results in on-page order, plus whether Google is showing an interstitial the
// user must handle themselves (a CAPTCHA, or a consent screen). Never touches
// or solves a CAPTCHA — it only reports that one is showing.
//
// Google now links results through an opaque redirect (/goto?url=<token>), so
// the destination isn't in the href. Each result still DISPLAYS its site
// (<cite>, e.g. "https://lendcity.ca › Blog"), which is what we rank by. The
// redirect href is kept so the helper can follow it (like a click) for the few
// pages it needs to analyse.
//
// Must be self-contained (no imports/closures): it's serialized into the page.
export function extractSerp() {
  const href = location.href;
  const needsUser =
    /\/sorry\//.test(href) ||
    /(^|\.)consent\.google\./.test(location.hostname) ||
    !!document.querySelector("#captcha-form, iframe[src*='recaptcha']");
  if (needsUser) return { needsUser: true, results: [] };

  const isGoogle = (host) => /(^|\.)google\.[a-z.]+$/i.test(host);

  // Destination of a result anchor: a direct link, Google's old /url?q=, or —
  // for the new opaque /goto redirect — the origin shown in the result's <cite>.
  function destination(a) {
    let u;
    try {
      u = new URL(a.href);
    } catch {
      return null;
    }
    if (!isGoogle(u.hostname)) return { url: u, display: u.toString() };
    const q = u.searchParams.get("q") || u.searchParams.get("url");
    if (q && /^https?:\/\//i.test(q)) {
      try {
        return { url: new URL(q), display: q };
      } catch {
        /* fall through to cite */
      }
    }
    const block = a.closest("[data-hveid], [data-ved], .g, .MjjYud") || a.parentElement;
    const cite = block && block.querySelector("cite");
    const shown = cite ? (cite.textContent || "").replace(/\s+/g, " ").trim() : "";
    const origin = shown.split(" › ")[0].trim();
    if (!/^https?:\/\//i.test(origin)) return null;
    try {
      return { url: new URL(origin), display: shown };
    } catch {
      return null;
    }
  }

  const root = document.querySelector("#rso") || document.querySelector("#search") || document.body;
  const seen = new Set();
  const results = [];
  for (const h3 of root.querySelectorAll("a h3")) {
    const a = h3.closest("a");
    if (!a) continue;
    // Sponsored results live in ad containers — never count them as rankings.
    if (a.closest("#tads, #tadsb, #bottomads, [data-text-ad], [aria-label='Ads'], [aria-label='Sponsored']")) continue;
    const dest = destination(a);
    if (!dest || !/^https?:$/.test(dest.url.protocol) || isGoogle(dest.url.hostname)) continue;
    dest.url.hash = "";
    const key = a.href;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      url: dest.url.toString(),
      domain: dest.url.hostname.replace(/^www\./i, "").toLowerCase(),
      display: dest.display.slice(0, 500),
      title: (h3.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      href: a.href, // Google's redirect — followed later only for pages we analyse
    });
  }
  return { needsUser: false, results };
}
