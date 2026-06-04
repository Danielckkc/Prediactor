import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import playwright from "playwright";

import { Lupin } from "../src/scraper.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-fallback-e2e-"));
}

test("fallback stage extracts content with a real Patchright browser", { timeout: 60000 }, async (t) => {
  const executablePath = playwright.chromium.executablePath();
  if (!existsSync(executablePath)) {
    t.skip(`Playwright Chromium is not installed at ${executablePath}`);
    return;
  }

  const stateDir = await makeTempStateDir();
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Fallback Fixture Story</title></head>
        <body>
          <main id="story">
            <h1>Fallback Fixture Story</h1>
            <p>This page is served by a local HTTP fixture and is intended to verify the real browser-backed fallback path.</p>
            <p>The content is deliberately long enough to pass the visible-text threshold and confirm that Patchright can extract usable text end to end.</p>
          </main>
        </body>
      </html>`);
  });

  await listen(server);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/story`;
  const scraper = new Lupin({
    stateDir,
    executablePath,
    fallbackHeadless: true,
    fallbackProvider: "patchright",
    fallbackRetries: 1,
    fallbackTimeoutMs: 15000,
  });

  try {
    const result = await scraper.scrape(url, {
      engine: "fallback",
      waitFor: "#story",
    });

    assert.equal(result.ok, true);
    assert.equal(result.engine, "fallback");
    assert.equal(result.attempts.length, 1);
    assert.match(result.title, /Fallback Fixture Story/);
    assert.match(result.text, /browser-backed fallback path/i);
  } finally {
    await scraper.close();
    await close(server);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
