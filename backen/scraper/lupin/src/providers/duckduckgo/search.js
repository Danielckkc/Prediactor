import { BrowserManager } from "../../runtime/browser-manager.js";
import { mergeSearchQuery, snapshotDateUtc } from "../base/fallbacks.js";
import { createSearchResponse } from "../base/result-shapes.js";
import { createSearchSessionCache } from "../base/session-cache.js";

const ddgSession = createSearchSessionCache(10 * 60 * 1000);

function buildDuckDuckGoUrl(query, options = {}) {
  const params = new URLSearchParams();
  params.set("q", mergeSearchQuery(query, options));

  if (options.dateFrom || options.dateTo) {
    const min = options.dateFrom || "1970-01-01";
    const max = options.dateTo || new Date().toISOString().slice(0, 10);
    params.set("df", `${min}..${max}`);
  } else if (options.sort === "recent") {
    params.set("df", "m");
  }

  return `https://duckduckgo.com/?${params.toString()}`;
}


async function simulateLightInteraction(page) {
  await page.mouse.move(160, 170, { steps: 10 }).catch(() => {});
  await page.waitForTimeout(150);
  await page.mouse.move(420, 230, { steps: 12 }).catch(() => {});
  await page.waitForTimeout(200);
  await page.mouse.wheel(0, 220).catch(() => {});
  await page.waitForTimeout(250);
  await page.mouse.wheel(0, -220).catch(() => {});
  await page.waitForTimeout(250);
}

async function waitForPotentialResults(page, timeoutMs) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await Promise.race([
    page.waitForFunction(
      () => {
        const text = document.body?.innerText || "";
        return (
          /Unfortunately, bots use DuckDuckGo too/i.test(text) ||
          /Only showing results from/i.test(text) ||
          /No more results found/i.test(text) ||
          document.querySelectorAll("article").length > 0
        );
      },
    ),
    page.waitForTimeout(Math.min(timeoutMs, 10000)),
  ]).catch(() => {});
}

async function readBodyText(page) {
  return page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
}

async function detectDuckDuckGoBlock(page) {
  const finalUrl = page.url();
  const text = await readBodyText(page);
  return {
    blocked: /Unfortunately, bots use DuckDuckGo too|Select all squares containing a duck/i.test(text),
    finalUrl,
    text,
  };
}

const DDG_MAX_CLICKS = 15;

async function extractDuckDuckGoResults(page, limit = 10) {
  return page.evaluate((maxResults) => {
    function normalizeUrl(value) {
      try {
        const url = new URL(value, window.location.href);
        if (!/^https?:/.test(url.protocol)) return null;
        if (url.hostname.includes("duckduckgo.com")) return null;
        return url.toString();
      } catch {
        return null;
      }
    }

    function getText(node) {
      return (node?.innerText || node?.textContent || "").trim();
    }

    const containers = Array.from(document.querySelectorAll("article, .result, .results_links"));
    const seen = new Set();
    const results = [];

    for (const container of containers) {
      const link =
        container.querySelector('a[data-testid="result-title-a"][href]') ||
        container.querySelector("h2 a[href]") ||
        container.querySelector("a[href]");
      const url = normalizeUrl(link?.href);
      const title = getText(link);
      if (!url || !title || seen.has(url)) continue;

      const snippetNode =
        container.querySelector('[data-result="snippet"]') ||
        container.querySelector(".result__snippet") ||
        container.querySelector(".OgdwYG6KE2qthn9XQWFC") ||
        container.querySelector("article div");
      const snippet = getText(snippetNode).slice(0, 400);

      seen.add(url);
      results.push({
        rank: results.length + 1,
        title,
        url,
        snippet,
        source: "duckduckgo",
      });
      if (results.length >= maxResults) break;
    }

    return results;
  }, limit);
}

async function clickMoreResults(page) {
  const moreButton = page.locator('button:has-text("More results"), a:has-text("More results"), button.result--more__btn, [id="more-results"]').first();
  if ((await moreButton.count().catch(() => 0)) === 0) return false;

  if (!(await moreButton.isVisible().catch(() => false))) {
    // Bring it into view by scrolling
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(500);
  }

  const beforeCount = await page.evaluate(
    () => document.querySelectorAll("article, .result, .results_links").length
  ).catch(() => 0);

  await moreButton.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await moreButton.click({ timeout: 3000 }).catch(() => {});

  await page.waitForFunction(
    (prev) => document.querySelectorAll("article, .result, .results_links").length > prev,
    beforeCount,
    { timeout: 8000 }
  ).catch(() => {});
  await page.waitForTimeout(500);

  const afterCount = await page.evaluate(
    () => document.querySelectorAll("article, .result, .results_links").length
  ).catch(() => 0);

  return afterCount > beforeCount;
}

async function paginatedExtract(page, limit) {
  // Click "More results" until we have enough, clicking stops producing new results, or we hit the cap
  for (let click = 0; click < DDG_MAX_CLICKS; click++) {
    const currentResults = await extractDuckDuckGoResults(page, limit);
    if (currentResults.length >= limit) return currentResults;

    const clicked = await clickMoreResults(page);
    if (!clicked) return currentResults;
  }

  return extractDuckDuckGoResults(page, limit);
}

async function directSearch(page, query, options, timeoutMs) {
  await page.goto(buildDuckDuckGoUrl(query, options), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForPotentialResults(page, timeoutMs);

  const blockState = await detectDuckDuckGoBlock(page);
  if (blockState.blocked) {
    return {
      blocked: true,
      warnings: ["DuckDuckGo search presented an anomaly challenge."],
      results: [],
    };
  }

  const results = await paginatedExtract(page, options.limit || 10);
  return {
    blocked: false,
    warnings: results.length === 0 ? ["DuckDuckGo search returned no parseable results."] : [],
    results,
  };
}

async function homepageSearch(page, query, options, timeoutMs) {
  await page.goto("https://duckduckgo.com/", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await simulateLightInteraction(page);

  const input = page.locator('input[name="q"], input[type="text"], textarea').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  await input.click({ timeout: timeoutMs });
  await page.waitForTimeout(150);
  await input.fill("");
  await input.type(mergeSearchQuery(query, options), { delay: 70 });
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForPotentialResults(page, timeoutMs);

  if (options.dateFrom || options.dateTo || options.sort === "recent") {
    await page.goto(buildDuckDuckGoUrl(query, options), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await waitForPotentialResults(page, timeoutMs);
  }

  const blockState = await detectDuckDuckGoBlock(page);
  if (blockState.blocked) {
    return {
      blocked: true,
      warnings: ["DuckDuckGo homepage search presented an anomaly challenge."],
      results: [],
    };
  }

  const results = await paginatedExtract(page, options.limit || 10);
  return {
    blocked: false,
    warnings: results.length === 0 ? ["DuckDuckGo homepage search returned no parseable results."] : [],
    results,
  };
}

export async function searchDuckDuckGo(query, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const timeoutMs = options.timeout || 15000;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await ddgSession.get(manager, timeoutMs);
      let outcome;

      try {
        outcome = await directSearch(session.page, query, options, timeoutMs);
        if (outcome.blocked || outcome.results.length === 0) {
          outcome = await homepageSearch(session.page, query, options, timeoutMs);
        }
      } catch (error) {
        outcome = {
          blocked: true,
          warnings: [error?.message || String(error)],
          results: [],
        };
      }

      ddgSession.touch(manager, session);

      if (!outcome.blocked) {
        return createSearchResponse(
          "duckduckgo",
          query,
          "direct_df_search",
          snapshotDateUtc(),
          outcome.results,
          outcome.warnings,
          false,
          startedAt
        );
      }

      await ddgSession.invalidate(manager);
    }

    return createSearchResponse(
      "duckduckgo",
      query,
      "direct_df_search",
      snapshotDateUtc(),
      [],
      ["DuckDuckGo search was blocked or challenged."],
      true,
      startedAt
    );
  } catch (error) {
    await ddgSession.invalidate(manager);
    return createSearchResponse(
      "duckduckgo",
      query,
      "direct_df_search",
      snapshotDateUtc(),
      [],
      [error?.message || String(error)],
      true,
      startedAt
    );
  }
}
