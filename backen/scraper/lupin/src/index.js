export { Lupin, ScrapeFailedError, createLupin, scrapePage } from "./scraper.js";
export { analyzeAttempt, detectMitigation, normalizeHost } from "./detection.js";
export { DEFAULT_DISMISS_SELECTORS, dismissPopups, extractVisibleText, trimText } from "./extractors.js";
export { acquireProfileLock } from "./profile-lock.js";
export { BrowserManager } from "./runtime/browser-manager.js";
export { BrowserSessionStore } from "./runtime/session-store.js";
export { ProxyPool, createProxyPool, parseProxy, loadProxyListFile } from "./runtime/proxy-pool.js";
export { CrawlSession } from "./crawl/crawler.js";
