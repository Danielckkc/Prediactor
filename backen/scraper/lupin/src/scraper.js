import fs from "node:fs/promises";
import path from "node:path";

import { getScopedCookies } from "./cookies.js";
import {
  dismissPopups,
  extractVisibleText,
  scrollPage,
  waitForContent,
} from "./extractors.js";
import { fetchHttpAttempt, createProxyDispatcher } from "./http.js";
import { analyzeAttempt, normalizeHost } from "./detection.js";
import { acquireProfileLock } from "./profile-lock.js";
import { BrowserManager } from "./runtime/browser-manager.js";
import { createRuntimeConfig, normalizeEngineName } from "./runtime/config.js";
import { createProxyPool, proxyToUrl } from "./runtime/proxy-pool.js";
import { preparePageForScreenshot, takeScreenshot, attachScreenshot } from "./runtime/screenshot.js";

class DomainMemory {
  constructor(filePath, ttlMs) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
  }

  async readEntries() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return new Map(Object.entries(parsed.entries || {}));
    } catch (error) {
      if (error?.code === "ENOENT") return new Map();
      throw error;
    }
  }

  async writeEntries(entries) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const payload = {
      version: 1,
      entries: Object.fromEntries(entries.entries()),
    };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2));
    await fs.rename(tempPath, this.filePath);
  }

  isExpired(entry) {
    return Number.isFinite(entry?.updatedAt) && Date.now() - entry.updatedAt > this.ttlMs;
  }

  async withWriteLock(mutator) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const lock = await acquireProfileLock(this.filePath, {
      timeoutMs: 5000,
      pollMs: 50,
      orphanMs: 30000,
    });

    try {
      const entries = await this.readEntries();
      const result = await mutator(entries);
      if (result?.write !== false) {
        await this.writeEntries(entries);
      }
      return result?.value;
    } finally {
      await lock.release().catch(() => {});
    }
  }

  async get(host) {
    const entries = await this.readEntries();
    const entry = entries.get(host);
    if (!entry) return null;
    if (!this.isExpired(entry)) return entry;

    return this.withWriteLock(async (lockedEntries) => {
      const current = lockedEntries.get(host);
      if (!current) {
        return { write: false, value: null };
      }
      if (!this.isExpired(current)) {
        return { write: false, value: current };
      }
      lockedEntries.delete(host);
      return { value: null };
    });
  }

  async set(host, preferredStage, meta = {}) {
    await this.withWriteLock(async (entries) => {
      const previous = entries.get(host);
      entries.set(host, {
        engine: preferredStage,
        preferredStage,
        updatedAt: Date.now(),
        successCount: (previous?.successCount || 0) + 1,
        failureCount: previous?.failureCount || 0,
        lastReason: meta.reason || null,
        lastConfidence: meta.confidence || null,
      });

      return { value: undefined };
    });
  }

  async noteFailure(host, reason) {
    await this.withWriteLock(async (entries) => {
      const previous = entries.get(host);
      if (!previous) {
        return { write: false, value: undefined };
      }

      entries.set(host, {
        ...previous,
        failureCount: (previous.failureCount || 0) + 1,
        lastFailureAt: Date.now(),
        lastReason: reason || previous.lastReason || null,
      });

      return { value: undefined };
    });
  }
}

function createFailedAttempt(engine, url, attemptIndex, error) {
  return {
    engine,
    attempt: attemptIndex + 1,
    ok: false,
    blocked: false,
    confidence: "low",
    text: "",
    textLength: 0,
    title: "",
    status: 0,
    url,
    warnings: [],
    mitigation: null,
    reason: error?.message || String(error),
  };
}

export class ScrapeFailedError extends Error {
  constructor(message, attempts, failure = null) {
    super(message);
    this.name = "ScrapeFailedError";
    this.attempts = attempts;
    this.failure = failure;
  }
}

export function summarizeFailureAttempts(attempts) {
  const blockedAttempts = attempts.filter((attempt) => attempt.blocked);
  const errorAttempts = attempts.filter((attempt) => !attempt.blocked && attempt.reason);
  const lastErrorAttempt = errorAttempts[errorAttempts.length - 1];

  if (blockedAttempts.length === 0) {
    return {
      reason: lastErrorAttempt?.reason || "no usable content extracted",
      blockedBy: null,
      failedBy: lastErrorAttempt
        ? {
            engine: lastErrorAttempt.engine,
            attempt: lastErrorAttempt.attempt,
            reason: lastErrorAttempt.reason,
          }
        : null,
    };
  }

  const mitigations = blockedAttempts.map((attempt) => attempt.mitigation).filter(Boolean);
  if (mitigations.length === blockedAttempts.length) {
    const [first] = mitigations;
    const sameMitigation = mitigations.every(
      (candidate) => candidate.provider === first.provider && candidate.kind === first.kind
    );

    if (sameMitigation) {
      return {
        reason: `blocked by ${first.provider} ${first.kind} on all attempts`,
        blockedBy: {
          provider: first.provider,
          kind: first.kind,
          confidence: first.confidence,
          signals: Array.from(new Set(mitigations.flatMap((candidate) => candidate.signals || []))),
        },
        failedBy: lastErrorAttempt
          ? {
              engine: lastErrorAttempt.engine,
              attempt: lastErrorAttempt.attempt,
              reason: lastErrorAttempt.reason,
            }
          : null,
      };
    }
  }

  // Prefer browser-stage failures over HTTP JS shell reasons — the HTTP engine
  // correctly flags SPAs as JS shells, but the browser failure reason (timeout,
  // WAF block, etc.) is what actually prevented content extraction.
  const isHttpJsShell = (attempt) =>
    attempt.engine === "http" && attempt.reason?.startsWith("JS shell detected");
  const browserAttempts = blockedAttempts.filter((a) => !isHttpJsShell(a));

  const strongestAttempt =
    blockedAttempts.find((attempt) => attempt.mitigation?.confidence === "high") ||
    (browserAttempts.length > 0 ? browserAttempts[browserAttempts.length - 1] : null) ||
    blockedAttempts[blockedAttempts.length - 1];

  return {
    reason: strongestAttempt.reason || "no usable content extracted",
    blockedBy: strongestAttempt.mitigation || null,
    failedBy: lastErrorAttempt
      ? {
          engine: lastErrorAttempt.engine,
          attempt: lastErrorAttempt.attempt,
          reason: lastErrorAttempt.reason,
        }
      : null,
  };
}

export class Lupin {
  constructor(options = {}) {
    const { stateDir, config } = createRuntimeConfig(options);
    this.stateDir = stateDir;
    this.domainMemory = new DomainMemory(
      options.domainMemoryPath || path.join(this.stateDir, "domain-memory.json"),
      options.domainTtlMs || Number(process.env.LUPIN_DOMAIN_TTL_MS || 24 * 60 * 60 * 1000)
    );
    this.config = config;
    this.browserManager = options.browserManager || new BrowserManager({ ...options, config });
    // Share a single proxy pool: prefer explicit, then browser manager's, then create new
    this.proxyPool = options.proxyPool || this.browserManager.proxyPool || createProxyPool(config);
  }

  get fallbackOwnerPromise() {
    return this.browserManager.fallbackOwnerPromise;
  }

  set fallbackOwnerPromise(value) {
    this.browserManager.fallbackOwnerPromise = value;
  }

  async scrape(url, options = {}) {
    const host = normalizeHost(url);
    const routing = await this.resolveRouting(host, normalizeEngineName(options.engine, "auto"));

    // Screenshots require a live browser page — HTTP engine can't produce one.
    // Skip HTTP when screenshot is requested to guarantee a browser is used.
    if (options.screenshot) {
      routing.engines = routing.engines.filter((e) => e !== "http");
      if (routing.engines.length === 0) {
        routing.engines = ["fallback"];
      }
    }

    const attempts = [];

    for (const engine of routing.engines) {
      const results = await this.runEngineWithRetries(engine, url, options, host);
      for (const result of results) {
        attempts.push(result);
        if (result.ok) {
          if (routing.mode === "auto" && engine !== "http") {
            await this.domainMemory.set(host, engine, {
              reason: result.reason,
              confidence: result.confidence,
            });
          }
          const { rawHtml: successHtml, ...publicResult } = result;
          const scrapeResult = {
            ...publicResult,
            engine,
            hostname: host,
            routedBy: routing.mode,
            attempts: attempts.map(({ text, rawHtml: _h, ...rest }) => rest),
          };
          // Attach rawHtml as non-enumerable so internal callers (web/fetch.js) can
          // access it for markdown conversion, but it won't appear in JSON.stringify
          // or MCP serialization.
          Object.defineProperty(scrapeResult, "rawHtml", { value: successHtml || null, enumerable: false });
          // Forward screenshot buffer from the successful attempt
          if (result.screenshotBuffer) {
            attachScreenshot(scrapeResult, {
              buffer: result.screenshotBuffer,
              mimeType: result.screenshotMimeType,
              format: result.screenshotFormat,
            });
          }
          return scrapeResult;
        }
      }
    }

    const bestAttempt = attempts
      .slice()
      .sort((left, right) => right.textLength - left.textLength)[0];

    const failure = summarizeFailureAttempts(attempts);
    await this.domainMemory
      .noteFailure(host, failure.reason || bestAttempt?.reason || "no usable content")
      .catch(() => {});
    throw new ScrapeFailedError(
      `Unable to extract usable content from ${url} (${failure.reason})`,
      attempts.map(({ text: _t, rawHtml: _h, ...rest }) => rest),
      failure
    );
  }

  /**
   * Proxy-aware fetch. Drop-in replacement for global fetch() that routes
   * through the proxy pool when configured. Providers should use this
   * instead of bare fetch() so that --proxy / --proxy-list applies to
   * API-backed requests (HN, Reddit, YouTube, Polymarket, etc.).
   */
  async fetch(url, options = {}) {
    const proxyUrl = this.getProxyUrl();
    if (proxyUrl) {
      const dispatcher = createProxyDispatcher(proxyUrl);
      return fetch(url, { ...options, dispatcher });
    }
    return fetch(url, options);
  }

  getProxyUrl() {
    if (this.proxyPool) {
      const selected = this.proxyPool.next();
      if (selected) return proxyToUrl(selected.proxy);
    }
    if (this.config.proxy) return proxyToUrl(this.config.proxy);
    return null;
  }

  async close() {
    await this.browserManager.close();
  }

  async getFallbackOwner() {
    return this.browserManager.getFallbackOwner();
  }

  async resolveRouting(host, mode) {
    const normalizedMode = normalizeEngineName(mode, "auto");

    if (normalizedMode !== "auto") {
      return { mode: normalizedMode, engines: [normalizedMode] };
    }

    const remembered = await this.domainMemory.get(host);
    const preferred = normalizeEngineName(remembered?.preferredStage || remembered?.engine, "");

    if (preferred === "fallback") {
      return { mode: normalizedMode, engines: ["fallback"] };
    }

    if (preferred === "camoufox") {
      return { mode: normalizedMode, engines: ["camoufox", "fallback"] };
    }

    return { mode: normalizedMode, engines: ["http", "camoufox", "fallback"] };
  }

  async runEngineWithRetries(engine, url, options, host) {
    const attempts = [];
    const retries = this.getRetriesForEngine(engine);

    for (let index = 0; index < retries; index += 1) {
      const result = await this.runSingleAttempt(engine, url, options, index, host);
      attempts.push(result);
      if (result.ok) {
        return attempts;
      }
      if (index < retries - 1 && engine !== "http") {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return attempts;
  }

  getRetriesForEngine(engine) {
    switch (engine) {
      case "camoufox":
        return this.config.camoufoxRetries;
      case "fallback":
        return this.config.fallbackRetries;
      default:
        return 1;
    }
  }

  acquireProxy(domain) {
    if (!this.proxyPool) return { proxy: this.config.proxy || null, entryIndex: -1 };
    const selected = this.proxyPool.next(domain);
    if (!selected) {
      throw new Error("All proxies exhausted (dead or in cooldown). Refusing to proceed without proxy.");
    }
    return selected;
  }

  recordProxyResult(entryIndex, ok) {
    if (!this.proxyPool || entryIndex < 0) return;
    if (ok) {
      this.proxyPool.recordSuccess(entryIndex);
    } else {
      this.proxyPool.recordFailure(entryIndex);
    }
  }

  async runSingleAttempt(engine, url, options, attemptIndex, host) {
    let proxy, entryIndex;
    try {
      ({ proxy, entryIndex } = this.acquireProxy(host));
    } catch (error) {
      return createFailedAttempt(engine, url, attemptIndex, error);
    }

    let result;
    switch (engine) {
      case "http":
        result = await this.runHttpAttempt(url, options, attemptIndex, proxy);
        break;
      case "camoufox":
        result = await this.runCamoufoxStage(url, options, attemptIndex, proxy);
        break;
      case "fallback":
        result = await this.runFallbackAttempt(url, options, attemptIndex, proxy);
        break;
      default:
        result = {
          engine,
          attempt: attemptIndex + 1,
          ok: false,
          blocked: false,
          confidence: "low",
          text: "",
          textLength: 0,
          title: "",
          status: 0,
          url,
          warnings: [],
          reason: `Unsupported engine: ${engine}`,
        };
    }

    this.recordProxyResult(entryIndex, result.ok);
    if (proxy) {
      result.proxyServer = proxy.server;
    }

    // If a WAF challenge was detected, wipe the persistent fallback profile
    // so poisoned cookies don't carry over to future sessions.
    if (result.mitigation) {
      await this.browserManager.wipePersistentProfiles().catch(() => {});
    }

    return result;
  }

  async runHttpAttempt(url, options, attemptIndex, proxy) {
    const timeout = options.timeout || this.config.httpTimeoutMs;

    try {
      const httpResult = await fetchHttpAttempt(url, {
        timeout,
        caBundlePath: this.config.httpCaBundlePath,
        useSystemCa: this.config.httpUseSystemCa,
        userAgent: this.config.httpUserAgent,
        proxyUrl: proxy ? proxyToUrl(proxy) : undefined,
      });
      return {
        engine: "http",
        attempt: attemptIndex + 1,
        rawHtml: httpResult.rawHtml || null,
        ...analyzeAttempt(httpResult),
      };
    } catch (error) {
      return createFailedAttempt("http", url, attemptIndex, error);
    }
  }

  async runCamoufoxStage(url, options, attemptIndex, proxy) {
    const extractor = options.extractor || extractVisibleText;
    const timeout = options.timeout || this.config.camoufoxTimeoutMs;
    let session = null;

    try {
      session = await this.browserManager.openSession({ engine: "camoufox", timeout, proxy });
      const page = session.page;
      await preparePageForScreenshot(page, options);

      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      }).catch(() => null);

      await waitForContent(page, { waitFor: options.waitFor });
      await dismissPopups(page);
      await scrollPage(page);

      const screenshotResult = await takeScreenshot(page, options);

      const finalUrl = page.url();
      const [title, text, rawHtml, headers, cookies, scriptUrls] = await Promise.all([
        page.title().catch(() => ""),
        Promise.resolve(extractor(page)),
        page.content().catch(() => ""),
        response?.allHeaders().catch(() => ({})) ?? {},
        getScopedCookies(page.context(), finalUrl),
        page.evaluate(() => Array.from(document.scripts).map((script) => script.src).filter(Boolean)).catch(() => []),
      ]);
      const frameUrls = page.frames().map((frame) => frame.url()).filter(Boolean);

      const attempt = {
        engine: "camoufox",
        attempt: attemptIndex + 1,
        rawHtml: rawHtml || null,
        ...analyzeAttempt({
          status: response?.status() ?? 0,
          title,
          text,
          rawHtml,
          url: finalUrl,
          headers,
          cookies,
          frameUrls,
          scriptUrls,
          browserRendered: true,
        }),
      };
      attachScreenshot(attempt, screenshotResult);
      return attempt;
    } catch (error) {
      return createFailedAttempt("camoufox", url, attemptIndex, error);
    } finally {
      if (session) {
        await session.close().catch(() => {});
      }
    }
  }

  async runFallbackAttempt(url, options, attemptIndex, proxy) {
    const extractor = options.extractor || extractVisibleText;
    const waitFor = options.waitFor;
    const timeout = options.timeout || this.config.fallbackTimeoutMs;
    let session = null;
    let page = null;

    try {
      session = await this.browserManager.openSession({ engine: "fallback", timeout, proxy, ephemeral: true });
      page = session.page;
      await preparePageForScreenshot(page, options);
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      }).catch(() => null);

      await waitForContent(page, { waitFor });
      await dismissPopups(page);
      await scrollPage(page);

      const screenshotResult = await takeScreenshot(page, options);

      const finalUrl = page.url();
      const [title, text, rawHtml, headers, cookies, scriptUrls] = await Promise.all([
        page.title().catch(() => ""),
        Promise.resolve(extractor(page)),
        page.content().catch(() => ""),
        response?.allHeaders().catch(() => ({})) ?? {},
        getScopedCookies(page.context(), finalUrl),
        page
          .evaluate(() => Array.from(document.scripts).map((script) => script.src).filter(Boolean))
          .catch(() => []),
      ]);
      const frameUrls = page.frames().map((frame) => frame.url()).filter(Boolean);

      const attempt = {
        engine: "fallback",
        attempt: attemptIndex + 1,
        rawHtml: rawHtml || null,
        ...analyzeAttempt({
          status: response?.status() ?? 0,
          title,
          text,
          rawHtml,
          url: finalUrl,
          headers,
          cookies,
          frameUrls,
          scriptUrls,
          browserRendered: true,
        }),
      };
      attachScreenshot(attempt, screenshotResult);
      return attempt;
    } catch (error) {
      return createFailedAttempt("fallback", url, attemptIndex, error);
    } finally {
      if (session) {
        await session.close().catch(() => {});
      }
    }
  }
}

export async function createLupin(options = {}) {
  return new Lupin(options);
}

export async function scrapePage(url, options = {}) {
  const scraper = new Lupin(options.scraper);
  try {
    return await scraper.scrape(url, options);
  } finally {
    await scraper.close();
  }
}
