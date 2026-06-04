import fs from "node:fs/promises";
import path from "node:path";

import { BrowserManager } from "../src/runtime/browser-manager.js";
import { mergeSearchQuery } from "../src/providers/base/fallbacks.js";

const queryFile = path.resolve(process.cwd(), "benchmarks", "duckduckgo-queries.json");
const outputFile = path.resolve(process.cwd(), "benchmarks", "duckduckgo-results.json");

const METHOD_HANDLERS = {
  direct_df: runDirectDfSearch,
  homepage_df: runHomepageDfSearch,
  homepage_operators: runHomepageOperatorsSearch,
};

const args = process.argv.slice(2);
const methods = [];
let timeoutMs = 30000;
let browserEngine = "camoufox";

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--method" && args[index + 1]) {
    methods.push(args[index + 1]);
    index += 1;
    continue;
  }
  if (args[index] === "--engine" && args[index + 1]) {
    browserEngine = args[index + 1];
    index += 1;
    continue;
  }
  if (args[index] === "--timeout" && args[index + 1]) {
    timeoutMs = Number(args[index + 1]) || timeoutMs;
    index += 1;
  }
}

const selectedMethods = methods.length > 0 ? methods : Object.keys(METHOD_HANDLERS);

for (const method of selectedMethods) {
  if (!METHOD_HANDLERS[method]) {
    throw new Error(`Unsupported method: ${method}`);
  }
}

function buildOperatorQuery(query, options = {}) {
  const parts = [mergeSearchQuery(query, options)];
  if (options.dateFrom) parts.push(`after:${options.dateFrom}`);
  if (options.dateTo) parts.push(`before:${options.dateTo}`);
  return parts.filter(Boolean).join(" ").trim();
}

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

async function waitForPotentialResults(page, timeoutMs) {
  await page.waitForTimeout(1500);
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => {});
  await page.waitForFunction(() => {
    const text = document.body?.innerText || "";
    return (
      /Unfortunately, bots use DuckDuckGo too/i.test(text) ||
      /Only showing results from/i.test(text) ||
      /No more results found/i.test(text) ||
      document.querySelectorAll("article").length > 0
    );
  }, { timeout: Math.min(timeoutMs, 15000) }).catch(() => {});
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

async function extractDuckDuckGoResults(page, limit = 5) {
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

async function inspectOutcome(page, querySpec, methodName) {
  const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const blocked = /Unfortunately, bots use DuckDuckGo too|Select all squares containing a duck/i.test(text);
  const results = blocked ? [] : await extractDuckDuckGoResults(page, 5).catch(() => []);
  const expectedHostPatterns = inferExpectedHostPatterns(querySpec);
  const matchingResults = results.filter((result) => urlMatchesExpectedHost(result.url, expectedHostPatterns));
  const pass =
    !blocked &&
    results.length > 0 &&
    (expectedHostPatterns.length === 0 || matchingResults.length > 0);

  return {
    method: methodName,
    finalUrl: page.url(),
    blocked,
    resultCount: results.length,
    expectedHostPatterns,
    matchingResultCount: matchingResults.length,
    topResultMatchesExpectedHost: results[0] ? urlMatchesExpectedHost(results[0].url, expectedHostPatterns) : false,
    pass,
    visibleDateFilter: /[A-Z][a-z]{2} \d{1,2} - [A-Z][a-z]{2} \d{1,2}/.test(text),
    visibleSiteFilter: /Only showing results from/i.test(text),
    warnings: buildWarnings(querySpec, methodName, text, results, matchingResults),
    topResults: results.slice(0, 3),
  };
}

function buildWarnings(querySpec, methodName, text, results, matchingResults) {
  const warnings = [];

  if (/Unfortunately, bots use DuckDuckGo too/i.test(text)) {
    warnings.push("DuckDuckGo presented an anomaly challenge.");
  }
  if (results.length === 0 && !/Unfortunately, bots use DuckDuckGo too/i.test(text)) {
    warnings.push("No parseable search results were found.");
  }
  if ((querySpec.dateFrom || querySpec.dateTo) && methodName !== "homepage_operators" && !/[A-Z][a-z]{2} \d{1,2} - [A-Z][a-z]{2} \d{1,2}/.test(text)) {
    warnings.push("Custom date range was not visibly confirmed in the UI.");
  }
  if (querySpec.site && methodName !== "homepage_operators" && !/Only showing results from/i.test(text)) {
    warnings.push("Site restriction was not visibly confirmed in the UI.");
  }
  if (querySpec.site && results.length > 0 && matchingResults.length === 0) {
    warnings.push("Results were returned, but none matched the requested site.");
  }

  return warnings;
}

function inferExpectedHostPatterns(querySpec) {
  const patterns = new Set();
  if (querySpec.site) patterns.add(querySpec.site.replace(/^www\./, ""));
  for (const domain of querySpec.includeDomains || []) {
    patterns.add(domain.replace(/^www\./, ""));
  }
  return Array.from(patterns);
}

function urlMatchesExpectedHost(url, expectedHostPatterns) {
  if (expectedHostPatterns.length === 0) return true;
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return expectedHostPatterns.some((pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`));
  } catch {
    return false;
  }
}

async function runDirectDfSearch(page, querySpec, timeoutMs) {
  await page.goto(buildDuckDuckGoUrl(querySpec.query, querySpec), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await waitForPotentialResults(page, timeoutMs);
}

async function runHomepageDfSearch(page, querySpec, timeoutMs) {
  await page.goto("https://duckduckgo.com/", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(1000);
  await simulateLightInteraction(page);

  const input = page.locator('input[name="q"], input[type="text"], textarea').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  await input.click({ timeout: timeoutMs });
  await page.waitForTimeout(150);
  await input.fill("");
  await input.type(mergeSearchQuery(querySpec.query, querySpec), { delay: 70 });
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForPotentialResults(page, timeoutMs);

  if (querySpec.dateFrom || querySpec.dateTo || querySpec.sort === "recent") {
    await page.goto(buildDuckDuckGoUrl(querySpec.query, querySpec), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await waitForPotentialResults(page, timeoutMs);
  }
}

async function runHomepageOperatorsSearch(page, querySpec, timeoutMs) {
  await page.goto("https://duckduckgo.com/", {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  await page.waitForTimeout(1000);
  await simulateLightInteraction(page);

  const input = page.locator('input[name="q"], input[type="text"], textarea').first();
  await input.waitFor({ state: "visible", timeout: timeoutMs });
  await input.click({ timeout: timeoutMs });
  await page.waitForTimeout(150);
  await input.fill("");
  await input.type(buildOperatorQuery(querySpec.query, querySpec), { delay: 70 });
  await page.waitForTimeout(250);
  await page.keyboard.press("Enter");
  await waitForPotentialResults(page, timeoutMs);
}

const queries = JSON.parse(await fs.readFile(queryFile, "utf8"));
const manager = new BrowserManager({
  fallbackHeadless: true,
});

const startedAt = new Date().toISOString();
const runs = [];

try {
  for (const method of selectedMethods) {
    for (const querySpec of queries) {
      const session = await manager.openSession({
        engine: browserEngine,
        timeout: timeoutMs,
      });
      const started = Date.now();

      try {
        await METHOD_HANDLERS[method](session.page, querySpec, timeoutMs);
        const outcome = await inspectOutcome(session.page, querySpec, method);
        runs.push({
          ...querySpec,
          browserEngine,
          method,
          durationMs: Date.now() - started,
          ...outcome,
        });
      } catch (error) {
        runs.push({
          ...querySpec,
          browserEngine,
          method,
          durationMs: Date.now() - started,
          finalUrl: session.page.url(),
          blocked: true,
          resultCount: 0,
          expectedHostPatterns: inferExpectedHostPatterns(querySpec),
          matchingResultCount: 0,
          topResultMatchesExpectedHost: false,
          pass: false,
          visibleDateFilter: false,
          visibleSiteFilter: false,
          warnings: [error?.message || String(error)],
          topResults: [],
        });
      } finally {
        await session.close().catch(() => {});
      }
    }
  }
} finally {
  await manager.close().catch(() => {});
}

const byMethod = Object.fromEntries(
  selectedMethods.map((method) => {
    const methodRuns = runs.filter((run) => run.method === method);
    return [
      method,
      {
        requests: methodRuns.length,
        passes: methodRuns.filter((run) => run.pass).length,
        blocked: methodRuns.filter((run) => run.blocked).length,
        withResults: methodRuns.filter((run) => run.resultCount > 0).length,
        siteMatched: methodRuns.filter((run) => run.expectedHostPatterns.length === 0 || run.matchingResultCount > 0).length,
        topSiteMatched: methodRuns.filter((run) => run.expectedHostPatterns.length === 0 || run.topResultMatchesExpectedHost).length,
        visibleDateFilter: methodRuns.filter((run) => run.visibleDateFilter).length,
        visibleSiteFilter: methodRuns.filter((run) => run.visibleSiteFilter).length,
      },
    ];
  })
);

const report = {
  startedAt,
  browserEngine,
  methods: selectedMethods,
  timeoutMs,
  byMethod,
  runs,
};

await fs.writeFile(outputFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
