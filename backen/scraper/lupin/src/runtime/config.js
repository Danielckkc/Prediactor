import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_HTTP_USER_AGENT } from "../http.js";

export function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

export function resolveStateDir(stateDir) {
  return stateDir || process.env.LUPIN_STATE_DIR || path.join(os.homedir(), ".lupin");
}

export function normalizeProviderName(value, fallback) {
  return String(value || fallback || "").trim().toLowerCase();
}

export function normalizeEngineName(value, fallback) {
  const normalized = String(value || fallback || "").trim().toLowerCase();
  if (normalized === "fast") return "http";
  if (normalized === "patchright") return "fallback";
  return normalized;
}

export function getProxyFromEnv() {
  const server = process.env.LUPIN_PROXY_SERVER;
  if (!server) return undefined;

  return {
    server,
    username: process.env.LUPIN_PROXY_USERNAME || undefined,
    password: process.env.LUPIN_PROXY_PASSWORD || undefined,
  };
}

export function getProxyListFromEnv() {
  const raw = process.env.LUPIN_PROXY_LIST;
  if (!raw) return undefined;

  // Comma-separated list of proxy URLs
  if (raw.includes(",")) {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Check if it looks like a proxy string (has @ for auth, or scheme://, or ip:port)
  const looksLikeProxy = trimmed.includes("@") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^\d+\.\d+\.\d+\.\d+:\d+$/.test(trimmed);
  if (looksLikeProxy) {
    return [trimmed];
  }

  // Treat as file path — load synchronously so constructors can stay sync
  try {
    const content = fs.readFileSync(trimmed, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    // File not found or unreadable — treat the value as a single proxy URL
    return [trimmed];
  }
}

export function createRuntimeConfig(options = {}) {
  const stateDir = resolveStateDir(options.stateDir);
  if (options.config) {
    return {
      stateDir,
      config: options.config,
    };
  }

  return {
    stateDir,
    config: {
      chromeChannel: options.chromeChannel || process.env.LUPIN_CHROME_CHANNEL || "chrome",
      executablePath: options.executablePath || process.env.LUPIN_EXECUTABLE_PATH || undefined,
      proxy: options.proxy || getProxyFromEnv(),
      proxyList: options.proxyList || getProxyListFromEnv(),
      proxyStrategy: options.proxyStrategy || process.env.LUPIN_PROXY_STRATEGY || "round-robin",
      proxyMaxFails: options.proxyMaxFails || Number(process.env.LUPIN_PROXY_MAX_FAILS || 5),
      proxyCooldownBaseMs:
        options.proxyCooldownBaseMs || Number(process.env.LUPIN_PROXY_COOLDOWN_BASE_MS || 30000),
      proxyCooldownMaxMs:
        options.proxyCooldownMaxMs || Number(process.env.LUPIN_PROXY_COOLDOWN_MAX_MS || 600000),
      fallbackProvider: normalizeProviderName(
        options.fallbackProvider || process.env.LUPIN_FALLBACK_PROVIDER,
        "patchright"
      ),
      httpTimeoutMs:
        options.httpTimeoutMs ||
        options.fastTimeoutMs ||
        Number(process.env.LUPIN_HTTP_TIMEOUT_MS || process.env.LUPIN_FAST_TIMEOUT_MS || 15000),
      httpCaBundlePath:
        options.httpCaBundlePath || process.env.LUPIN_CA_BUNDLE || undefined,
      httpUseSystemCa:
        options.httpUseSystemCa ?? toBoolean(process.env.LUPIN_USE_SYSTEM_CA, true),
      httpUserAgent:
        options.httpUserAgent || process.env.LUPIN_HTTP_USER_AGENT || DEFAULT_HTTP_USER_AGENT,
      camoufoxHeadless:
        options.camoufoxHeadless ?? toBoolean(process.env.LUPIN_CAMOUFOX_HEADLESS, true),
      camoufoxTimeoutMs:
        options.camoufoxTimeoutMs || Number(process.env.LUPIN_CAMOUFOX_TIMEOUT_MS || 30000),
      camoufoxRetries:
        options.camoufoxRetries || Number(process.env.LUPIN_CAMOUFOX_RETRIES || 1),
      camoufoxProfileDir:
        options.camoufoxProfileDir ||
        process.env.LUPIN_CAMOUFOX_PROFILE_DIR ||
        path.join(stateDir, "profiles", "camoufox-middle"),
      cdpUrl: options.cdpUrl || process.env.LUPIN_CDP_URL || undefined,
      cdpConnectTimeoutMs:
        options.cdpConnectTimeoutMs || Number(process.env.LUPIN_CDP_CONNECT_TIMEOUT_MS || 20000),
      fallbackHeadless: options.fallbackHeadless ?? toBoolean(process.env.LUPIN_FALLBACK_HEADLESS, true),
      fallbackTimeoutMs: options.fallbackTimeoutMs || Number(process.env.LUPIN_FALLBACK_TIMEOUT_MS || 35000),
      fallbackRetries: options.fallbackRetries || Number(process.env.LUPIN_FALLBACK_RETRIES || 2),
      fallbackLockTimeoutMs:
        options.fallbackLockTimeoutMs || Number(process.env.LUPIN_FALLBACK_LOCK_TIMEOUT_MS || 120000),
      fallbackLockPollMs:
        options.fallbackLockPollMs || Number(process.env.LUPIN_FALLBACK_LOCK_POLL_MS || 500),
      fallbackLockOrphanMs:
        options.fallbackLockOrphanMs || Number(process.env.LUPIN_FALLBACK_LOCK_ORPHAN_MS || 30000),
      persistentProfileDir:
        options.persistentProfileDir ||
        process.env.LUPIN_PROFILE_DIR ||
        path.join(stateDir, "profiles", "patchright-fallback"),
      sessionTtlMs:
        options.sessionTtlMs || Number(process.env.LUPIN_SESSION_TTL_MS || 15 * 60 * 1000),
    },
  };
}
