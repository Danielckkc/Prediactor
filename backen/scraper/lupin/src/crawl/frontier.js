// src/crawl/frontier.js

function normalizeUrl(url, ignoreQueryParams = false) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  if (ignoreQueryParams) {
    parsed.search = "";
  } else if (parsed.search) {
    const params = new URLSearchParams(parsed.searchParams);
    params.sort();
    parsed.search = params.toString();
  }
  let normalized = parsed.toString();
  if (parsed.pathname !== "/" && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export class Frontier {
  constructor(options = {}) {
    this.maxDepth = options.maxDepth ?? Infinity;
    this.maxUrls = options.maxUrls ?? Infinity;
    this.ignoreQueryParams = options.ignoreQueryParams ?? false;
    this._visited = new Set();
    this._queue = [];
  }

  enqueue(url, depth) {
    if (depth > this.maxDepth) return false;
    if (this._visited.size >= this.maxUrls) return false;
    const key = normalizeUrl(url, this.ignoreQueryParams);
    if (this._visited.has(key)) return false;
    this._visited.add(key);
    this._queue.push({ url, depth });
    return true;
  }

  dequeue() {
    return this._queue.shift() || null;
  }

  get size() { return this._visited.size; }
  get visitedCount() { return this._visited.size; }
  get pending() { return this._queue.length; }
  get visitedUrls() { return Array.from(this._visited); }
}
