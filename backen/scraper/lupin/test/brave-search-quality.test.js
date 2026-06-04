import assert from "node:assert/strict";
import test from "node:test";

import { buildBraveResultsFromContainers } from "../src/providers/brave/search.js";

test("buildBraveResultsFromContainers keeps organic results and drops sponsored/internal Brave links", () => {
  const results = buildBraveResultsFromContainers([
    {
      title: "Nordvpn nordvpn.com Sponsored",
      url: "https://search.brave.com/a/redirect?click_url=https%3A%2F%2Fnordvpn.com%2F",
      snippet: "Sponsored VPN ad",
      text: "Nordvpn nordvpn.com Sponsored VPN ad",
      parentId: "search-ad",
    },
    {
      title: "Find elsewhere",
      url: "https://search.brave.com/search?q=example+!g",
      snippet: "Google",
      text: "Find elsewhere Google Bing Mojeek",
      parentId: "",
    },
    {
      title: "Example Domain",
      url: "https://www.example.com/",
      snippet: "This domain is for use in documentation examples.",
      text: "Example Domain example.com This domain is for use in documentation examples.",
      parentId: "",
    },
    {
      title: "Example Domain",
      url: "https://www.example.com/",
      snippet: "Duplicate result",
      text: "Example Domain duplicate",
      parentId: "",
    },
  ], 10);

  assert.deepEqual(results, [
    {
      rank: 1,
      title: "Example Domain",
      url: "https://www.example.com/",
      snippet: "This domain is for use in documentation examples.",
      source: "brave",
    },
  ]);
});

test("buildBraveResultsFromContainers filters sponsored organic-looking blocks by text", () => {
  const results = buildBraveResultsFromContainers([
    {
      title: "Organic Looking Ad",
      url: "https://ads.example.com/",
      snippet: "Looks like a result",
      text: "Organic Looking Ad example.com Sponsored Looks like a result",
      parentId: "",
    },
    {
      title: "Real Result",
      url: "https://docs.example.com/article",
      snippet: "Helpful content",
      text: "Real Result docs.example.com Helpful content",
      parentId: "",
    },
  ], 10);

  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://docs.example.com/article");
});
