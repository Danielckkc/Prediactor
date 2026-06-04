import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import playwright from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-mcp-browser-"));
}

function parseToolText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected text content in tool result");
  return JSON.parse(text);
}

test("MCP exposes browser tools and fetch_page works", { timeout: 60000 }, async (t) => {
  const executablePath = playwright.chromium.executablePath();
  if (!existsSync(executablePath)) {
    t.skip(`Playwright Chromium is not installed at ${executablePath}`);
    return;
  }

  const stateDir = await makeTempStateDir();
  const server = http.createServer((request, response) => {
    if (request.url === "/interactive") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <html>
          <head><title>Interactive MCP Fixture</title></head>
          <body>
            <main>
              <h1>Interactive MCP Fixture</h1>
              <label>Query <input name="query" /></label>
              <button id="apply">Apply</button>
              <p id="result">Idle</p>
            </main>
            <script>
              document.querySelector("#apply").addEventListener("click", () => {
                const value = document.querySelector("input[name=query]").value;
                const result = document.querySelector("#result");
                result.className = "ready";
                result.textContent = "Saved value: " + value;
              });
            </script>
          </body>
        </html>`);
      return;
    }

    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Scrape Fixture</title></head>
        <body>
          <main id="article">
            <h1>Scrape Fixture</h1>
            <p>This fixture confirms that fetch_page remains functional while browser tools are added.</p>
          </main>
        </body>
      </html>`);
  });

  await listen(server);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "lupin-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["./bin/lupin.js", "--mcp"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      LUPIN_EXECUTABLE_PATH: executablePath,
      LUPIN_FALLBACK_HEADLESS: "true",
      LUPIN_STATE_DIR: stateDir,
    },
  });

  transport.stderr?.on("data", () => {});

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "fetch_page"));
    assert.ok(tools.tools.some((tool) => tool.name === "browser_open_session"));

    const openResult = parseToolText(
      await client.callTool({
        name: "browser_open_session",
        arguments: { engine: "fallback", timeout: 10000 },
      })
    );

    assert.equal(openResult.engine, "fallback");
    assert.ok(openResult.sessionId);

    await client.callTool({
      name: "browser_navigate",
      arguments: {
        sessionId: openResult.sessionId,
        url: `${baseUrl}/interactive`,
        waitFor: "#result",
        timeout: 10000,
      },
    });

    await client.callTool({
      name: "browser_type",
      arguments: {
        sessionId: openResult.sessionId,
        selector: { css: 'input[name="query"]' },
        text: "Phase 1 works",
      },
    });

    await client.callTool({
      name: "browser_click",
      arguments: {
        sessionId: openResult.sessionId,
        selector: { css: "#apply" },
      },
    });

    await client.callTool({
      name: "browser_wait_for",
      arguments: {
        sessionId: openResult.sessionId,
        selector: { css: "#result.ready" },
        timeout: 10000,
      },
    });

    const extractResult = parseToolText(
      await client.callTool({
        name: "browser_extract",
        arguments: {
          sessionId: openResult.sessionId,
          format: "json",
        },
      })
    );

    assert.equal(extractResult.format, "json");
    assert.match(extractResult.content.title, /Interactive MCP Fixture/);
    assert.match(extractResult.content.text, /Saved value: Phase 1 works/);

    const fetchResult = parseToolText(
      await client.callTool({
        name: "fetch_page",
        arguments: {
          url: `${baseUrl}/article`,
          engine: "http",
          format: "json",
        },
      })
    );

    assert.match(fetchResult.content.text, /fetch_page remains functional/i);

    const closeResult = parseToolText(
      await client.callTool({
        name: "browser_close_session",
        arguments: { sessionId: openResult.sessionId },
      })
    );

    assert.equal(closeResult.ok, true);
  } finally {
    await transport.close().catch(() => {});
    await close(server);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
