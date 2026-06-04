import fs from "node:fs/promises";
import path from "node:path";

import playwright from "playwright";
import { chromium as patchrightChromium } from "patchright";
import { Camoufox } from "camoufox-js";

import { hardenPage } from "../extractors.js";
import { acquireProfileLock } from "../profile-lock.js";
import { createRuntimeConfig, normalizeEngineName } from "./config.js";
import { createProxyPool } from "./proxy-pool.js";
import { resolveFallbackExecutablePath } from "./browser-deps.js";

function addCamoufoxInstallHint(error) {
  const message = error?.message || String(error);
  if (!/executable|browser|camoufox/i.test(message)) {
    return error;
  }

  return new Error(`${message}\n\nRun \`lupin setup\` to install the browser dependencies.`);
}

function addFallbackProfileLockHint(error, config) {
  const message = error?.message || String(error);
  if (!/fallback profile lock/i.test(message)) {
    return error;
  }

  const lines = [
    message,
    "",
    `Fallback profile dir: ${config.persistentProfileDir}`,
    "Wait for the other process to finish, or set `LUPIN_PROFILE_DIR` to a unique directory for parallel runs.",
    "You can also lower `LUPIN_FALLBACK_LOCK_TIMEOUT_MS` if you want the failure to happen sooner.",
  ];

  return new Error(lines.join("\n"));
}

async function sweepStaleDir(sessionsDir, maxAgeMs) {
  let entries;
  try {
    entries = await fs.readdir(sessionsDir);
  } catch {
    return;
  }

  const now = Date.now();
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(sessionsDir, entry);
      const pid = parseInt(entry.split("-")[0], 10);
      const pidAlive = Number.isFinite(pid) && isProcessAlive(pid);
      if (!pidAlive) {
        await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
        return;
      }
      // PID is alive — only remove if it's our own stale dir AND exceeds max age.
      // Never remove another live process's profile dir.
      if (pid !== process.pid) return;
      try {
        const stat = await fs.stat(entryPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
        }
      } catch {}
    })
  );
}

async function sweepStaleSessions(stateDir, maxAgeMs) {
  await Promise.all([
    sweepStaleDir(path.join(stateDir, "profiles", "camoufox-sessions"), maxAgeMs),
    sweepStaleDir(path.join(stateDir, "profiles", "patchright-ephemeral"), maxAgeMs),
  ]);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STALE_SWEEP_INTERVAL_MS = 5 * 60_000;

export class BrowserManager {
  constructor(options = {}) {
    const { stateDir, config } = createRuntimeConfig(options);
    this.stateDir = stateDir;
    this.config = config;
    this.proxyPool = options.proxyPool || createProxyPool(config);
    this.fallbackOwnerPromise = null;
    this.cleanupCallbacks = new Set();
    this.sweepPromise = sweepStaleSessions(stateDir, config.sessionTtlMs * 2);
    this.staleSweepTimer = setInterval(() => {
      sweepStaleSessions(stateDir, config.sessionTtlMs * 2).catch(() => {});
    }, STALE_SWEEP_INTERVAL_MS);
    this.staleSweepTimer.unref();
  }

  async openSession(options = {}) {
    const engine = normalizeEngineName(options.engine, "fallback");
    const timeout = options.timeout || this.defaultTimeoutForEngine(engine);

    switch (engine) {
      case "fallback":
        return options.ephemeral && this.config.fallbackProvider === "patchright"
          ? this.openEphemeralFallbackSession(timeout, options)
          : this.openFallbackSession(timeout);
      case "camoufox":
        return this.openCamoufoxSession(timeout, options);
      default:
        throw new Error(`Unsupported browser session engine: ${engine}`);
    }
  }

  defaultTimeoutForEngine(engine) {
    switch (engine) {
      case "camoufox":
        return this.config.camoufoxTimeoutMs;
      default:
        return this.config.fallbackTimeoutMs;
    }
  }

  async openFallbackSession(timeout) {
    let owner;
    try {
      owner = await this.getFallbackOwner();
    } catch (error) {
      throw addFallbackProfileLockHint(error, this.config);
    }

    const { context, provider } = owner;
    let page;
    try {
      page = await context.newPage();
      await hardenPage(page, { timeout, engine: "fallback" });
    } catch (error) {
      // The browser process likely crashed after launch.  Invalidate the
      // cached owner so the next attempt re-launches a fresh browser
      // instead of reusing a dead context.
      await this.invalidateFallbackOwner();
      throw error;
    }

    return {
      engine: "fallback",
      provider,
      page,
      defaultTimeoutMs: timeout,
      close: async () => {
        await page.close().catch(() => {});
      },
    };
  }

  async openEphemeralFallbackSession(timeout, options = {}) {
    const profileDir = path.join(
      this.stateDir, "profiles", "patchright-ephemeral",
      `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    await fs.mkdir(profileDir, { recursive: true });

    let context;
    try {
      const resolvedFallback = resolveFallbackExecutablePath(this.config);
      context = await patchrightChromium.launchPersistentContext(profileDir, {
        headless: this.config.fallbackHeadless,
        executablePath: resolvedFallback.path || undefined,
        channel: resolvedFallback.path ? undefined : this.config.chromeChannel,
        proxy: options.proxy || this.config.proxy,
        viewport: null,
        ignoreHTTPSErrors: true,
        locale: "en-US",
        timezoneId: "America/New_York",
      });
    } catch (error) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    // Close the initial about:blank page.
    for (const p of context.pages()) {
      await p.close().catch(() => {});
    }

    const page = await context.newPage();
    await hardenPage(page, { timeout, engine: "fallback" });

    return {
      engine: "fallback",
      provider: "patchright",
      page,
      defaultTimeoutMs: timeout,
      close: async () => {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  async wipePersistentProfiles() {
    await this.invalidateFallbackOwner();
    await Promise.all([
      fs.rm(this.config.persistentProfileDir, { recursive: true, force: true }).catch(() => {}),
      fs.rm(this.config.camoufoxProfileDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  }

  async openCamoufoxSession(timeout, options = {}) {
    const profileDir = path.join(this.stateDir, "profiles", "camoufox-sessions", `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.mkdir(profileDir, { recursive: true });

    let context;
    try {
      const camoufoxOpts = {
        headless: this.config.camoufoxHeadless,
        user_data_dir: profileDir,
      };
      // Use explicitly passed proxy, or acquire one from the pool, or fall back to config
      const proxy = options.proxy || this.proxyPool?.next()?.proxy || this.config.proxy;
      if (proxy) {
        camoufoxOpts.proxy = proxy;
      }
      context = await Camoufox(camoufoxOpts);
    } catch (error) {
      await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      throw addCamoufoxInstallHint(error);
    }
    const page = await context.newPage();
    await hardenPage(page, { timeout, engine: "camoufox" });

    return {
      engine: "camoufox",
      provider: "camoufox",
      page,
      context,
      profileDir,
      defaultTimeoutMs: timeout,
      close: async () => {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  }

  async close() {
    clearInterval(this.staleSweepTimer);
    for (const callback of this.cleanupCallbacks) {
      await callback().catch(() => {});
    }
    this.cleanupCallbacks.clear();
    const fallbackOwner = await this.fallbackOwnerPromise?.catch(() => null);
    if (fallbackOwner?.close) {
      await fallbackOwner.close().catch(() => {});
    }
    this.fallbackOwnerPromise = null;
  }

  registerCleanup(callback) {
    this.cleanupCallbacks.add(callback);
    return () => {
      this.cleanupCallbacks.delete(callback);
    };
  }

  async invalidateFallbackOwner() {
    const owner = await this.fallbackOwnerPromise?.catch(() => null);
    this.fallbackOwnerPromise = null;
    if (owner?.close) {
      await owner.close().catch(() => {});
    }
  }

  async getFallbackOwner() {
    if (!this.fallbackOwnerPromise) {
      this.fallbackOwnerPromise = this.createFallbackOwner().catch((error) => {
        this.fallbackOwnerPromise = null;
        throw error;
      });
    }

    return this.fallbackOwnerPromise;
  }

  async createFallbackOwner() {
    switch (this.config.fallbackProvider) {
      case "patchright":
        return this.createPatchrightFallbackOwner();
      case "cdp":
        return this.createCdpFallbackOwner();
      default:
        throw new Error(
          `Unsupported fallback provider: ${this.config.fallbackProvider}. Expected one of: patchright, cdp`
        );
    }
  }

  async createPatchrightFallbackOwner() {
    await fs.mkdir(this.config.persistentProfileDir, { recursive: true });
    const lock = await acquireProfileLock(this.config.persistentProfileDir, {
      timeoutMs: this.config.fallbackLockTimeoutMs,
      pollMs: this.config.fallbackLockPollMs,
      orphanMs: this.config.fallbackLockOrphanMs,
    }).catch((error) => {
      throw addFallbackProfileLockHint(error, this.config);
    });

    try {
      const resolvedFallback = resolveFallbackExecutablePath(this.config);
      const context = await patchrightChromium.launchPersistentContext(this.config.persistentProfileDir, {
        headless: this.config.fallbackHeadless,
        executablePath: resolvedFallback.path || undefined,
        channel: resolvedFallback.path ? undefined : this.config.chromeChannel,
        proxy: this.config.proxy,
        viewport: null,
        ignoreHTTPSErrors: true,
        locale: "en-US",
        timezoneId: "America/New_York",
      });

      // Close the initial about:blank page that launchPersistentContext
      // creates automatically — sessions create their own pages via newPage().
      for (const p of context.pages()) {
        await p.close().catch(() => {});
      }

      // If the browser process crashes, invalidate the cached owner so the
      // next session attempt re-launches instead of reusing a dead context.
      context.once("close", () => {
        this.fallbackOwnerPromise = null;
        lock.release().catch(() => {});
      });

      return {
        provider: "patchright",
        context,
        lock,
        close: async () => {
          await context.close().catch(() => {});
          await lock.release().catch(() => {});
        },
      };
    } catch (error) {
      await lock.release().catch(() => {});
      throw error;
    }
  }

  async createCdpFallbackOwner() {
    if (!this.config.cdpUrl) {
      throw new Error("CDP fallback provider requires LUPIN_CDP_URL or options.cdpUrl");
    }

    const browser = await playwright.chromium.connectOverCDP(this.config.cdpUrl, {
      timeout: this.config.cdpConnectTimeoutMs,
    });

    try {
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error(`CDP endpoint ${this.config.cdpUrl} did not expose a default browser context`);
      }

      return {
        provider: "cdp",
        browser,
        context,
        close: async () => {
          await browser.close().catch(() => {});
        },
      };
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }
}
