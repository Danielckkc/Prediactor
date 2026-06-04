import * as cheerio from "cheerio";

/**
 * Extract structured data from raw HTML for the JSON output format.
 *
 * Returns metadata, links, images, and headings — giving JSON consumers
 * machine-readable page structure rather than a flat text blob.
 */
export function extractStructuredJson(rawHtml, pageUrl) {
  if (!rawHtml || typeof rawHtml !== "string") {
    return null;
  }

  const $ = cheerio.load(rawHtml);

  const metadata = extractMetadata($, pageUrl);
  const title = metadata.title || "";
  const headings = extractHeadings($);
  const links = extractLinks($, pageUrl);
  const images = extractImages($, pageUrl);

  return { title, metadata, headings, links, images };
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function meta($, name) {
  return (
    $(`meta[property="${name}"]`).attr("content") ||
    $(`meta[name="${name}"]`).attr("content") ||
    ""
  ).trim();
}

function extractMetadata($, pageUrl) {
  const title =
    meta($, "og:title") ||
    meta($, "twitter:title") ||
    $("title").first().text().trim() ||
    "";

  const description =
    meta($, "og:description") ||
    meta($, "twitter:description") ||
    meta($, "description") ||
    "";

  const siteName = meta($, "og:site_name") || "";
  const author =
    meta($, "author") ||
    meta($, "article:author") ||
    $('link[rel="author"]').attr("href") ||
    "";
  const publishedAt =
    meta($, "article:published_time") ||
    meta($, "datePublished") ||
    $("time[datetime]").first().attr("datetime") ||
    "";
  const modifiedAt =
    meta($, "article:modified_time") ||
    meta($, "dateModified") ||
    "";
  const language =
    $("html").attr("lang") ||
    meta($, "og:locale") ||
    "";
  const canonicalUrl =
    $('link[rel="canonical"]').attr("href") ||
    meta($, "og:url") ||
    "";
  const ogImage = meta($, "og:image") || meta($, "twitter:image") || "";
  const favicon = resolveFavicon($, pageUrl);
  const keywords = parseKeywords(meta($, "keywords"));
  const type = meta($, "og:type") || "";

  return {
    title,
    description,
    siteName,
    type: type || undefined,
    author: author || undefined,
    publishedAt: publishedAt || undefined,
    modifiedAt: modifiedAt || undefined,
    language: language || undefined,
    canonicalUrl: canonicalUrl || undefined,
    ogImage: absolutize(ogImage, pageUrl) || undefined,
    favicon: favicon || undefined,
    keywords: keywords.length ? keywords : undefined,
  };
}

function resolveFavicon($, baseUrl) {
  const link =
    $('link[rel="icon"]').attr("href") ||
    $('link[rel="shortcut icon"]').attr("href") ||
    "";
  return absolutize(link, baseUrl) || undefined;
}

function parseKeywords(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

const HEADING_RE = /^h([1-6])$/i;

function extractHeadings($) {
  const headings = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = el.tagName || el.name;
    const match = HEADING_RE.exec(tag);
    if (!match) return;

    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;

    headings.push({ level: Number(match[1]), text });
  });
  return headings;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

const MAX_LINKS = 200;

function extractLinks($, baseUrl) {
  const seen = new Set();
  const links = [];

  $("a[href]").each((_, el) => {
    if (links.length >= MAX_LINKS) return false;

    const raw = $(el).attr("href") || "";
    const href = absolutize(raw, baseUrl);
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) return;
    if (seen.has(href)) return;
    seen.add(href);

    const text = $(el).text().replace(/\s+/g, " ").trim();
    const entry = { href };
    if (text) entry.text = text;
    links.push(entry);
  });

  return links;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const MAX_IMAGES = 50;
const NOISE_IMAGE_RE = /\b(tracking|pixel|spacer|beacon|blank|1x1|logo-small|sprite|icon[-_]?set)\b/i;
const LAZY_SRC_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-src-medium", "data-hi-res-src"];

/**
 * Resolve the best image URL from an element, preferring lazy-load attributes
 * over `src` (which is often a placeholder pixel on lazy-loaded images).
 */
function resolveImgSrc($el) {
  for (const attr of LAZY_SRC_ATTRS) {
    const val = $el.attr(attr);
    if (val && !val.startsWith("data:")) return val;
  }
  // srcset on <img> — pick the highest-resolution candidate
  const srcset = $el.attr("srcset");
  if (srcset) {
    const best = parseSrcsetBest(srcset);
    if (best) return best;
  }
  return $el.attr("src") || "";
}

/**
 * Parse a srcset string and return the URL of the largest/highest-resolution candidate.
 */
function parseSrcsetBest(srcset) {
  let best = null;
  let bestVal = 0;
  for (const entry of srcset.split(",")) {
    const parts = entry.trim().split(/\s+/);
    if (!parts[0]) continue;
    const descriptor = parts[1] || "1x";
    const numeric = parseFloat(descriptor) || 1;
    if (numeric >= bestVal) {
      bestVal = numeric;
      best = parts[0];
    }
  }
  return best;
}

function extractImages($, baseUrl) {
  // Strip boilerplate regions so we focus on content images
  const clone = $.root().clone();
  clone.find("nav, footer, header, aside, [role='navigation'], [role='banner']").remove();

  const seen = new Set();
  const images = [];

  clone.find("img, picture source[srcset]").each((_, el) => {
    if (images.length >= MAX_IMAGES) return false;

    const $el = $(el);
    const tag = el.tagName || el.name;
    let src;
    if (tag === "source") {
      src = parseSrcsetBest($el.attr("srcset") || "") || "";
    } else {
      src = resolveImgSrc($el);
    }

    const resolved = absolutize(src, baseUrl);
    if (!resolved || resolved.startsWith("data:")) return;
    if (NOISE_IMAGE_RE.test(resolved)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);

    const alt = ($el.attr("alt") || "").trim();
    const width = parseInt($el.attr("width"), 10) || undefined;
    const height = parseInt($el.attr("height"), 10) || undefined;

    const entry = { src: resolved };
    if (alt) entry.alt = alt;
    if (width) entry.width = width;
    if (height) entry.height = height;
    images.push(entry);
  });

  return images;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function absolutize(candidate, baseUrl) {
  if (!candidate || !candidate.trim()) return "";
  try {
    return new URL(candidate.trim(), baseUrl).toString();
  } catch {
    return "";
  }
}
