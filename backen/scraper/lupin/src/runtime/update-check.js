import { version } from "../version.js";

const DEFAULT_PACKAGE_NAME = "lupin-cli";
const DEFAULT_TIMEOUT_MS = 1500;

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

export function compareSemver(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return null;

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function buildPackageUrl(packageName, registryUrl) {
  const base = registryUrl || process.env.LUPIN_NPM_REGISTRY_URL || "https://registry.npmjs.org";
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const encodedName = packageName.startsWith("@")
    ? `@${encodeURIComponent(packageName.slice(1)).replace("%2F", "/")}`
    : encodeURIComponent(packageName);
  return `${normalizedBase}/${encodedName}/latest`;
}

export async function checkPackageUpdate(options = {}) {
  const packageName = options.packageName || DEFAULT_PACKAGE_NAME;
  const currentVersion = options.currentVersion;
  const checkedAt = new Date().toISOString();
  const updateCommand = options.updateCommand || `npm install -g ${packageName}@latest`;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  const baseResult = {
    packageName,
    version: currentVersion || null,
    latestVersion: null,
    updateAvailable: false,
    updateCommand,
    checkedAt,
    ok: false,
    degraded: false,
    error: null,
  };

  if (typeof fetchImpl !== "function") {
    return {
      ...baseResult,
      degraded: true,
      error: "Fetch API is not available in this Node runtime.",
    };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(buildPackageUrl(packageName, options.registryUrl), {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": `lupin/${version}`,
      },
    });

    if (!response.ok) {
      throw new Error(`npm registry returned HTTP ${response.status}`);
    }

    const metadata = await response.json();
    const latestVersion = metadata?.version ? String(metadata.version) : null;
    if (!latestVersion) {
      throw new Error("npm registry response did not include a version.");
    }

    const comparison = compareSemver(currentVersion, latestVersion);
    return {
      ...baseResult,
      latestVersion,
      updateAvailable: comparison == null ? currentVersion !== latestVersion : comparison < 0,
      ok: true,
    };
  } catch (error) {
    return {
      ...baseResult,
      degraded: true,
      error: error?.name === "AbortError"
        ? `npm registry check timed out after ${timeoutMs}ms.`
        : error?.message || String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkCoreUpdate(options = {}) {
  return checkPackageUpdate({
    ...options,
    packageName: options.packageName || DEFAULT_PACKAGE_NAME,
    currentVersion: options.currentVersion || version,
    updateCommand: `npm install -g ${options.packageName || DEFAULT_PACKAGE_NAME}@latest`,
  });
}

export function formatCoreUpdateReport(update) {
  const lines = [];
  if (update.ok) {
    const latest = update.latestVersion || "unknown";
    lines.push(`Lupin CLI: ${update.version} installed, ${latest} latest available`);
    lines.push(
      update.updateAvailable
        ? `Update available: ${update.updateCommand}`
        : "Lupin CLI is up to date."
    );
  } else {
    lines.push(`Lupin CLI: ${update.version} installed`);
    lines.push(`Update check: DEGRADED - ${update.error || "unknown error"}`);
  }
  return lines.join("\n");
}
