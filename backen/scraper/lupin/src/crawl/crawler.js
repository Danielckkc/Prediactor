// src/crawl/crawler.js

import { Lupin } from "../scraper.js";
import { BrowserManager } from "../runtime/browser-manager.js";
import { fetchHttpAttempt, createProxyDispatcher } from "../http.js";
import { htmlToMarkdown, buildScrapeMarkdown } from "../runtime/markdown.js";
import { proxyToUrl } from "../runtime/proxy-pool.js";
import { createScopeChecker } from "./scope.js";
import { Frontier } from "./frontier.js";
import { extractLinks } from "./discovery.js";
import { fetchRobotsTxt, fetchSitemap } from "./sitemap.js";
import { CrawlOutputWriter } from "./output.js";
import { run as runLlm } from "../llm/index.js";
import { LlmConfigError } from "../llm/errors.js";
import { resolveProvider } from "../llm/provider.js";

/**
 * Build a result entry from a successful scrape, formatted per the requested output format.
 */
export function formatCrawlResult(result, entry, format) {
  const rawHtml = result.rawHtml || null;
  const base = { url: result.url, title: result.title, depth: entry.depth, engine: result.engine, status: result.status };

  if (format === "markdown") {
    const markdown = buildScrapeMarkdown(result);
    return { data: { ...base, content: markdown }, rawHtml };
  }
  if (format === "html") {
    return { data: { ...base, content: rawHtml || "" }, rawHtml };
  }
  return { data: { ...base, text: result.text }, rawHtml };
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this._waiters = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise((resolve) => this._waiters.push(resolve));
    // Slot was handed off by release() — already counted, don't increment
  }
  release() {
    if (this._waiters.length > 0) {
      // Hand off the slot directly to the next waiter
      this._waiters.shift()();
    } else {
      this.current--;
    }
  }
}

export class CrawlSession {
  constructor(options) {
    this.startUrl = options.url;
    this.mode = options.mode || "crawl";
    this.depth = options.depth ?? 3;
    this.limit = options.limit ?? 100;
    this.scope = options.scope || "same-hostname";
    this.include = options.include || [];
    this.exclude = options.exclude || [];
    this.format = options.format || "json";
    this.outputFile = options.outputFile || null;
    this.outputFormat = options.outputFormat || "json";
    this.concurrency = Math.max(1, Number(options.concurrency) || 3);
    this.delay = options.delay ?? 0;
    this.respectRobots = options.respectRobots ?? true;
    this.useSitemap = options.useSitemap ?? true;
    this.ignoreQueryParams = options.ignoreQueryParams ?? false;
    this.engine = options.engine || "auto";
    this.onProgress = options.onProgress || null;
    this.onLlmProgress = options.onLlmProgress || null;
    // LLM extraction options
    this.extract = options.extract || undefined;
    this.schema = options.schema || undefined;
    this.llm = options.llm || undefined;
    this.llmTimeout = options.llmTimeout || undefined;
    this.stateDir = options.stateDir || undefined;
    this._scraper = options.scraper || null;
    this._scraperOptions = options.scraperOptions || {};
    this._ownsScraper = false;
    this._robotsRules = null;
    // Allow a modest amount of parallel LLM work during crawls.
    this._llmMutex = this._createLlmSemaphore();
  }

  async run() {
    const scopeChecker = createScopeChecker(this.startUrl, {
      scope: this.scope,
      include: this.include.length ? this.include : undefined,
      exclude: this.exclude.length ? this.exclude : undefined,
    });

    const frontier = new Frontier({
      maxDepth: this.depth,
      maxUrls: this.limit,
      ignoreQueryParams: this.ignoreQueryParams,
    });

    frontier.enqueue(this.startUrl, 0);

    if (this.respectRobots || this.useSitemap) {
      try {
        const fetchOpts = this._getFetchOptions();
        this._robotsRules = await fetchRobotsTxt(this.startUrl, fetchOpts);
        if (this.useSitemap) {
          const sitemapUrls = this._robotsRules.sitemaps.length
            ? this._robotsRules.sitemaps
            : [new URL("/sitemap.xml", this.startUrl).toString()];
          for (const sitemapUrl of sitemapUrls) {
            const urls = await fetchSitemap(sitemapUrl, fetchOpts);
            for (const url of urls) {
              if (scopeChecker(url) && this._isAllowedByRobots(url)) {
                frontier.enqueue(url, 1);
              }
            }
          }
        }
      } catch {
        // robots.txt / sitemap fetch failure is non-fatal
      }
    }

    if (this.mode === "map") return this._runMap(frontier, scopeChecker);
    return this._runCrawl(frontier, scopeChecker);
  }

  _isAllowedByRobots(url) {
    if (!this.respectRobots || !this._robotsRules) return true;
    const pathname = new URL(url).pathname;

    // RFC 9309: longest matching prefix wins
    let bestMatch = null;
    let bestLen = -1;

    for (const allowed of this._robotsRules.allow) {
      if (pathname.startsWith(allowed) && allowed.length > bestLen) {
        bestMatch = "allow";
        bestLen = allowed.length;
      }
    }
    for (const disallowed of this._robotsRules.disallow) {
      if (pathname.startsWith(disallowed) && disallowed.length > bestLen) {
        bestMatch = "disallow";
        bestLen = disallowed.length;
      }
    }

    if (bestMatch === "disallow") return false;
    return true;
  }

  async _runMap(frontier, scopeChecker) {
    const urls = [];
    let processed = 0;

    while (frontier.pending > 0) {
      const entry = frontier.dequeue();
      if (!entry) break;
      urls.push(entry.url);
      processed++;
      if (this.onProgress) this.onProgress(processed, frontier.size, entry.url, true);

      try {
        const result = await fetchHttpAttempt(entry.url, { timeout: 10000 });
        if (result.rawHtml) {
          const links = extractLinks(result.rawHtml, result.url || entry.url);
          for (const link of links) {
            if (scopeChecker(link) && this._isAllowedByRobots(link)) {
              frontier.enqueue(link, entry.depth + 1);
            }
          }
        }
      } catch {
        // HTTP fetch failure during map is non-fatal
      }

      if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
    }

    return {
      urls,
      summary: { total: urls.length, depth: this.depth, scope: this.scope },
    };
  }

  async _runCrawl(frontier, scopeChecker) {
    const scraper = this._getOrCreateScraper();
    const semaphore = new Semaphore(this.concurrency);
    const writer = new CrawlOutputWriter(this.outputFile, { format: this.outputFormat });
    await writer.open();

    let succeeded = 0;
    let failed = 0;
    const failures = [];
    const errorCounts = {};
    let consecutiveFailures = 0;
    let processed = 0;
    const inFlight = new Set();

    const processEntry = async (entry) => {
      await semaphore.acquire();
      try {
        const pageResult = await this._scrapeSinglePage(scraper, entry);
        if (pageResult.ok) {
          await writer.write(pageResult.data);
          succeeded++;
          consecutiveFailures = 0;
          if (pageResult.rawHtml) {
            const links = extractLinks(pageResult.rawHtml, pageResult.data.url || entry.url);
            for (const link of links) {
              if (scopeChecker(link) && this._isAllowedByRobots(link)) {
                frontier.enqueue(link, entry.depth + 1);
              }
            }
          }
        } else {
          await writer.write(pageResult.data);
          failed++;
          consecutiveFailures++;
          failures.push(entry.url);
          const reason = pageResult.data.reason || "unknown";
          errorCounts[reason] = (errorCounts[reason] || 0) + 1;
        }
        processed++;
        if (this.onProgress) this.onProgress(processed, frontier.size, entry.url, pageResult.ok);
        if (consecutiveFailures >= 5 && this.delay === 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
      } finally {
        semaphore.release();
      }
    };

    let fatalError = null;
    let results;
    try {
      while (frontier.pending > 0 || inFlight.size > 0) {
        while (frontier.pending > 0 && inFlight.size < this.concurrency) {
          const entry = frontier.dequeue();
          if (!entry) break;
          const promise = processEntry(entry).then(
            () => { inFlight.delete(promise); },
            (err) => { inFlight.delete(promise); fatalError = err; },
          );
          inFlight.add(promise);
        }
        if (inFlight.size > 0) await Promise.race([...inFlight]);
        if (fatalError) break;
      }
    } finally {
      // Drain remaining in-flight work before closing the writer
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      results = await writer.close();
    }

    if (fatalError) throw fatalError;

    return {
      results: results || undefined,
      summary: { total: succeeded + failed, succeeded, failed, errorBreakdown: errorCounts },
      failures: failures.length ? failures : undefined,
    };
  }

  async _scrapeSinglePage(scraper, entry) {
    try {
      const result = await scraper.scrape(entry.url, { engine: this.engine });
      const { data, rawHtml } = formatCrawlResult(result, entry, this.format);

      const hasLlm = Boolean(this.extract || this.schema);
      if (hasLlm) {
        // Keep LLM concurrency bounded during crawls.
        await this._llmMutex.acquire();
        try {
          if (this.onLlmProgress) this.onLlmProgress(entry.url);
          const llmInput = buildScrapeMarkdown(result);
          const llmStartMs = Date.now();
          try {
            const llmResult = await runLlm(llmInput, {
              prompt: this.extract,
              schema: this.schema,
              llm: this.llm,
              stateDir: this.stateDir,
              timeoutMs: this.llmTimeout,
            });
            data.content = llmResult.result;
            data.llm = {
              model: llmResult.model,
              provider: llmResult.provider,
              prompt: this.extract || undefined,
              durationMs: llmResult.durationMs,
            };
          } catch (error) {
            if (error instanceof LlmConfigError) throw error;
            data.content = null;
            data.llm = {
              model: null,
              provider: null,
              error: error.message,
              durationMs: Date.now() - llmStartMs,
            };
          }
        } finally {
          this._llmMutex.release();
        }
      }

      return { ok: true, data, rawHtml };
    } catch (error) {
      if (error instanceof LlmConfigError) throw error;
      return {
        ok: false,
        data: {
          url: entry.url,
          depth: entry.depth,
          error: error.failure?.reason || error.message || "scrape failed",
          reason: error.failure?.blockedBy?.provider
            ? `${error.failure.blockedBy.provider} ${error.failure.blockedBy.kind}`
            : error.failure?.reason || error.message || "unknown",
        },
        rawHtml: null,
      };
    }
  }

  _getFetchOptions() {
    const opts = {};
    // Route through proxy if configured
    const proxyConfig = this._scraperOptions?.proxy;
    if (proxyConfig) {
      opts.dispatcher = createProxyDispatcher(proxyToUrl(proxyConfig));
    }
    return opts;
  }

  _getOrCreateScraper() {
    if (this._scraper) return this._scraper;
    const browserManager = new BrowserManager(this._scraperOptions);
    this._scraper = new Lupin({
      browserManager,
      config: browserManager.config,
      stateDir: browserManager.stateDir,
      ...this._scraperOptions,
    });
    this._ownsScraper = true;
    return this._scraper;
  }

  _createLlmSemaphore() {
    const hasLlm = Boolean(this.extract || this.schema);
    if (!hasLlm) return new Semaphore(1);
    try {
      resolveProvider({ stateDir: this.stateDir, llm: this.llm });
      return new Semaphore(10);
    } catch {
      // Config resolution can fail here (missing provider, etc.) — defer the error
      // to the actual LLM call where it will produce a proper error message.
      return new Semaphore(1);
    }
  }

  async close() {
    if (this._ownsScraper && this._scraper) {
      await this._scraper.close();
    }
  }
}
