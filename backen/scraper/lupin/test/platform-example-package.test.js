import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callFetchTool } from "../src/mcp/tools/fetch-tools.js";
import { callSearchTool } from "../src/mcp/tools/search-tools.js";
import { installPlatform, removePlatform } from "../src/platforms/manager.js";

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-platform-example-state-"));
}

test("repo example platform installs and responds through search/fetch tools", async () => {
  const stateDir = await makeTempStateDir();
  const examplePath = path.resolve(process.cwd(), "examples/platforms/hello-platform");

  try {
    const installed = await installPlatform(stateDir, examplePath);
    assert.equal(installed.manifestName, "hello-example");

    const searchResult = await callSearchTool(
      "search_hello_example",
      { query: "launch day" },
      { stateDir }
    );
    assert.equal(searchResult.provider, "hello-example");
    assert.equal(searchResult.results[0].url.includes("launch%20day"), true);

    const fetchResult = await callFetchTool(
      "fetch_hello_example_post",
      {
        url: "https://example.com/posts/launch-day",
        format: "json",
      },
      { stateDir }
    );
    assert.equal(fetchResult.provider, "hello-example");
    assert.equal(fetchResult.content.title, "Launch Day");
    assert.equal(fetchResult.content.platform.site, "hello-example");

    const removed = await removePlatform(stateDir, "hello-example");
    assert.equal(removed.removed, true);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
