import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import playwright from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function parseToolText(result) {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected text content in tool result");
  return JSON.parse(text);
}

async function makeTempStateDir(prefix = "lupin-live-search-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function withLiveMcpClient(testContext, options, callback) {
  const executablePath = playwright.chromium.executablePath();
  if (!existsSync(executablePath)) {
    testContext.skip(`Playwright Chromium is not installed at ${executablePath}`);
    return;
  }

  const stateDir = await makeTempStateDir(options?.statePrefix);
  const client = new Client({ name: options?.clientName || "lupin-live-search", version: "0.0.0" });
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
    const callTool = client.callTool.bind(client);
    client.callTool = (params, resultSchema, options = {}) =>
      callTool(params, resultSchema, { timeout: 180000, ...options });
    await callback(client);
  } finally {
    await transport.close().catch(() => {});
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
