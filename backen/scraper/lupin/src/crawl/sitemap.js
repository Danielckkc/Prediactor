/**
 * Sitemap.xml parser and robots.txt rule extraction.
 *
 * Regex-based XML parsing to avoid adding an XML parser dependency.
 * Supports <urlset> and recursive <sitemapindex> formats.
 */

/**
 * Parse robots.txt content and extract rules for the wildcard (*) user-agent.
 * Sitemap directives are extracted regardless of user-agent block.
 *
 * @param {string} content - Raw robots.txt content
 * @returns {{ disallow: string[], allow: string[], sitemaps: string[] }}
 */
export function parseRobotsTxt(content) {
  const result = { disallow: [], allow: [], sitemaps: [] };
  if (!content) return result;
  let inWildcardBlock = false;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const lowerLine = line.toLowerCase();

    if (lowerLine.startsWith("sitemap:")) {
      const url = line.slice("sitemap:".length).trim();
      if (url) result.sitemaps.push(url);
      continue;
    }
    if (lowerLine.startsWith("user-agent:")) {
      const agent = line.slice("user-agent:".length).trim();
      inWildcardBlock = agent === "*";
      continue;
    }
    if (!inWildcardBlock) continue;
    if (lowerLine.startsWith("disallow:")) {
      const path = line.slice("disallow:".length).trim();
      if (path) result.disallow.push(path);
    } else if (lowerLine.startsWith("allow:")) {
      const path = line.slice("allow:".length).trim();
      if (path) result.allow.push(path);
    }
  }
  return result;
}

/**
 * Fetch and parse a sitemap XML. Handles both <urlset> and <sitemapindex>.
 *
 * @param {string} sitemapUrl - URL of the sitemap to fetch
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - Request timeout in ms
 * @param {number} [options.maxDepth=2] - Max recursion depth for sitemap indexes
 * @param {number} [options._currentDepth=0] - Internal: current recursion depth
 * @returns {Promise<string[]>} Array of URLs found in the sitemap
 */
export async function fetchSitemap(sitemapUrl, options = {}) {
  const timeout = options.timeout ?? 10000;
  const maxDepth = options.maxDepth ?? 2;
  const currentDepth = options._currentDepth ?? 0;
  if (currentDepth > maxDepth) return [];

  let body;
  try {
    const response = await fetch(sitemapUrl, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": "Lupin-Crawler/1.0" },
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    });
    if (!response.ok) return [];
    body = await response.text();
  } catch {
    return [];
  }

  const urls = [];
  const sitemapLocRegex = /<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/g;
  let isSitemapIndex = false;
  let match;

  while ((match = sitemapLocRegex.exec(body)) !== null) {
    isSitemapIndex = true;
    const childUrl = match[1].trim();
    const childUrls = await fetchSitemap(childUrl, {
      timeout,
      maxDepth,
      dispatcher: options.dispatcher,
      _currentDepth: currentDepth + 1,
    });
    urls.push(...childUrls);
  }
  if (isSitemapIndex) return urls;

  const urlLocRegex = /<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g;
  while ((match = urlLocRegex.exec(body)) !== null) {
    urls.push(match[1].trim());
  }
  return urls;
}

/**
 * Fetch and parse robots.txt from a given origin URL.
 *
 * @param {string} originUrl - Any URL; the origin is extracted automatically
 * @param {object} [options]
 * @param {number} [options.timeout=10000] - Request timeout in ms
 * @returns {Promise<{ disallow: string[], allow: string[], sitemaps: string[] }>}
 */
export async function fetchRobotsTxt(originUrl, options = {}) {
  const timeout = options.timeout ?? 10000;
  const origin = new URL(originUrl).origin;
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": "Lupin-Crawler/1.0" },
      ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
    });
    if (!response.ok) return { disallow: [], allow: [], sitemaps: [] };
    const content = await response.text();
    return parseRobotsTxt(content);
  } catch {
    return { disallow: [], allow: [], sitemaps: [] };
  }
}
