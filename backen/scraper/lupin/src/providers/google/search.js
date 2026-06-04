import { BrowserManager } from "../../runtime/browser-manager.js";
import { createSearchResponse } from "../base/result-shapes.js";
import { mergeSearchQuery, randomDelay, snapshotDateUtc } from "../base/fallbacks.js";
import { createSearchSessionCache } from "../base/session-cache.js";

const googleSession = createSearchSessionCache(10 * 60 * 1000);

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function formatGoogleDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-");
  if (!year || !month || !day) return null;
  return `${month}/${day}/${year}`;
}

function buildGoogleSearchQuery(query, options = {}) {
  return mergeSearchQuery(query, options);
}

function buildGoogleTbs(options = {}) {
  const dateFrom = formatGoogleDate(options.dateFrom);
  const dateTo = formatGoogleDate(options.dateTo);

  if (dateFrom || dateTo) {
    const min = dateFrom || "01/01/1970";
    const max = dateTo || formatGoogleDate(new Date().toISOString().slice(0, 10));
    return `cdr:1,cd_min:${min},cd_max:${max}`;
  }

  if (options.sort === "recent") {
    return "qdr:m";
  }

  return null;
}

function normalizeGoogleResultUrl(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url, "https://www.google.com");
    if (parsed.hostname.includes("google.") && parsed.pathname === "/url" && parsed.searchParams.get("q")) {
      return parsed.searchParams.get("q");
    }
    if (parsed.hostname.includes("google.")) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

const GOOGLE_PAGE_SIZE = 100;
const GOOGLE_MAX_PAGES = 3;

export function buildGoogleResultsFromBlocks(items, limit = 10) {
  const maxResults = Math.max(limit || 10, 1);
  const seen = new Set();
  const results = [];

  for (const candidate of items || []) {
    const normalizedUrl = normalizeGoogleResultUrl(candidate?.url);
    const title = String(candidate?.title || "").trim();
    const blockText = String(candidate?.text || "");

    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    if (title.length < 3) continue;
    if (/my ad centre|find relevant offers from advertisers/i.test(blockText)) continue;

    seen.add(normalizedUrl);
    results.push({
      rank: results.length + 1,
      title,
      url: normalizedUrl,
      snippet: String(candidate?.snippet || "").slice(0, 400),
      source: "google",
    });
    if (results.length >= maxResults) break;
  }

  return results;
}

async function extractGoogleResults(page, limit) {
  const rawResults = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".MjjYud, div.g"))
      .map((container) => {
        const heading = container.querySelector("h3");
        if (!heading) return null;

        const link =
          heading.closest("a[href]") ||
          Array.from(container.querySelectorAll("a[href]")).find((anchor) => anchor.querySelector("h3"));
        if (!link) return null;

        const blockText = (container.innerText || container.textContent || "").trim();
        const lines = blockText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const title = (heading.innerText || heading.textContent || "").trim();
        const titleIndex = lines.findIndex((line) => line === title);
        const trailingLines = titleIndex >= 0 ? lines.slice(titleIndex + 1) : lines;
        const snippet = trailingLines
          .filter((line) => {
            if (!line) return false;
            if (/^[a-z0-9.-]+\.[a-z]{2,}\b/i.test(line) && /[›>]/.test(line)) return false;
            if (/^https?:\/\//i.test(line)) return false;
            if (/^[0-9.,\s€$£¥-]+(?:free|delivery|returns|android|ios|security)?/i.test(line)) return false;
            return true;
          })
          .join(" ")
          .trim();

        return {
          title,
          url: link.href,
          snippet,
          text: blockText,
        };
      })
      .filter(Boolean)
  );

  return buildGoogleResultsFromBlocks(rawResults, limit);
}

async function readPageText(page) {
  return page.evaluate(() => document.body?.innerText || document.body?.textContent || "").catch(() => "");
}

async function detectGoogleBlock(page) {
  const finalUrl = page.url();
  const pageText = await readPageText(page);
  return {
    blocked: finalUrl.includes("/sorry/") || /unusual traffic|about this page|sorry/i.test(pageText),
    finalUrl,
    pageText,
  };
}

async function acceptConsentIfPresent(page) {
  const selectors = [
    'button:has-text("Accept all")',
    'button:has-text("I agree")',
    'button:has-text("Accept")',
    'button:has-text("Tout accepter")',
    "button:has-text(\"J'accepte\")",
    "#L2AGLb",
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) < 1) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click({ timeout: 2000 }).catch(() => {});
    await locator.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(randomDelay(150, 300));
    return true;
  }

  return false;
}

async function simulateLightInteraction(page) {
  await page.mouse.move(150, 180, { steps: 12 }).catch(() => {});
  await page.waitForTimeout(randomDelay(100, 180));
  await page.mouse.move(420, 240, { steps: 16 }).catch(() => {});
  await page.waitForTimeout(randomDelay(100, 180));
  await page.mouse.wheel(0, 250).catch(() => {});
  await page.waitForTimeout(randomDelay(120, 200));
  await page.mouse.wheel(0, -250).catch(() => {});
  await page.waitForTimeout(randomDelay(120, 200));
}

async function gotoGoogleHomepage(page, timeoutMs) {
  await page.goto("https://www.google.com/ncr", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(randomDelay(400, 500));
  await acceptConsentIfPresent(page);
}

async function waitForSearchResults(page, timeoutMs) {
  await Promise.race([
    page.waitForFunction(
      () => document.querySelectorAll("a h3").length >= 3,
    ),
    page.waitForTimeout(Math.min(timeoutMs, 10000)),
  ]).catch(() => {});
}

async function submitSearchFromHomepage(page, query, timeoutMs) {
  const input = page.locator('textarea[name="q"], input[name="q"]').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  await input.click({ timeout: timeoutMs });
  await page.waitForTimeout(randomDelay(200, 300));
  await input.fill("");
  await page.waitForTimeout(randomDelay(100, 200));
  for (const char of query) {
    await page.keyboard.type(char, { delay: 0 });
    await page.waitForTimeout(randomDelay(68, 98));
  }
  await page.waitForTimeout(randomDelay(300, 500));
  await page.keyboard.press("Enter");
  await waitForSearchResults(page, timeoutMs);
}

async function applySearchFilters(page, options, limit, timeoutMs) {
  const currentUrl = new URL(page.url());
  currentUrl.searchParams.set("num", String(limit));
  currentUrl.searchParams.set("hl", "en");
  currentUrl.searchParams.set("gl", "us");

  const tbs = buildGoogleTbs(options);
  if (tbs) {
    currentUrl.searchParams.set("tbs", tbs);
  } else {
    currentUrl.searchParams.delete("tbs");
  }

  await page.goto(currentUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForSearchResults(page, timeoutMs);
}

async function navigateToGooglePage(page, startOffset, timeoutMs) {
  const currentUrl = new URL(page.url());
  currentUrl.searchParams.set("start", String(startOffset));
  await page.goto(currentUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForSearchResults(page, timeoutMs);
}

async function executeGoogleSearchFlow(page, query, options, timeoutMs) {
  const limit = Math.max(options.limit || 10, 1);
  const pageSize = Math.min(limit, GOOGLE_PAGE_SIZE);
  await gotoGoogleHomepage(page, timeoutMs);
  await simulateLightInteraction(page);
  await submitSearchFromHomepage(page, buildGoogleSearchQuery(query, options), timeoutMs);

  let blockState = await detectGoogleBlock(page);
  if (blockState.blocked) {
    return {
      blocked: true,
      warnings: ["Google search was blocked by an anti-bot interstitial."],
      results: [],
    };
  }

  // Apply filters and set num= for first page
  await applySearchFilters(page, options, pageSize, timeoutMs);
  blockState = await detectGoogleBlock(page);
  if (blockState.blocked) {
    return {
      blocked: true,
      warnings: ["Google search was blocked while applying date/recent filters."],
      results: [],
    };
  }

  const allResults = await extractGoogleResults(page, pageSize);

  // Paginate if we need more
  const maxPages = Math.min(Math.ceil(limit / pageSize), GOOGLE_MAX_PAGES);
  for (let pageNum = 1; pageNum < maxPages && allResults.length < limit; pageNum++) {
    const startOffset = pageNum * pageSize;
    await navigateToGooglePage(page, startOffset, timeoutMs);

    blockState = await detectGoogleBlock(page);
    if (blockState.blocked) break;

    const pageResults = await extractGoogleResults(page, pageSize);
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
    warnings: allResults.length === 0 ? ["Google search returned no parseable results."] : [],
    results: allResults.slice(0, limit),
  };
}


export async function searchGoogle(query, options = {}, manager = new BrowserManager()) {
  const startedAt = Date.now();
  const timeoutMs = options.timeout || 10000;
  const attemptTimeout = timeoutMs + 5000;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let timedOut = false;
      try {
        const outcome = await withTimeout(
          (async () => {
            const session = await googleSession.get(manager, timeoutMs);
            const result = await executeGoogleSearchFlow(session.page, query, options, timeoutMs);
            googleSession.touch(manager, session);
            return result;
          })(),
          attemptTimeout,
          "Google search"
        );

        if (!outcome.blocked) {
          return createSearchResponse(
            "google",
            query,
            "homepage_search",
            snapshotDateUtc(),
            outcome.results,
            outcome.warnings,
            false,
            startedAt
          );
        }

        // Blocked by anti-bot — retry with fresh session
        await googleSession.invalidate(manager);
      } catch (attemptError) {
        await googleSession.invalidate(manager);
        timedOut = /timed out/i.test(attemptError?.message);
      }

      // Don't retry on timeout — second attempt will almost certainly time out too
      if (timedOut) break;
    }

    return createSearchResponse(
      "google",
      query,
      "homepage_search",
      snapshotDateUtc(),
      [],
      ["Google search was blocked or timed out."],
      true,
      startedAt
    );
  } catch (error) {
    await googleSession.invalidate(manager);
    return createSearchResponse(
      "google",
      query,
      "homepage_search",
      snapshotDateUtc(),
      [],
      [error?.message || String(error)],
      true,
      startedAt
    );
  }
}
