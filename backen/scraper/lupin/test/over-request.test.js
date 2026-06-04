import assert from "node:assert/strict";
import test from "node:test";

import { overRequestLimit, retryLimit, mergeAndReindex } from "../src/providers/base/over-request.js";

test("overRequestLimit multiplies and rounds up", () => {
  assert.equal(overRequestLimit(10, 1.5), 15);
  assert.equal(overRequestLimit(10, 2), 20);
  assert.equal(overRequestLimit(10, 7), 70);
  assert.equal(overRequestLimit(15, 2.5), 38);
});

test("overRequestLimit respects the cap", () => {
  assert.equal(overRequestLimit(50, 7, 200), 200);
  assert.equal(overRequestLimit(100, 3, 200), 200);
});

test("overRequestLimit never returns less than the target", () => {
  assert.equal(overRequestLimit(10, 0.5), 10);
  assert.equal(overRequestLimit(20, 1), 20);
});

test("overRequestLimit defaults targetLimit to 10 when missing", () => {
  assert.equal(overRequestLimit(0, 2), 20);
  assert.equal(overRequestLimit(undefined, 2), 20);
});

test("retryLimit doubles the multiplier", () => {
  assert.equal(retryLimit(10, 1.5), 30);
  assert.equal(retryLimit(10, 2), 40);
});

test("retryLimit respects the cap", () => {
  assert.equal(retryLimit(50, 7, 200), 200);
});

test("mergeAndReindex deduplicates by URL, preserves primary order, and re-ranks", () => {
  const primary = [
    { rank: 1, url: "https://x.com/a/status/1", title: "A" },
    { rank: 2, url: "https://x.com/b/status/2", title: "B" },
  ];
  const secondary = [
    { rank: 1, url: "https://x.com/b/status/2", title: "B dup" },
    { rank: 2, url: "https://x.com/c/status/3", title: "C" },
    { rank: 3, url: "https://x.com/d/status/4", title: "D" },
  ];

  const merged = mergeAndReindex(primary, secondary, 10);
  assert.deepEqual(merged.map((r) => ({ rank: r.rank, url: r.url, title: r.title })), [
    { rank: 1, url: "https://x.com/a/status/1", title: "A" },
    { rank: 2, url: "https://x.com/b/status/2", title: "B" },
    { rank: 3, url: "https://x.com/c/status/3", title: "C" },
    { rank: 4, url: "https://x.com/d/status/4", title: "D" },
  ]);
});

test("mergeAndReindex stops appending once limit is reached", () => {
  const primary = [
    { rank: 1, url: "https://example.com/1" },
    { rank: 2, url: "https://example.com/2" },
  ];
  const secondary = [
    { rank: 1, url: "https://example.com/3" },
    { rank: 2, url: "https://example.com/4" },
    { rank: 3, url: "https://example.com/5" },
  ];

  const merged = mergeAndReindex(primary, secondary, 3);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((r) => r.url), [
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/3",
  ]);
});
