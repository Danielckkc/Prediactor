import { BrowserManager } from "../../runtime/browser-manager.js";
import { createSearchResponse } from "../base/result-shapes.js";
import { mergeSearchQuery, randomDelay, snapshotDateUtc } from "../base/fallbacks.js";
import { createSearchSessionCache } from "../base/session-cache.js";

const braveSession = createSearchSessionCache(10 * 60 * 1000);

function buildBraveSearchUrl(query, options = {}) {
  const params = new URLSearchParams({
    q: mergeSearchQuery(query, options),
    source: "web",
  });

  return `https://search.brave.com/search?${params.toString()}`;
}

function buildBraveSearchQuery(query, options = {}) {
  return mergeSearchQuery(query, options);
}


async function simulateLightInteraction(page) {
  await page.mouse.move(160, 170, { steps: 10 }).catch(() => {});
  await page.waitForTimeout(randomDelay(100, 180));
  await page.mouse.move(420, 230, { steps: 14 }).catch(() => {});
  await page.waitForTimeout(randomDelay(100, 180));
  await page.mouse.wheel(0, 220).catch(() => {});
  await page.waitForTimeout(randomDelay(120, 200));
  await page.mouse.wheel(0, -220).catch(() => {});
  await page.waitForTimeout(randomDelay(120, 200));
}

async function detectBraveBlock(page) {
  const finalUrl = page.url();
  const text = await page.evaluate(() => document.body?.innerText || document.body?.textContent || "").catch(() => "");
  return {
    blocked: /captcha|access denied|unusual traffic/i.test(text),
    finalUrl,
    text,
  };
}

function normalizeBraveResultUrl(value) {
  try {
    const url = new URL(value, "https://search.brave.com");
    if (!/^https?:/.test(url.protocol)) return null;
    if (url.hostname.includes("search.brave.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const BRAVE_PAGE_SIZE = 20;
const BRAVE_MAX_PAGES = 10;

export function buildBraveResultsFromContainers(items, limit = 10) {
  const maxResults = Math.max(limit || 10, 1);
  const seen = new Set();
  const results = [];

  for (const item of items || []) {
    const url = normalizeBraveResultUrl(item?.url);
    const title = String(item?.title || "").trim();
    const containerText = String(item?.text || "");

    if (!url || !title || seen.has(url)) continue;
    if (item?.parentId === "search-ad") continue;
    if (/sponsored/i.test(containerText)) continue;

    seen.add(url);
    results.push({
      rank: results.length + 1,
      title,
      url,
      snippet: String(item?.snippet || "").trim().slice(0, 400),
      source: "brave",
    });

    if (results.length >= maxResults) break;
  }

  return results;
}

async function extractBraveResults(page, options = {}) {
  const rawResults = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".result-wrapper"))
      .map((container) => {
        const primaryLink =
          container.querySelector(".result-content a[href]") ||
          container.querySelector('a[href]:not([href*="search.brave.com"])');
        if (!primaryLink) return null;

        const containerText = (container.innerText || container.textContent || "").trim();
        const lines = containerText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const titleLines = (primaryLink.innerText || primaryLink.textContent || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const title = titleLines[0] || lines[0] || "";

        let snippetLines = [...lines];
        while (snippetLines.length > 0 && titleLines.includes(snippetLines[0])) {
          snippetLines.shift();
        }

        if (snippetLines[0] && (/[›>]/.test(snippetLines[0]) || /^[a-z0-9.-]+\.[a-z]{2,}\b/i.test(snippetLines[0]))) {
          snippetLines.shift();
        }

        return {
          title,
          url: primaryLink.href,
          snippet: snippetLines.join(" ").trim(),
          text: containerText,
          parentId: container.parentElement?.id || "",
        };
      })
      .filter(Boolean)
  );

  return buildBraveResultsFromContainers(rawResults, options.limit);
}

async function waitForBraveResults(page, timeoutMs) {
  await Promise.race([
    page.waitForFunction(
      () => document.querySelectorAll(".result-wrapper").length >= 3,
    ),
    page.waitForTimeout(Math.min(timeoutMs, 10000)),
  ]).catch(() => {});
}

async function homepageSearch(page, query, options, timeoutMs) {
  await page.goto("https://search.brave.com/", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(randomDelay(400, 500));
  await simulateLightInteraction(page);

  const input = page.locator('input[type="search"], input[name="q"], textarea').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  await input.click({ timeout: timeoutMs });
  await page.waitForTimeout(randomDelay(150, 250));
  await input.fill("");
  for (const char of buildBraveSearchQuery(query, options)) {
    await page.keyboard.type(char, { delay: 0 });
    await page.waitForTimeout(randomDelay(68, 98));
  }
  await page.waitForTimeout(randomDelay(300, 500));
  await page.keyboard.press("Enter");
  await waitForBraveResults(page, timeoutMs);

  const blockState = await detectBraveBlock(page);
  if (blockState.blocked) {
    return {
      blocked: true,
      warnings: ["Brave search was blocked or challenged."],
      results: [],
    };
  }

  const text = blockState.text;
  if (/No results found/i.test(text)) {
    return {
      blocked: false,
      warnings: [],
      results: [],
    };
  }

  const limit = options.limit || 10;
  const firstPageResults = await extractBraveResults(page, { ...options, limit: Math.min(limit, BRAVE_PAGE_SIZE) });
  const dateWarnings = options.dateFrom || options.dateTo ? ["Brave date range filtering is not fully implemented yet; results may exceed the requested window."] : [];

  // Paginate from homepage search by switching to offset URLs
  const allResults = [...firstPageResults];
  const maxPages = Math.min(Math.ceil(limit / BRAVE_PAGE_SIZE), BRAVE_MAX_PAGES);
  for (let pageNum = 1; pageNum < maxPages && allResults.length < limit; pageNum++) {
    await navigateToBravePage(page, query, options, pageNum, timeoutMs);

    const pageBlockState = await detectBraveBlock(page);
    if (pageBlockState.blocked) break;
    if (/No results found/i.test(pageBlockState.text)) break;

    const pageResults = await extractBraveResults(page, { ...options, limit: BRAVE_PAGE_SIZE });
    if (pageResults.length === 0) break;

    const seenUrls = new Set(allResults.map((r) => r.url));
    for (const result of pageResults) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      allResults.push({ ...result, rank: allResults.length + 1 });
      if (allResults.length >= limit) break;
    }
  }

  return {
    blocked: false,
    warnings: [
      ...dateWarnings,
      ...(allResults.length === 0 ? ["Brave homepage search returned no parseable results."] : []),
    ],
    results: allResults.slice(0, limit),
  };
}

async function navigateToBravePage(page, query, options, pageNumber, timeoutMs) {
  const currentUrl = new URL(page.url());
  currentUrl.searchParams.set("offset", String(pageNumber));
  await page.goto(currentUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForBraveResults(page, timeoutMs);
}

async function directSearch(page, query, options, timeoutMs) {
  await page.goto(buildBraveSearchUrl(query, options), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForBraveResults(page, timeoutMs);

  const blockState = await detectBraveBlock(page);
  if (blockState.blocked) {
    return {
      blocked: true,
      warnings: ["Brave search was blocked or challenged."],
      results: [],
    };
  }

  if (/No results found/i.test(blockState.text)) {
    return {
      blocked: false,
      warnings: [],
      results: [],
    };
  }

  const limit = options.limit || 10;
  const dateWarnings = options.dateFrom || options.dateTo ? ["Brave date range filtering is not fully implemented yet; results may exceed the requested window."] : [];
  const allResults = await extractBraveResults(page, { ...options, limit: Math.min(limit, BRAVE_PAGE_SIZE) });

  // Paginate if we need more
  const maxPages = Math.min(Math.ceil(limit / BRAVE_PAGE_SIZE), BRAVE_MAX_PAGES);
  for (let pageNum = 1; pageNum < maxPages && allResults.length < limit; pageNum++) {
    await navigateToBravePage(page, query, options, pageNum, timeoutMs);

    const pageBlockState = await detectBraveBlock(page);
    if (pageBlockState.blocked) break;
    if (/No results found/i.test(pageBlockState.text)) break;

    const pageResults = await extractBraveResults(page, { ...options, limit: BRAVE_PAGE_SIZE });
    if (pageResults.length === 0) break;

    const seenUrls = new Set(allResults.map((r) => r.url));
    for (const result of pageResults) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      allResults.push({ ...result, rank: allResults.length + 1 });
      if (allResults.length >= limit) break;
    }
  }

  return {
    blocked: false,
    warnings: [
      ...dateWarnings,
      ...(allResults.length === 0 ? ["Brave search returned no parseable results."] : []),
    ],
    results: allResults.slice(0, limit),
  };
}

export async function searchBrave(query, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const timeoutMs = options.timeout || 15000;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await braveSession.get(manager, timeoutMs);
      let outcome;
      try {
        outcome = await homepageSearch(session.page, query, options, timeoutMs);
        if (!outcome.blocked && outcome.results.length === 0) {
          outcome = await directSearch(session.page, query, options, timeoutMs);
        }
      } catch (error) {
        outcome = {
          blocked: true,
          warnings: [error?.message || String(error)],
          results: [],
        };
      }

      braveSession.touch(manager, session);

      if (!outcome.blocked) {
        return createSearchResponse("brave", query, "homepage_search", snapshotDateUtc(), outcome.results, outcome.warnings, false, startedAt);
      }

      await braveSession.invalidate(manager);
    }

    return createSearchResponse("brave", query, "homepage_search", snapshotDateUtc(), [], ["Brave search was blocked or challenged."], true, startedAt);
  } catch (error) {
    await braveSession.invalidate(manager);
    return createSearchResponse("brave", query, "homepage_search", snapshotDateUtc(), [], [error?.message || String(error)], true, startedAt);
  }
}
