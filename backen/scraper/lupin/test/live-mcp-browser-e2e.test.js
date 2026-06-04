import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import playwright from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseToolText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected text content in tool result");
  return JSON.parse(text);
}

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-live-mcp-"));
}

test("live MCP browser flow works against public external pages", { timeout: 90000 }, async (t) => {
  const executablePath = playwright.chromium.executablePath();
  if (!existsSync(executablePath)) {
    t.skip(`Playwright Chromium is not installed at ${executablePath}`);
    return;
  }

  const stateDir = await makeTempStateDir();
  const client = new Client({ name: "lupin-live-test", version: "0.0.0" });
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

  let sessionId = null;

  try {
    await client.connect(transport);

    const openResult = parseToolText(
      await client.callTool({
        name: "browser_open_session",
        arguments: { engine: "fallback", timeout: 15000 },
      })
    );

    sessionId = openResult.sessionId;
    assert.ok(sessionId);

    const navigateResult = parseToolText(
      await client.callTool({
        name: "browser_navigate",
        arguments: {
          sessionId,
          url: "https://example.com/",
          timeout: 15000,
        },
      })
    );

    assert.equal(navigateResult.ok, true);
    assert.match(navigateResult.title, /Example Domain/);

    const snapshotResult = parseToolText(
      await client.callTool({
        name: "browser_snapshot",
        arguments: { sessionId },
      })
    );

    assert.match(snapshotResult.textPreview, /Example Domain/);
    assert.ok(snapshotResult.elements.some((element) => /Learn more/i.test(element.text)));

    await client.callTool({
      name: "browser_click",
      arguments: {
        sessionId,
        selector: { text: "Learn more" },
      },
    });

    const ianaWaitResult = parseToolText(
      await client.callTool({
        name: "browser_wait_for",
        arguments: {
          sessionId,
          selector: { text: "Example Domains" },
          timeout: 15000,
        },
      })
    );

    assert.equal(ianaWaitResult.ok, true);
    assert.match(ianaWaitResult.url, /iana\.org/);

    const extractResult = parseToolText(
      await client.callTool({
        name: "browser_extract",
        arguments: {
          sessionId,
          format: "json",
        },
      })
    );

    assert.equal(extractResult.format, "json");
    assert.match(extractResult.content.title, /Example Domains/);
    assert.match(extractResult.content.text, /IANA-managed Reserved Domains|RFC 2606/i);
  } finally {
    if (sessionId) {
      await client
        .callTool({
          name: "browser_close_session",
          arguments: { sessionId },
        })
        .catch(() => {});
    }
    await transport.close().catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
