import assert from "node:assert/strict";
import test from "node:test";

import { createPlatformSearch } from "../src/providers/base/platform-search.js";

// Test fixture: keep only /status/ URLs (mimics X)
const STATUS_RE = /example\.com\/[^/]+\/status\/\d+/;
const statusFilter = (results) => (results || []).filter((r) => STATUS_RE.test(r?.url || ""));

function makeResult(url, rank = 1) {
  return { rank, title: `Title ${url}`, url, snippet: "", source: "mock" };
}

function mockResponse({ results = [], blocked = false, warnings = [] } = {}) {
  return {
    provider: "web",
    query: "test",
    usedStrategy: "serp_site_filter",
    snapshotDate: "2026-04-11",
    results,
    warnings,
    blocked,
    durationMs: 100,
    engine: "mock",
    attemptedEngines: [],
  };
}

function baseConfig(searchWebImpl) {
  return {
    provider: "testprovider",
    site: "example.com",
    defaultEngines: ["mock1", "mock2", "mock3"],
    overRequestMultiplier: 2,
    filter: statusFilter,
    queryTransform: (q) => `${q} inurl:status`,
    emptyWarning: "No post URLs found.",
    searchWeb: searchWebImpl,
  };
}

test("platform-search returns filtered + re-indexed results when first fetch is sufficient", async () => {
  const searchWeb = async () =>
    mockResponse({
      results: [
        makeResult("https://example.com/u/status/1"),
        makeResult("https://example.com/u/status/2"),
        makeResult("https://example.com/u/status/3"),
        makeResult("https://example.com/u/status/4"),
        makeResult("https://example.com/u/status/5"),
      ],
    });

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("test query", { limit: 3 });

  assert.equal(response.provider, "testprovider");
  assert.equal(response.results.length, 3);
  assert.deepEqual(response.results.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(response.results.map((r) => r.url), [
    "https://example.com/u/status/1",
    "https://example.com/u/status/2",
    "https://example.com/u/status/3",
  ]);
});

test("platform-search over-requests using the configured multiplier", async () => {
  let capturedLimit = null;
  const searchWeb = async (_query, options) => {
    capturedLimit = options.limit;
    return mockResponse({
      results: Array.from({ length: options.limit }, (_, i) =>
        makeResult(`https://example.com/u/status/${i + 1}`)
      ),
    });
  };

  const search = createPlatformSearch(baseConfig(searchWeb));
  await search("q", { limit: 10 });

  // With multiplier 2, overRequestLimit(10, 2) = 20
  assert.equal(capturedLimit, 20);
});

test("platform-search retries once when first pass is insufficient", async () => {
  const calls = [];
  const searchWeb = async (_query, options) => {
    calls.push(options.limit);
    if (calls.length === 1) {
      // First call: return mostly non-matching URLs (only 1 of 20 is a status URL)
      return mockResponse({
        results: [
          makeResult("https://example.com/u/status/1"),
          ...Array.from({ length: 19 }, (_, i) => makeResult(`https://example.com/profile${i}`)),
        ],
      });
    }
    // Retry call: return 10 fresh status URLs
    return mockResponse({
      results: Array.from({ length: 10 }, (_, i) => makeResult(`https://example.com/u/status/${i + 100}`)),
    });
  };

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("q", { limit: 5 });

  assert.equal(calls.length, 2, "expected retry to fire");
  assert.equal(calls[0], 10, "first call over-requests to 10");
  assert.equal(calls[1], 20, "retry doubles the multiplier to 20");
  assert.equal(response.results.length, 5);
  assert.deepEqual(response.results.map((r) => r.rank), [1, 2, 3, 4, 5]);
});

test("platform-search does not emit filter-warning (filtering is expected, not noteworthy)", async () => {
  const mixedSearchWeb = async () =>
    mockResponse({
      results: [
        makeResult("https://example.com/u/status/1"),
        makeResult("https://example.com/u/status/2"),
        makeResult("https://example.com/profile"),
        makeResult("https://example.com/about"),
      ],
    });

  const mixedSearch = createPlatformSearch(baseConfig(mixedSearchWeb));
  const mixedResponse = await mixedSearch("q", { limit: 5 });
  assert.ok(
    !mixedResponse.warnings.some((w) => typeof w === "string" && w.startsWith("Filtered")),
    "filter-warning should not be emitted — filtering is expected behavior"
  );
});

test("platform-search attempted-engine entry resultCount reflects the final user-facing count", async () => {
  const searchWeb = async (_query, options) =>
    mockResponse({
      results: Array.from({ length: options.limit }, (_, i) =>
        makeResult(`https://example.com/u/status/${i}`)
      ),
    });

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("q", { limit: 7 });

  assert.equal(response.attemptedEngines.length, 1);
  assert.equal(response.attemptedEngines[0].engine, "mock1");
  assert.equal(
    response.attemptedEngines[0].resultCount,
    7,
    "resultCount should match user-facing length, not over-request"
  );
});

test("platform-search falls through to next engine on empty results", async () => {
  const calls = [];
  const searchWeb = async (_query, options) => {
    calls.push(options.engine);
    if (options.engine === "mock1") return mockResponse({ results: [] });
    if (options.engine === "mock2") return mockResponse({ results: [] });
    return mockResponse({
      results: [makeResult("https://example.com/u/status/1")],
    });
  };

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("q", { limit: 5 });

  // Each engine calls searchWeb twice (first fetch + retry)
  assert.deepEqual(calls, ["mock1", "mock1", "mock2", "mock2", "mock3", "mock3"]);
  assert.equal(response.results.length, 1);
  assert.equal(response.attemptedEngines.length, 3);
});

test("platform-search falls through to next engine on blocked (not just empty)", async () => {
  // This is the core of the fallback fix: blocked on one engine shouldn't stop the loop
  const calls = [];
  const searchWeb = async (_query, options) => {
    calls.push(options.engine);
    if (options.engine === "mock1") return mockResponse({ results: [], blocked: true });
    return mockResponse({
      results: [makeResult("https://example.com/u/status/1")],
    });
  };

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("q", { limit: 5 });

  // mock1 is blocked (no retry since blocked), mock2 succeeds (first fetch only)
  assert.ok(calls.includes("mock2"), "should fall through to mock2 despite mock1 being blocked");
  assert.equal(response.results.length, 1);
});

test("platform-search returns empty response with emptyWarning when all engines fail", async () => {
  const searchWeb = async () => mockResponse({ results: [], blocked: true });

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("q", { limit: 5 });

  assert.equal(response.results.length, 0);
  assert.ok(response.warnings.includes("No post URLs found."));
  assert.equal(response.attemptedEngines.length, 3);
});

test("platform-search explicit engine override short-circuits fallback", async () => {
  const calls = [];
  const searchWeb = async (_query, options) => {
    calls.push(options.engine);
    return mockResponse({ results: [] });
  };

  const search = createPlatformSearch(baseConfig(searchWeb));
  const response = await search("q", { limit: 5, engine: "mock2" });

  // Should only try mock2 (first fetch + retry), not fall back to others
  assert.deepEqual(
    calls.filter((c) => c !== "mock2"),
    []
  );
  assert.equal(response.attemptedEngines.length, 1);
  assert.equal(response.attemptedEngines[0].engine, "mock2");
});

test("platform-search applies queryTransform to the fetched query", async () => {
  let capturedQuery = null;
  const searchWeb = async (query) => {
    capturedQuery = query;
    return mockResponse({
      results: [makeResult("https://example.com/u/status/1")],
    });
  };

  const search = createPlatformSearch(baseConfig(searchWeb));
  await search("hello world", { limit: 1 });

  assert.equal(capturedQuery, "hello world inurl:status");
});
