import assert from "node:assert/strict";
import test from "node:test";

import { parseToolText, withLiveMcpClient } from "../test-support/live-mcp.js";

test("live core search/fetch tools work against public external pages", { timeout: 180000 }, async (t) => {
  await withLiveMcpClient(
    t,
    { clientName: "lupin-live-core", statePrefix: "lupin-live-core-" },
    async (client) => {
      const searchWebResult = parseToolText(
        await client.callTool({
          name: "search_web",
          arguments: {
            query: "\"Example Domain\"",
            site: "example.com",
            limit: 5,
          },
        })
      );

      assert.equal(searchWebResult.provider, "web");
      assert.ok(Array.isArray(searchWebResult.attemptedEngines));
      assert.ok(searchWebResult.attemptedEngines.length >= 1);

      const searchGoogleResult = parseToolText(
        await client.callTool({
          name: "search_google",
          arguments: {
            query: "\"Example Domain\"",
            site: "example.com",
            limit: 5,
          },
        })
      );

      assert.equal(searchGoogleResult.provider, "google");
      if (searchGoogleResult.blocked) {
        assert.ok(searchGoogleResult.results.length === 0);
        assert.ok(searchGoogleResult.warnings.length > 0);
      } else {
        assert.ok(searchGoogleResult.results.length > 0);
        assert.ok(searchGoogleResult.results.some((result) => /example\.com/.test(result.url)));
      }

      const searchDuckDuckGoResult = parseToolText(
        await client.callTool({
          name: "search_web",
          arguments: {
            query: "\"Example Domain\"",
            site: "example.com",
            engine: "duckduckgo",
            limit: 5,
          },
        })
      );

      assert.equal(searchDuckDuckGoResult.provider, "web");
      assert.equal(searchDuckDuckGoResult.engine, "duckduckgo");
      if (searchDuckDuckGoResult.blocked) {
        assert.ok(searchDuckDuckGoResult.results.length === 0);
        assert.ok(searchDuckDuckGoResult.warnings.length > 0);
      } else {
        assert.ok(searchDuckDuckGoResult.results.length > 0);
        assert.ok(searchDuckDuckGoResult.results.some((result) => /example\.com/.test(result.url)));
      }

      const fetchPageResult = parseToolText(
        await client.callTool({
          name: "fetch_page",
          arguments: {
            url: "https://example.com/",
            format: "markdown",
            engine: "fallback",
          },
        })
      );

      assert.equal(fetchPageResult.provider, "page");
      assert.equal(fetchPageResult.format, "markdown");
      assert.match(fetchPageResult.content, /Example Domain/);
      assert.match(fetchPageResult.content, /example\.com/);
    }
  );
});
