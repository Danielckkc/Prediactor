import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { attachPlatformFailureHint } from "../src/platforms/failure-hints.js";
import { callSearchTool } from "../src/mcp/tools/search-tools.js";
import { writePlatformConfig } from "../src/platforms/state.js";

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("platform search failures carry update hints for path-backed providers", async () => {
  const stateDir = await makeTempDir("lupin-platform-hints-state-");
  const pluginDir = await makeTempDir("lupin-platform-hints-plugin-");

  try {
    await fs.writeFile(
      path.join(pluginDir, "lupin.platform.json"),
      `${JSON.stringify({
        apiVersion: 1,
        name: "hint-demo",
        displayName: "Hint Demo",
        description: "Fixture platform that throws during search.",
        version: "0.0.1",
        entry: "./index.js",
        tools: {
          search: [
            {
              tool: "search_hint_demo",
              alias: "hint-demo",
              description: "Search hint demo.",
              inputSchema: "search.standard",
              handler: "search",
            },
          ],
          fetch: [],
        },
      }, null, 2)}\n`
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "export async function search() { throw new Error('selector no longer matches'); }\n"
    );
    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: pluginDir }],
      disabled: [],
    });

    await assert.rejects(
      callSearchTool("search_hint_demo", { query: "hello" }, { stateDir }),
      (error) => {
        assert.equal(error.message, "selector no longer matches");
        assert.equal(error.updateHint.platform, "hint-demo");
        assert.equal(error.updateHint.sourceKind, "path");
        assert.deepEqual(error.updateHint.commands, ["lupin platform update hint-demo"]);
        return true;
      }
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});

test("platform failure hints point built-ins to core update checks", () => {
  const error = new Error("site shell changed");
  attachPlatformFailureHint(error, {
    name: "instagram",
    displayName: "Instagram",
    sourceKind: "builtin",
  });

  assert.equal(error.updateHint.platform, "instagram");
  assert.equal(error.updateHint.sourceKind, "builtin");
  assert.deepEqual(error.updateHint.commands, ["lupin doctor", "lupin update check"]);
});

test("platform failure hints skip likely user input errors", () => {
  const error = new Error("Unsupported Instagram URL: https://example.com");
  attachPlatformFailureHint(error, {
    name: "instagram",
    displayName: "Instagram",
    sourceKind: "builtin",
  });

  assert.equal(error.updateHint, undefined);
});

