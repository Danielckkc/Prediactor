import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium as patchrightChromium } from "patchright";

import { BrowserManager } from "../src/runtime/browser-manager.js";

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-browser-manager-"));
}

test("ephemeral fallback sessions forward explicit proxy settings", async () => {
  const stateDir = await makeTempStateDir();
  const originalLaunch = patchrightChromium.launchPersistentContext;
  const launches = [];

  patchrightChromium.launchPersistentContext = async (_profileDir, options) => {
    launches.push(options);
    return {
      pages: () => [],
      newPage: async () => ({
        setDefaultTimeout() {},
        setExtraHTTPHeaders: async () => {},
        close: async () => {},
      }),
      close: async () => {},
    };
  };

  const manager = new BrowserManager({
    stateDir,
    fallbackProvider: "patchright",
  });

  try {
    const session = await manager.openSession({
      engine: "fallback",
      ephemeral: true,
      proxy: { server: "http://127.0.0.1:8888", username: "alice", password: "secret" },
      timeout: 1000,
    });

    await session.close();

    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].proxy, {
      server: "http://127.0.0.1:8888",
      username: "alice",
      password: "secret",
    });
  } finally {
    patchrightChromium.launchPersistentContext = originalLaunch;
    await manager.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
