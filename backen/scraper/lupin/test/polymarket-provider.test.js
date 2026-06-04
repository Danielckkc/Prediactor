import assert from "node:assert/strict";
import test from "node:test";

import { fetchPolymarketMarket } from "../src/providers/polymarket/fetch.js";
import { searchPolymarket } from "../src/providers/polymarket/search.js";

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("search_polymarket uses event creation time for publishedAt and preserves market deadline in metadata", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/public-search\?/);
    return jsonResponse({
      events: [
        {
          id: "evt-1",
          slug: "sample-event",
          title: "Sample event",
          description: "Sample description",
          creationDate: "2026-01-11T20:43:43.866895Z",
          createdAt: "2026-01-11T20:39:15.484071Z",
          updatedAt: "2026-03-31T10:45:09.081576Z",
          active: true,
          closed: false,
          volume: 12345.67,
          liquidity: 890.12,
          commentCount: 42,
          markets: [
            {
              question: "Closed market",
              lastTradePrice: 0.001,
              active: true,
              closed: true,
            },
            {
              question: "Open market",
              lastTradePrice: 0.019,
              active: true,
              closed: false,
              endDate: "2026-03-31T00:00:00Z",
            },
          ],
        },
      ],
    });
  };

  const result = await searchPolymarket("sample query", { limit: 5 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].publishedAt, "2026-01-11T20:43:43.866895Z");
  assert.equal(result.results[0].metadata.topMarketQuestion, "Open market");
  assert.equal(result.results[0].metadata.topMarketPrice, 0.019);
  assert.equal(result.results[0].metadata.primaryMarketEndDate, "2026-03-31T00:00:00Z");
});

test("fetch_polymarket_market uses event creation time for publishedAt and exposes primary market end date", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/events/slug/sample-event")) {
      return jsonResponse({
        id: "evt-1",
        slug: "sample-event",
        title: "Sample event",
        description: "Sample description",
        creationDate: "2026-01-11T20:43:43.866895Z",
        createdAt: "2026-01-11T20:39:15.484071Z",
        updatedAt: "2026-03-31T10:45:09.081576Z",
        active: true,
        closed: false,
        liquidity: 890.12,
        volume: 12345.67,
        openInterest: 456.78,
        volume24hr: 12.34,
        commentCount: 1,
        markets: [
          {
            id: "mkt-1",
            slug: "closed-market",
            question: "Closed market",
            outcomes: "[\"Yes\",\"No\"]",
            outcomePrices: "[\"0.001\",\"0.999\"]",
            active: true,
            closed: true,
            acceptingOrders: false,
            lastTradePrice: 0.001,
          },
          {
            id: "mkt-2",
            slug: "open-market",
            question: "Open market",
            outcomes: "[\"Yes\",\"No\"]",
            outcomePrices: "[\"0.019\",\"0.981\"]",
            active: true,
            closed: false,
            acceptingOrders: true,
            lastTradePrice: 0.019,
            endDate: "2026-03-31T00:00:00Z",
          },
        ],
      });
    }

    if (value.includes("/comments?")) {
      return jsonResponse([
        {
          id: "comment-1",
          body: "Interesting market",
          createdAt: "2026-03-30T12:00:00Z",
          reactionCount: 3,
          profile: { name: "Alice" },
        },
      ]);
    }

    throw new Error(`Unexpected fetch URL in test: ${value}`);
  };

  const result = await fetchPolymarketMarket(null, "https://polymarket.com/event/sample-event", {
    format: "json",
    maxComments: 1,
  });

  assert.equal(result.content.publishedAt, "2026-01-11T20:43:43.866895Z");
  assert.equal(result.content.platform.createdAt, "2026-01-11T20:43:43.866895Z");
  assert.equal(result.content.platform.primaryMarketQuestion, "Open market");
  assert.equal(result.content.platform.primaryMarketPrice, 0.019);
  assert.equal(result.content.platform.primaryMarketEndDate, "2026-03-31T00:00:00Z");
  assert.equal(result.content.comments[0].publishedAt, "2026-03-30T12:00:00Z");
});
