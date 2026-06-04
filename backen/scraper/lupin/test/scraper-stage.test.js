import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Lupin } from "../src/scraper.js";

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-stage-"));
}

test("http stage extracts content from a normal page", async () => {
  const stateDir = await makeTempStateDir();
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head><title>Fixture Article</title></head>
        <body>
          <main>
            <h1>Fixture Article</h1>
            <p>This fixture contains enough text to be treated as real content by the HTTP stage.</p>
            <p>It should pass without escalating to Camoufox or Patchright.</p>
          </main>
        </body>
      </html>`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/article`;
  const scraper = new Lupin({ stateDir });

  try {
    const result = await scraper.scrape(url, { engine: "http" });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "http");
    assert.match(result.title, /Fixture Article/);
    assert.match(result.text, /HTTP stage/);
  } finally {
    server.close();
    await scraper.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("camoufox stage reports a clear startup failure when the profile dir is invalid", async () => {
  // Use /dev/null as stateDir so mkdir for the ephemeral session dir fails with ENOTDIR
  const scraper = new Lupin({
    stateDir: "/dev/null/lupin-state",
  });

  try {
    const result = await scraper.runSingleAttempt("camoufox", "https://example.com", {}, 0);
    assert.equal(result.ok, false);
    assert.match(result.reason, /ENOTDIR|not a directory/i);
  } finally {
    await scraper.close();
  }
});
