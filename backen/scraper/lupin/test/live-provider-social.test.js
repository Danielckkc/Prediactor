import assert from "node:assert/strict";
import test from "node:test";

import { parseToolText, withLiveMcpClient } from "../test-support/live-mcp.js";

test("live social providers work through MCP", { timeout: 180000 }, async (t) => {
  await withLiveMcpClient(
    t,
    { clientName: "lupin-live-social", statePrefix: "lupin-live-social-" },
    async (client) => {
      const searchXResult = parseToolText(
        await client.callTool({
          name: "search_x",
          arguments: {
            query: "UX UI best practice",
            sort: "recent",
            limit: 5,
          },
        })
      );

      assert.equal(searchXResult.provider, "x");
      assert.ok(Array.isArray(searchXResult.results));
      if (searchXResult.blocked || searchXResult.results.length === 0) {
        assert.ok(searchXResult.warnings.length > 0);
      } else {
        assert.ok(searchXResult.results.some((result) => /x\.com/.test(result.url)));
      }

      const fetchXResult = parseToolText(
        await client.callTool({
          name: "fetch_x_post",
          arguments: {
            url: "https://x.com/uxlinks/status/1867484141723197613",
            format: "json",
            engine: "camoufox",
          },
        })
      );

      assert.equal(fetchXResult.provider, "x");
      assert.equal(fetchXResult.format, "json");
      if (fetchXResult.blocked) {
        assert.ok(fetchXResult.warnings.length > 0);
      } else {
        assert.match(fetchXResult.content.text, /Useful Best Practice Cheatsheet/i);
        assert.match(fetchXResult.content.author.handle, /^@/);
        assert.ok("likeCount" in fetchXResult.content.stats);
      }

      const searchInstagramResult = parseToolText(
        await client.callTool({
          name: "search_instagram",
          arguments: {
            query: "clean dark ui",
            limit: 5,
          },
        })
      );

      assert.equal(searchInstagramResult.provider, "instagram");
      assert.ok(Array.isArray(searchInstagramResult.results));
      if (searchInstagramResult.blocked) {
        assert.ok(searchInstagramResult.warnings.length > 0);
      } else {
        assert.ok(searchInstagramResult.results.length > 0);
        assert.ok(searchInstagramResult.results.some((result) => /instagram\.com\/(p|reel|reels)\//.test(result.url)));
      }

      const fetchInstagramPostResult = parseToolText(
        await client.callTool({
          name: "fetch_instagram_post",
          arguments: {
            url: "https://www.instagram.com/p/DUqM9L0CCE5/",
            format: "json",
          },
        })
      );

      assert.equal(fetchInstagramPostResult.provider, "instagram");
      assert.equal(fetchInstagramPostResult.format, "json");
      assert.equal(fetchInstagramPostResult.blocked, false);
      assert.equal(fetchInstagramPostResult.content.entityType, "post");
      assert.ok(fetchInstagramPostResult.content.author.handle?.startsWith("@"));
      assert.ok(Array.isArray(fetchInstagramPostResult.content.media));
      assert.ok("likeCount" in fetchInstagramPostResult.content.stats);

      const fetchInstagramReelResult = parseToolText(
        await client.callTool({
          name: "fetch_instagram_post",
          arguments: {
            url: "https://www.instagram.com/reels/DWO1i9BjYAw/",
            format: "json",
          },
        })
      );

      assert.equal(fetchInstagramReelResult.provider, "instagram");
      assert.equal(fetchInstagramReelResult.format, "json");
      assert.equal(fetchInstagramReelResult.blocked, false);
      assert.equal(fetchInstagramReelResult.content.entityType, "reel");
      assert.ok(fetchInstagramReelResult.content.author.handle?.startsWith("@"));
      assert.ok(Array.isArray(fetchInstagramReelResult.content.media));

      const searchTiktokResult = parseToolText(
        await client.callTool({
          name: "search_tiktok",
          arguments: {
            query: "dog tiktok",
            limit: 5,
          },
        })
      );

      assert.equal(searchTiktokResult.provider, "tiktok");
      assert.ok(Array.isArray(searchTiktokResult.results));
      if (searchTiktokResult.blocked) {
        assert.ok(searchTiktokResult.warnings.length > 0);
      } else {
        assert.ok(searchTiktokResult.results.length > 0);
        assert.ok(searchTiktokResult.results.some((result) => /tiktok\.com\//.test(result.url)));
      }

      const fetchInstagramProfileResult = parseToolText(
        await client.callTool({
          name: "fetch_instagram_profile",
          arguments: {
            url: "https://www.instagram.com/natgeo/",
            format: "json",
          },
        })
      );

      assert.equal(fetchInstagramProfileResult.provider, "instagram");
      assert.equal(fetchInstagramProfileResult.format, "json");
      if (fetchInstagramProfileResult.blocked) {
        assert.ok(fetchInstagramProfileResult.warnings.length > 0);
      } else {
        assert.equal(fetchInstagramProfileResult.content.entityType, "profile");
        assert.ok(fetchInstagramProfileResult.content.author.handle?.startsWith("@"));
        assert.ok(fetchInstagramProfileResult.content.text.length > 0); // bio
        assert.ok("followerCount" in fetchInstagramProfileResult.content.stats);
        assert.ok("followingCount" in fetchInstagramProfileResult.content.stats);
        assert.ok("postCount" in fetchInstagramProfileResult.content.stats);
        assert.ok(fetchInstagramProfileResult.content.media.length > 0); // profile pic
        assert.ok(fetchInstagramProfileResult.content.latestPosts.length > 0); // latest posts
        assert.ok(fetchInstagramProfileResult.content.latestPosts[0].url);
        assert.ok(fetchInstagramProfileResult.content.platform.username);
        assert.equal(fetchInstagramProfileResult.content.platform.pathType, "profile");
      }

      const fetchTiktokResult = parseToolText(
        await client.callTool({
          name: "fetch_tiktok_post",
          arguments: {
            url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
            format: "json",
          },
        })
      );

      assert.equal(fetchTiktokResult.provider, "tiktok");
      assert.equal(fetchTiktokResult.format, "json");
      assert.equal(fetchTiktokResult.blocked, false);
      assert.equal(fetchTiktokResult.content.entityType, "video");
      assert.ok(fetchTiktokResult.content.author.handle?.startsWith("@"));
      assert.ok(fetchTiktokResult.content.text.length > 0);
      assert.ok(Array.isArray(fetchTiktokResult.content.media));
      assert.ok(fetchTiktokResult.content.media.some((item) => item.type === "video" || item.type === "image"));
      assert.ok("likeCount" in fetchTiktokResult.content.stats);

      const fetchTiktokProfileResult = parseToolText(
        await client.callTool({
          name: "fetch_tiktok_profile",
          arguments: {
            url: "https://www.tiktok.com/@khaby.lame",
            format: "json",
          },
        })
      );

      assert.equal(fetchTiktokProfileResult.provider, "tiktok");
      assert.equal(fetchTiktokProfileResult.format, "json");
      assert.equal(fetchTiktokProfileResult.blocked, false);
      assert.equal(fetchTiktokProfileResult.content.entityType, "profile");
      assert.ok(fetchTiktokProfileResult.content.author.handle?.startsWith("@"));
      assert.ok(fetchTiktokProfileResult.content.text.length > 0); // bio
      assert.ok("followerCount" in fetchTiktokProfileResult.content.stats);
      assert.ok("followingCount" in fetchTiktokProfileResult.content.stats);
      assert.ok("videoCount" in fetchTiktokProfileResult.content.stats);
      assert.ok(fetchTiktokProfileResult.content.media.length > 0); // avatar
      assert.ok(Array.isArray(fetchTiktokProfileResult.content.latestPosts)); // latest videos when exposed
      if (fetchTiktokProfileResult.content.latestPosts.length > 0) {
        assert.ok(fetchTiktokProfileResult.content.latestPosts[0].url.includes("/video/"));
      }
      assert.ok(fetchTiktokProfileResult.content.platform.username);
      assert.equal(fetchTiktokProfileResult.content.platform.isVerified, true);
    }
  );
});
