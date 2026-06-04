import assert from "node:assert/strict";
import test from "node:test";

import {
  listBenchmarkSearchWebEngines,
  listSearchWebEngines,
  looksLikeSearchChromeResult,
  resultMatchesSite,
  resolveSearchWebEngineOrder,
  sanitizeSearchResponse,
} from "../src/providers/web/search-engines.js";

test("search_web exposes at least one engine", () => {
  const engines = listSearchWebEngines();
  assert.ok(Array.isArray(engines));
  assert.ok(engines.includes("google"));
  assert.ok(engines.includes("duckduckgo"));
  assert.ok(engines.includes("brave"));
});

test("search_web engine override takes precedence", () => {
  assert.deepEqual(resolveSearchWebEngineOrder({ engine: "google" }), ["google"]);
});

test("search_web uses the configured default engine order", () => {
  assert.deepEqual(resolveSearchWebEngineOrder({}), ["duckduckgo", "google", "brave"]);
});

test("benchmark engine list includes expanded candidates", () => {
  assert.deepEqual(listBenchmarkSearchWebEngines(), ["duckduckgo", "google", "brave"]);
});

test("search_web rejects unsupported engines", () => {
  assert.throws(
    () => resolveSearchWebEngineOrder({ preferredEngines: ["nope"] }),
    /Unsupported search engine/
  );
});

test("resultMatchesSite accepts exact hosts and subdomains", () => {
  assert.equal(resultMatchesSite("https://example.com/post", "example.com"), true);
  assert.equal(resultMatchesSite("https://docs.example.com/post", "example.com"), true);
  assert.equal(resultMatchesSite("https://notexample.com/post", "example.com"), false);
});

test("looksLikeSearchChromeResult filters obvious navigation junk", () => {
  assert.equal(looksLikeSearchChromeResult({ title: "Advertise", snippet: "" }), true);
  assert.equal(looksLikeSearchChromeResult({ title: "API", snippet: "" }), true);
  assert.equal(looksLikeSearchChromeResult({ title: "Example Domain", snippet: "Useful page" }), false);
});

test("sanitizeSearchResponse drops off-site and junk results", () => {
  const response = sanitizeSearchResponse(
    {
      provider: "web",
      results: [
        { title: "Advertise", url: "https://ads.brave.com/register/search", snippet: "" },
        { title: "Example Domain", url: "https://example.com/", snippet: "Useful result" },
        { title: "Elsewhere", url: "https://other.com/", snippet: "Wrong site" },
      ],
      warnings: [],
    },
    { site: "example.com" }
  );

  assert.deepEqual(response.results, [
    { rank: 1, title: "Example Domain", url: "https://example.com/", snippet: "Useful result" },
  ]);
  assert.ok(response.warnings.length > 0);
});
