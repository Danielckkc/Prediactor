import * as cheerio from "cheerio";

const SKIP_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".css",
  ".js",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".xml",
  ".rss",
  ".atom",
]);

const ALLOW_EXTENSIONS = new Set([".html", ".htm"]);

/** @param {string} pathname */
function shouldSkipByExtension(pathname) {
  const lastDot = pathname.lastIndexOf(".");
  if (lastDot === -1) return false;
  const ext = pathname.slice(lastDot).toLowerCase().split("?")[0];
  if (ALLOW_EXTENSIONS.has(ext)) return false;
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Extract deduplicated HTTP(S) links from an HTML string.
 * Resolves relative URLs against `baseUrl`, strips fragments,
 * and filters out non-page resources (images, fonts, etc.).
 *
 * @param {string} html - Raw HTML content
 * @param {string} baseUrl - Base URL for resolving relative hrefs
 * @returns {string[]} Array of unique absolute URLs
 */
export function extractLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const results = [];

  $("a[href]").each((_, element) => {
    const raw = $(element).attr("href");
    if (!raw) return;

    let absolute;
    try {
      const parsed = new URL(raw, baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (shouldSkipByExtension(parsed.pathname)) return;
      parsed.hash = "";
      absolute = parsed.toString();
    } catch {
      return;
    }

    const key = absolute.replace(/\/+$/, "") || absolute;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(absolute);
  });

  return results;
}
