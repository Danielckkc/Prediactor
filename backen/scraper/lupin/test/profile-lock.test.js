import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireProfileLock } from "../src/profile-lock.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lupin-lock-"));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("acquires and releases a profile lock", async () => {
  await withTempDir(async (tempDir) => {
    const profileDir = path.join(tempDir, "profile");
    const lock = await acquireProfileLock(profileDir, { timeoutMs: 1000, pollMs: 10 });
    const lockDir = `${profileDir}.lock`;

    await fs.stat(lockDir);
    await lock.release();
    await assert.rejects(() => fs.stat(lockDir), { code: "ENOENT" });
  });
});

test("waits for an existing lock to be released", async () => {
  await withTempDir(async (tempDir) => {
    const profileDir = path.join(tempDir, "profile");
    const first = await acquireProfileLock(profileDir, { timeoutMs: 1000, pollMs: 10 });

    const startedAt = Date.now();
    const secondPromise = acquireProfileLock(profileDir, { timeoutMs: 1000, pollMs: 10 });

    await delay(100);
    await first.release();

    const second = await secondPromise;
    assert.ok(Date.now() - startedAt >= 100);
    await second.release();
  });
});

test("reclaims a stale lock left by a dead process", async () => {
  await withTempDir(async (tempDir) => {
    const profileDir = path.join(tempDir, "profile");
    const lockDir = `${profileDir}.lock`;
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999999, token: "stale-token", createdAt: Date.now() - 60000 }, null, 2)
    );

    const lock = await acquireProfileLock(profileDir, { timeoutMs: 1000, pollMs: 10, orphanMs: 10 });
    await lock.release();
  });
});

test("times out when another live owner keeps the lock", async () => {
  await withTempDir(async (tempDir) => {
    const profileDir = path.join(tempDir, "profile");
    const first = await acquireProfileLock(profileDir, { timeoutMs: 1000, pollMs: 10 });

    await assert.rejects(
      () => acquireProfileLock(profileDir, { timeoutMs: 50, pollMs: 10 }),
      /Timed out waiting .* for fallback profile lock .* Another process is probably using the persistent fallback browser profile\./
    );

    await first.release();
  });
});
