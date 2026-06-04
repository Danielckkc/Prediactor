import fs from "node:fs/promises";
import path from "node:path";

import { resolveStateDir } from "../runtime/config.js";

export const PLATFORM_CONFIG_VERSION = 1;

export function getPlatformConfigPath(stateDir) {
  return path.join(resolveStateDir(stateDir), "platforms.json");
}

export function getPlatformStoreDir(stateDir) {
  return path.join(resolveStateDir(stateDir), "platforms-store");
}

export function getPlatformNodeModulesDir(stateDir) {
  return path.join(getPlatformStoreDir(stateDir), "node_modules");
}

export function defaultPlatformConfig() {
  return {
    version: PLATFORM_CONFIG_VERSION,
    sources: [],
    disabled: [],
  };
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") return null;

  if (source.kind === "path" && typeof source.location === "string") {
    return {
      kind: "path",
      location: path.resolve(source.location),
    };
  }

  if (
    source.kind === "npm" &&
    typeof source.specifier === "string" &&
    typeof source.packageName === "string" &&
    typeof source.root === "string"
  ) {
    return {
      kind: "npm",
      specifier: source.specifier,
      packageName: source.packageName,
      root: path.resolve(source.root),
    };
  }

  return null;
}

function normalizeConfig(config) {
  const disabled = Array.isArray(config?.disabled)
    ? [...new Set(config.disabled.map((value) => String(value || "").trim()).filter(Boolean))].sort()
    : [];

  return {
    version: PLATFORM_CONFIG_VERSION,
    sources: Array.isArray(config?.sources)
      ? config.sources.map(normalizeSource).filter(Boolean)
      : [],
    disabled,
  };
}

export async function readPlatformConfig(stateDir) {
  const filePath = getPlatformConfigPath(stateDir);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return defaultPlatformConfig();
    }
    throw error;
  }
}

export async function writePlatformConfig(stateDir, config) {
  const filePath = getPlatformConfigPath(stateDir);
  const normalized = normalizeConfig(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export async function updatePlatformConfig(stateDir, updater) {
  const current = await readPlatformConfig(stateDir);
  const next = await updater(structuredClone(current));
  return writePlatformConfig(stateDir, next);
}

export function resolveManifestPathForSource(source) {
  if (!source || typeof source !== "object") {
    throw new Error("Platform source is missing.");
  }

  if (source.kind === "builtin") {
    return source.manifestPath;
  }

  if (source.kind === "path") {
    const location = path.resolve(source.location);
    return location.endsWith(".json") ? location : path.join(location, "lupin.platform.json");
  }

  if (source.kind === "npm") {
    return path.join(path.resolve(source.root), "lupin.platform.json");
  }

  throw new Error(`Unsupported platform source kind: ${source.kind}`);
}

