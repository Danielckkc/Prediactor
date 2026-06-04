import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Lupin } from "../src/scraper.js";

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-routing-"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("auto routing prefers http then camoufox then fallback by default", async () => {
  const stateDir = await makeTempStateDir();
  const scraper = new Lupin({ stateDir });

  try {
    const routing = await scraper.resolveRouting("example.com", "auto");
    assert.deepEqual(routing.engines, ["http", "camoufox", "fallback"]);
  } finally {
    await scraper.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("auto routing honors remembered camoufox preference", async () => {
  const stateDir = await makeTempStateDir();
  const scraper = new Lupin({ stateDir });

  try {
    await scraper.domainMemory.set("example.com", "camoufox");
    const routing = await scraper.resolveRouting("example.com", "auto");
    assert.deepEqual(routing.engines, ["camoufox", "fallback"]);
  } finally {
    await scraper.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("auto routing preserves legacy fallback memory entries", async () => {
  const stateDir = await makeTempStateDir();
  const memoryPath = path.join(stateDir, "domain-memory.json");
  await fs.writeFile(
    memoryPath,
    JSON.stringify({
      version: 1,
      entries: {
        "example.com": {
          engine: "fallback",
          updatedAt: Date.now(),
        },
      },
    })
  );

  const scraper = new Lupin({ stateDir, domainMemoryPath: memoryPath });

  try {
    const routing = await scraper.resolveRouting("example.com", "auto");
    assert.deepEqual(routing.engines, ["fallback"]);
  } finally {
    await scraper.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("manual patchright mode aliases to fallback routing", async () => {
  const stateDir = await makeTempStateDir();
  const scraper = new Lupin({ stateDir });

  try {
    const routing = await scraper.resolveRouting("example.com", "patchright");
    assert.deepEqual(routing.engines, ["fallback"]);
  } finally {
    await scraper.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("domain memory preserves concurrent updates from multiple scraper instances", async () => {
  const stateDir = await makeTempStateDir();
  const memoryPath = path.join(stateDir, "domain-memory.json");
  const first = new Lupin({ stateDir, domainMemoryPath: memoryPath });
  const second = new Lupin({ stateDir, domainMemoryPath: memoryPath });

  try {
    await Promise.all([
      first.domainMemory.set("camoufox.example", "camoufox"),
      second.domainMemory.set("fallback.example", "fallback"),
    ]);

    const saved = JSON.parse(await fs.readFile(memoryPath, "utf8"));
    assert.deepEqual(Object.keys(saved.entries).sort(), ["camoufox.example", "fallback.example"]);
  } finally {
    await first.close();
    await second.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("domain memory failure updates do not refresh the routing TTL", async () => {
  const stateDir = await makeTempStateDir();
  const scraper = new Lupin({ stateDir, domainTtlMs: 40 });

  try {
    await scraper.domainMemory.set("example.com", "fallback");
    await delay(25);
    await scraper.domainMemory.noteFailure("example.com", "temporary failure");
    await delay(25);

    const routing = await scraper.resolveRouting("example.com", "auto");
    assert.deepEqual(routing.engines, ["http", "camoufox", "fallback"]);
  } finally {
    await scraper.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
