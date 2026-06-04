import assert from "node:assert/strict";
import test from "node:test";

import { buildGoogleResultsFromBlocks } from "../src/providers/google/search.js";

test("buildGoogleResultsFromBlocks drops ad blocks and Google internal links", () => {
  const results = buildGoogleResultsFromBlocks([
    {
      title: "Get Best VPN Now - NordVPN",
      url: "https://nordvpn.com/offer/special-exclusive/",
      snippet: "VPN ad copy",
      text: "Get Best VPN Now - NordVPN NordVPN https://www.nordvpn.com My Ad Centre",
    },
    {
      title: "Example Domain",
      url: "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F&sa=U&ved=0",
      snippet: "This domain is for use in documentation examples.",
      text: "Example Domain https://example.com This domain is for use in documentation examples.",
    },
    {
      title: "Page 2",
      url: "https://www.google.com/search?q=example&start=10",
      snippet: "",
      text: "Page navigation",
    },
  ], 10);

  assert.deepEqual(results, [
    {
      rank: 1,
      title: "Example Domain",
      url: "https://example.com/",
      snippet: "This domain is for use in documentation examples.",
      source: "google",
    },
  ]);
});

test("buildGoogleResultsFromBlocks de-duplicates normalized redirect URLs", () => {
  const results = buildGoogleResultsFromBlocks([
    {
      title: "Example Domain",
      url: "https://www.google.com/url?q=https%3A%2F%2Fexample.com%2F&sa=U&ved=0",
      snippet: "First",
      text: "Example Domain",
    },
    {
      title: "Example Domain",
      url: "https://example.com/",
      snippet: "Second",
      text: "Example Domain",
    },
  ], 10);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://example.com/");
});
