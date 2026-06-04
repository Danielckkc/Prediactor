function dedupeResults(items, limit, source = null) {
  const seen = new Set();
  const results = [];

  for (const item of items) {
    if (!item?.url || !item?.title) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    results.push({
      rank: results.length + 1,
      title: item.title,
      url: item.url,
      snippet: item.snippet || "",
      source: item.source || source,
    });
    if (results.length >= limit) break;
  }

  return results;
}

export function buildDateOperatorQuery(query, options = {}, operators = {}) {
  const parts = [query];

  if (options.sort === "recent" && operators.recent) {
    parts.push(operators.recent);
  }

  if (options.dateFrom && operators.dateFrom) {
    parts.push(`${operators.dateFrom}${options.dateFrom}`);
  }

  if (options.dateTo && operators.dateTo) {
    parts.push(`${operators.dateTo}${options.dateTo}`);
  }

  return parts.filter(Boolean).join(" ").trim();
}

export async function extractSearchResultsFromAnchors(page, options = {}) {
  const raw = await page.evaluate(({ selectors, excludeHostPatterns }) => {
    function shouldExclude(url) {
      try {
        const parsed = new URL(url);
        return excludeHostPatterns.some((pattern) => parsed.hostname.includes(pattern));
      } catch {
        return true;
      }
    }

    return Array.from(document.querySelectorAll(selectors.join(",")))
      .map((anchor) => {
        const href = anchor.href;
        if (!href || shouldExclude(href)) return null;

        const text = (anchor.innerText || anchor.getAttribute("aria-label") || "").trim();
        const lines = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        if (lines.length === 0) return null;

        const title = lines[0];
        const snippet = lines.slice(1).join(" ").trim();

        return { title, url: href, snippet };
      })
      .filter(Boolean);
  }, options);

  return dedupeResults(raw, options.limit || 10, options.source || null);
}
