import fs from "node:fs/promises";
import path from "node:path";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildOwnerRecord() {
  return {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: Date.now(),
  };
}

async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
}

async function getLockState(lockDir, ownerPath, orphanMs) {
  const [owner, stats] = await Promise.all([
    readJson(ownerPath),
    fs.stat(lockDir).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }),
  ]);

  if (!stats) return { owner: null, stale: false };

  if (owner?.pid && isProcessAlive(owner.pid)) {
    return { owner, stale: false };
  }

  if (owner?.pid && !isProcessAlive(owner.pid)) {
    return { owner, stale: true };
  }

  return {
    owner,
    stale: Date.now() - stats.mtimeMs > orphanMs,
  };
}

export async function acquireProfileLock(profileDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120000;
  const pollMs = options.pollMs ?? 500;
  const orphanMs = options.orphanMs ?? 30000;
  const lockDir = `${profileDir}.lock`;
  const ownerPath = path.join(lockDir, "owner.json");
  const startedAt = Date.now();
  const owner = buildOwnerRecord();

  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(ownerPath, JSON.stringify(owner, null, 2));

      return {
        lockDir,
        owner,
        async release() {
          const currentOwner = await readJson(ownerPath);
          if (currentOwner?.token !== owner.token) return;
          await fs.rm(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const state = await getLockState(lockDir, ownerPath, orphanMs);
    if (state.stale) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      continue;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const ownerDescription = state.owner?.pid ? `pid ${state.owner.pid}` : "unknown owner";
      const waitedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      throw new Error(
        `Timed out waiting ${waitedSeconds}s for fallback profile lock at ${lockDir} held by ${ownerDescription}. ` +
        "Another process is probably using the persistent fallback browser profile."
      );
    }

    await delay(pollMs);
  }
}
