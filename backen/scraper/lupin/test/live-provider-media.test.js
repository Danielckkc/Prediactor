import assert from "node:assert/strict";
import test from "node:test";

import { parseToolText, withLiveMcpClient } from "../test-support/live-mcp.js";

test("live media providers work through MCP", { timeout: 180000 }, async (t) => {
  await withLiveMcpClient(
    t,
    { clientName: "lupin-live-media", statePrefix: "lupin-live-media-" },
    async (client) => {
      const searchYoutubeResult = parseToolText(
        await client.callTool({
          name: "search_youtube",
          arguments: {
            query: "karpathy",
            limit: 3,
            sort: "relevance",
          },
        })
      );

      assert.equal(searchYoutubeResult.provider, "youtube");
      assert.ok(Array.isArray(searchYoutubeResult.results));
      assert.ok(searchYoutubeResult.results.length > 0);
      const youtubeResult = searchYoutubeResult.results.find((result) => /youtube\.com\/watch\?v=/.test(result.url));
      assert.ok(youtubeResult, "Expected at least one YouTube watch URL");

      const fetchYoutubeResult = parseToolText(
        await client.callTool({
          name: "fetch_youtube_video",
          arguments: {
            url: youtubeResult.url,
            format: "json",
          },
        })
      );

      assert.equal(fetchYoutubeResult.provider, "youtube");
      assert.equal(fetchYoutubeResult.format, "json");
      assert.equal(fetchYoutubeResult.blocked, false);
      assert.ok(fetchYoutubeResult.content.title);
      assert.ok(fetchYoutubeResult.content.author.name);
      assert.ok(Array.isArray(fetchYoutubeResult.content.media));
      assert.ok("viewCount" in fetchYoutubeResult.content.stats);
    }
  );
});
