import assert from "node:assert/strict";
import test from "node:test";

import { parseToolText, withLiveMcpClient } from "../test-support/live-mcp.js";

test("live API-backed providers work through MCP", { timeout: 180000 }, async (t) => {
  await withLiveMcpClient(
    t,
    { clientName: "lupin-live-api", statePrefix: "lupin-live-api-" },
    async (client) => {
      const searchPolymarketResult = parseToolText(
        await client.callTool({
          name: "search_polymarket",
          arguments: {
            query: "fed decision",
            limit: 5,
          },
        })
      );

      assert.equal(searchPolymarketResult.provider, "polymarket");
      assert.ok(Array.isArray(searchPolymarketResult.results));
      assert.ok(searchPolymarketResult.results.length > 0);
      assert.ok(searchPolymarketResult.results.some((result) => /polymarket\.com\/event\//.test(result.url)));
      for (const result of searchPolymarketResult.results) {
        if (!result.publishedAt) continue;
        const snapshotCutoff = new Date(`${searchPolymarketResult.snapshotDate}T23:59:59.999Z`);
        assert.ok(new Date(result.publishedAt) <= snapshotCutoff, "Polymarket publishedAt should not be a future deadline");
      }

      const fetchPolymarketResult = parseToolText(
        await client.callTool({
          name: "fetch_polymarket_market",
          arguments: {
            url: "https://polymarket.com/event/bitboy-convicted",
            format: "json",
            maxComments: 2,
          },
        })
      );

      assert.equal(fetchPolymarketResult.provider, "polymarket");
      assert.equal(fetchPolymarketResult.format, "json");
      assert.equal(fetchPolymarketResult.blocked, false);
      assert.match(fetchPolymarketResult.content.title, /BitBoy convicted/i);
      assert.ok(Array.isArray(fetchPolymarketResult.content.platform.markets));
      assert.ok(fetchPolymarketResult.content.platform.markets.length >= 1);
      assert.ok(Array.isArray(fetchPolymarketResult.content.comments));
      if (fetchPolymarketResult.content.publishedAt) {
        const snapshotCutoff = new Date(`${fetchPolymarketResult.snapshotDate}T23:59:59.999Z`);
        assert.ok(new Date(fetchPolymarketResult.content.publishedAt) <= snapshotCutoff);
      }
      if (fetchPolymarketResult.content.publishedAt && fetchPolymarketResult.content.platform.primaryMarketEndDate) {
        assert.ok(
          new Date(fetchPolymarketResult.content.publishedAt) <= new Date(fetchPolymarketResult.content.platform.primaryMarketEndDate)
        );
      }

      const searchRedditResult = parseToolText(
        await client.callTool({
          name: "search_reddit",
          arguments: {
            query: "ux design portfolio",
            limit: 5,
            sort: "recent",
          },
        })
      );

      assert.equal(searchRedditResult.provider, "reddit");
      assert.ok(Array.isArray(searchRedditResult.results));
      if (searchRedditResult.results.length === 0) {
        assert.ok(searchRedditResult.warnings.length > 0);
      }
      const redditResult = searchRedditResult.results.find((result) => /reddit\.com\/r\//.test(result.url));
      const redditUrl =
        redditResult?.url ||
        "https://www.reddit.com/r/UXDesign/comments/wueslp/what_are_some_great_examples_of_mid_and/";

      const fetchRedditResult = parseToolText(
        await client.callTool({
          name: "fetch_reddit_post",
          arguments: {
            url: redditUrl,
            format: "json",
            maxComments: 3,
          },
        })
      );

      assert.equal(fetchRedditResult.provider, "reddit");
      assert.equal(fetchRedditResult.format, "json");
      assert.equal(fetchRedditResult.blocked, false);
      assert.ok(fetchRedditResult.content.title);
      if (fetchRedditResult.extraction?.method === "reddit_rendered_page_fallback") {
        assert.ok(fetchRedditResult.warnings.some((warning) => /rendered page extraction/i.test(warning)));
      } else {
        assert.ok(fetchRedditResult.content.author.handle?.startsWith("u/"));
      }
      assert.ok(Array.isArray(fetchRedditResult.content.comments));

      const searchHnResult = parseToolText(
        await client.callTool({
          name: "search_hn",
          arguments: {
            query: "karpathy",
            limit: 3,
            sort: "relevance",
          },
        })
      );

      assert.equal(searchHnResult.provider, "hn");
      assert.ok(Array.isArray(searchHnResult.results));
      assert.ok(searchHnResult.results.length > 0);
      const hnResult = searchHnResult.results.find((result) => /news\.ycombinator\.com\/item\?id=/.test(result.url));
      assert.ok(hnResult, "Expected at least one HN item URL");

      const fetchHnResult = parseToolText(
        await client.callTool({
          name: "fetch_hn_item",
          arguments: {
            url: hnResult.url,
            format: "json",
            maxComments: 3,
          },
        })
      );

      assert.equal(fetchHnResult.provider, "hn");
      assert.equal(fetchHnResult.format, "json");
      assert.equal(fetchHnResult.blocked, false);
      assert.ok(fetchHnResult.content.title);
      assert.ok(Array.isArray(fetchHnResult.content.comments));
    }
  );
});
