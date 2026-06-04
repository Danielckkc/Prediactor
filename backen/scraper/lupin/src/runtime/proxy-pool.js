/**
 * Proxy pool with rotation, health tracking, and cooldown.
 *
 * Supports:
 *   - Single proxy (passthrough, no rotation)
 *   - Proxy list with round-robin or random selection
 *   - External rotating gateway (single URL, pool logic bypassed)
 *   - Per-proxy health tracking with exponential-backoff cooldown
 */

const DEFAULT_MAX_FAILS = 5;
const DEFAULT_COOLDOWN_BASE_MS = 30_000;
const DEFAULT_COOLDOWN_MAX_MS = 10 * 60_000;
const PROBE_INTERVAL_MS = 60_000;

/**
 * Parse a proxy string into a Playwright-compatible proxy object.
 *
 * Accepted formats:
 *   - user:pass@host:port          → http://user:pass@host:port
 *   - http://user:pass@host:port
 *   - socks5://host:port
 *   - host:port                    → http://host:port
 *   - { server, username?, password? }  (passthrough)
 */
export function parseProxy(input) {
  if (!input) return null;

  // Already a config object
  if (typeof input === "object" && input.server) {
    return {
      server: input.server,
      username: input.username || undefined,
      password: input.password || undefined,
    };
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // Has scheme → standard URL
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const url = new URL(raw);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`,
      username: decodeURIComponent(url.username) || undefined,
      password: decodeURIComponent(url.password) || undefined,
    };
  }

  // user:pass@host:port  — detect by checking for @ sign
  if (raw.includes("@")) {
    const [credentials, hostPort] = raw.split("@");
    const [username, password] = credentials.split(":");
    return {
      server: `http://${hostPort}`,
      username: username || undefined,
      password: password || undefined,
    };
  }

  // host:port only
  return { server: `http://${raw}`, username: undefined, password: undefined };
}

/**
 * Build a proxy URL string from a parsed proxy object.
 * Used for undici ProxyAgent which needs a URL string.
 */
export function proxyToUrl(proxy) {
  if (!proxy?.server) return null;

  const url = new URL(proxy.server);
  if (proxy.username) url.username = proxy.username;
  if (proxy.password) url.password = proxy.password;
  return url.toString();
}

/**
 * Load proxy list from a file (one proxy per line).
 * Blank lines and lines starting with # are ignored.
 */
export async function loadProxyListFile(filePath) {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseProxy)
    .filter(Boolean);
}

class ProxyEntry {
  constructor(proxy) {
    this.proxy = proxy;
    this.failCount = 0;
    this.successCount = 0;
    this.cooldownUntil = 0;
    this.dead = false;
    this.lastUsedAt = 0;
  }

  get alive() {
    if (this.dead) return false;
    return Date.now() >= this.cooldownUntil;
  }

  recordSuccess() {
    this.failCount = 0;
    this.dead = false;
    this.cooldownUntil = 0;
    this.successCount += 1;
  }

  recordFailure(maxFails, cooldownBaseMs, cooldownMaxMs) {
    this.failCount += 1;
    if (this.failCount >= maxFails) {
      this.dead = true;
      return;
    }
    // Exponential backoff: base * 2^(fails-1), capped at max
    const backoff = Math.min(cooldownBaseMs * 2 ** (this.failCount - 1), cooldownMaxMs);
    this.cooldownUntil = Date.now() + backoff;
  }
}

export class ProxyPool {
  /**
   * @param {object} options
   * @param {Array} options.proxies - Array of proxy strings or objects
   * @param {"round-robin"|"random"|"sticky-domain"} options.strategy - Selection strategy
   * @param {number} options.maxFails - Mark dead after N consecutive failures
   * @param {number} options.cooldownBaseMs - Base cooldown duration
   * @param {number} options.cooldownMaxMs - Max cooldown duration
   */
  constructor(options = {}) {
    const proxies = options.proxies || [];
    this.entries = proxies.map((p) => new ProxyEntry(typeof p === "string" ? parseProxy(p) : p));
    this.strategy = options.strategy || "round-robin";
    this.maxFails = options.maxFails ?? DEFAULT_MAX_FAILS;
    this.cooldownBaseMs = options.cooldownBaseMs ?? DEFAULT_COOLDOWN_BASE_MS;
    this.cooldownMaxMs = options.cooldownMaxMs ?? DEFAULT_COOLDOWN_MAX_MS;
    this.roundRobinIndex = 0;
    this.lastProbeAt = Date.now();
    // domain → entryIndex mapping for sticky-domain strategy
    this.domainAssignments = new Map();
  }

  get size() {
    return this.entries.length;
  }

  get hasProxies() {
    return this.entries.length > 0;
  }

  /**
   * Get the next available proxy. Returns null if pool is empty or all proxies
   * are dead/in cooldown.
   *
   * @param {string} [domain] - Target domain (used by sticky-domain strategy)
   * @returns {{ proxy: object, entryIndex: number } | null}
   */
  next(domain) {
    if (!this.hasProxies) return null;

    // Periodically probe dead proxies to allow resurrection
    this.probeDeadEntries();

    const alive = this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.alive);

    if (alive.length === 0) return null;

    let selected;

    if (this.strategy === "sticky-domain" && domain) {
      // Check if this domain already has a sticky assignment
      const assignedIndex = this.domainAssignments.get(domain);
      if (assignedIndex != null) {
        const assigned = alive.find(({ index }) => index === assignedIndex);
        if (assigned) {
          // Sticky proxy is still alive — reuse it
          assigned.entry.lastUsedAt = Date.now();
          return { proxy: assigned.entry.proxy, entryIndex: assigned.index };
        }
        // Sticky proxy died — fall through to assign a new one
        this.domainAssignments.delete(domain);
      }

      // Assign via round-robin, then pin it
      selected = this.selectRoundRobin(alive);
      this.domainAssignments.set(domain, selected.index);
    } else if (this.strategy === "random") {
      selected = alive[Math.floor(Math.random() * alive.length)];
    } else {
      // round-robin (default) and sticky-domain without a domain
      selected = this.selectRoundRobin(alive);
    }

    selected.entry.lastUsedAt = Date.now();
    return { proxy: selected.entry.proxy, entryIndex: selected.index };
  }

  selectRoundRobin(alive) {
    for (let i = 0; i < this.entries.length; i++) {
      const candidateIndex = (this.roundRobinIndex + i) % this.entries.length;
      const candidate = alive.find(({ index }) => index === candidateIndex);
      if (candidate) {
        this.roundRobinIndex = (candidateIndex + 1) % this.entries.length;
        return candidate;
      }
    }
    return alive[0];
  }

  /**
   * Record a successful request through a proxy.
   */
  recordSuccess(entryIndex) {
    const entry = this.entries[entryIndex];
    if (entry) entry.recordSuccess();
  }

  /**
   * Record a failed request through a proxy.
   */
  recordFailure(entryIndex) {
    const entry = this.entries[entryIndex];
    if (entry) entry.recordFailure(this.maxFails, this.cooldownBaseMs, this.cooldownMaxMs);
  }

  /**
   * Periodically reset dead entries so they can be probed again.
   */
  probeDeadEntries() {
    const now = Date.now();
    if (now - this.lastProbeAt < PROBE_INTERVAL_MS) return;
    this.lastProbeAt = now;

    for (const entry of this.entries) {
      if (entry.dead) {
        entry.dead = false;
        entry.failCount = 0;
        entry.cooldownUntil = 0;
      }
    }
  }

  /**
   * Get pool status for diagnostics.
   */
  status() {
    return this.entries.map((entry, index) => ({
      index,
      server: entry.proxy.server,
      alive: entry.alive,
      dead: entry.dead,
      failCount: entry.failCount,
      successCount: entry.successCount,
      cooldownUntil: entry.cooldownUntil,
    }));
  }
}

/**
 * Create a ProxyPool from runtime config.
 * Returns null if no proxies are configured.
 */
export function createProxyPool(config) {
  const proxies = [];

  // Collect from proxyList (array of proxy strings/objects)
  if (Array.isArray(config.proxyList) && config.proxyList.length > 0) {
    for (const p of config.proxyList) {
      const parsed = typeof p === "string" ? parseProxy(p) : p;
      if (parsed) proxies.push(parsed);
    }
  }

  // If no list but single proxy configured, use it as a 1-entry pool
  if (proxies.length === 0 && config.proxy) {
    const parsed = typeof config.proxy === "string" ? parseProxy(config.proxy) : config.proxy;
    if (parsed) proxies.push(parsed);
  }

  if (proxies.length === 0) return null;

  return new ProxyPool({
    proxies,
    strategy: config.proxyStrategy || "round-robin",
    maxFails: config.proxyMaxFails,
    cooldownBaseMs: config.proxyCooldownBaseMs,
    cooldownMaxMs: config.proxyCooldownMaxMs,
  });
}
