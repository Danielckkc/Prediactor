import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { writePlatformConfig } from "../src/platforms/state.js";

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createFixturePlatform(dir) {
  const manifest = {
    apiVersion: 1,
    name: "local-demo",
    displayName: "Local Demo",
    description: "Fixture platform used to test MCP registry flows.",
    version: "0.0.1",
    entry: "./index.js",
    tools: {
      search: [
        {
          tool: "search_localdemo",
          alias: "localdemo",
          description: "Search the local demo platform.",
          inputSchema: "search.standard",
          handler: "search",
        },
      ],
      fetch: [
        {
          tool: "fetch_localdemo_item",
          alias: "localdemo",
          description: "Fetch a local demo item.",
          inputSchema: "fetch.standard",
          handler: "fetchItem",
        },
      ],
    },
  };

  const entrySource = `const snapshotDate = "2026-04-15";

export async function search(args) {
  return {
    provider: "local-demo",
    query: args.query,
    usedStrategy: "fixture",
    snapshotDate,
    results: [{ rank: 1, title: "Fixture result", url: "https://example.com/local-demo", snippet: "ok" }],
    warnings: [],
    blocked: false,
    durationMs: 1
  };
}

export async function fetchItem(args) {
  return {
    provider: "local-demo",
    url: args.url,
    finalUrl: args.url,
    snapshotDate,
    format: "json",
    content: {
      entityType: "item",
      title: "Fixture item",
      author: { name: "Local Demo", handle: null, url: null },
      publishedAt: null,
      text: "served by plugin",
      stats: {},
      media: [],
      outboundLinks: [],
      comments: [],
      platform: { site: "localdemo", canonicalUrl: args.url }
    },
    warnings: [],
    blocked: false,
    extraction: { method: "fixture", confidence: "high" },
    durationMs: 1
  };
}
`;

  await fs.writeFile(path.join(dir, "lupin.platform.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dir, "index.js"), entrySource);
}

function parseToolText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected text content in tool result");
  return JSON.parse(text);
}

test("MCP tool list reflects disabled built-ins and installed external platforms", async () => {
  const stateDir = await makeTempDir("lupin-mcp-platform-state-");
  const pluginDir = await makeTempDir("lupin-mcp-platform-plugin-");

  try {
    await createFixturePlatform(pluginDir);
    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: pluginDir }],
      disabled: ["instagram"],
    });

    const client = new Client({ name: "lupin-platform-test", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["./bin/lupin.js", "--mcp"],
      cwd: process.cwd(),
      stderr: "pipe",
      env: {
        ...process.env,
        LUPIN_STATE_DIR: stateDir,
      },
    });

    transport.stderr?.on("data", () => {});

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "search_localdemo"));
      assert.ok(tools.tools.some((tool) => tool.name === "fetch_localdemo_item"));
      assert.ok(!tools.tools.some((tool) => tool.name === "search_instagram"));
      assert.ok(!tools.tools.some((tool) => tool.name === "fetch_instagram_post"));

      const searchResult = parseToolText(
        await client.callTool({
          name: "search_localdemo",
          arguments: {
            query: "hello",
          },
        })
      );
      assert.equal(searchResult.provider, "local-demo");
    } finally {
      await transport.close().catch(() => {});
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});
