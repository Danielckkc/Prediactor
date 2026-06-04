import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureHostPackageLink } from "./host-package.js";
import { loadPlatformRegistry } from "./registry.js";
import { checkCoreUpdate, checkPackageUpdate } from "../runtime/update-check.js";
import {
  getPlatformNodeModulesDir,
  getPlatformStoreDir,
  readPlatformConfig,
  updatePlatformConfig,
  writePlatformConfig,
} from "./state.js";

const execFileAsync = promisify(execFile);

function isLikelyPath(specifier) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("~") ||
    specifier.endsWith(".json")
  );
}

function normalizeInstallPath(specifier) {
  if (specifier.startsWith("~/")) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      return path.join(home, specifier.slice(2));
    }
  }
  return path.resolve(specifier);
}

function extractPackageNameFromSpecifier(specifier) {
  const value = String(specifier || "").trim();
  if (!value) return null;
  if (/^(file:|https?:|git\+)/i.test(value)) return null;

  if (value.startsWith("@")) {
    const firstSlash = value.indexOf("/");
    if (firstSlash === -1) return null;
    const nextAt = value.indexOf("@", firstSlash + 1);
    return nextAt === -1 ? value : value.slice(0, nextAt);
  }

  const firstAt = value.indexOf("@");
  return firstAt === -1 ? value : value.slice(0, firstAt);
}

async function ensurePlatformStore(stateDir) {
  const storeDir = getPlatformStoreDir(stateDir);
  await fs.mkdir(storeDir, { recursive: true });
  await ensureHostPackageLink(getPlatformNodeModulesDir(stateDir));
  const packageJsonPath = path.join(storeDir, "package.json");
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(
      packageJsonPath,
      `${JSON.stringify({ name: "lupin-platform-store", private: true }, null, 2)}\n`
    );
  }
}

function getNpmCommandEnv() {
  return {
    ...process.env,
    npm_config_fund: "false",
    npm_config_audit: "false",
    npm_config_ignore_scripts: "true",
  };
}

async function validateCandidateConfig(stateDir, nextConfig, candidateName) {
  const currentRegistry = await loadPlatformRegistry({ stateDir });
  const currentIssues = new Set(
    currentRegistry.issues.map((issue) => `${issue.manifestPath}:${issue.error}`)
  );
  const registry = await loadPlatformRegistry({ stateDir, config: nextConfig });
  const issues = registry.issues.filter(
    (issue) => !currentIssues.has(`${issue.manifestPath}:${issue.error}`)
  );
  if (issues.length > 0) {
    const relevant = issues.find((issue) => issue.error.includes(candidateName)) || issues[0];
    throw new Error(relevant.error);
  }

  const collision = registry.listPlatforms().find((platform) => platform.name === candidateName);
  if (!collision) {
    throw new Error(`Installed platform "${candidateName}" could not be loaded after registration.`);
  }
}

async function loadManifestNameFromPath(location) {
  const manifestPath = location.endsWith(".json")
    ? location
    : path.join(location, "lupin.platform.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  return {
    manifestPath,
    manifestName: manifest?.name,
  };
}

function findConfiguredSourceForPlatform(config, platform) {
  return config.sources.find((item) => {
    if (item.kind === "path") {
      return platform.manifestPath === path.join(path.resolve(item.location), "lupin.platform.json") ||
        path.resolve(item.location) === platform.manifestPath;
    }
    if (item.kind === "npm") {
      return path.resolve(item.root) === path.dirname(platform.manifestPath);
    }
    return false;
  });
}

async function copyDirectoryIfExists(from, to) {
  try {
    await fs.access(from);
  } catch {
    return false;
  }
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  return true;
}

async function restoreDirectoryBackup(backup, target) {
  await fs.rm(target, { recursive: true, force: true });
  try {
    await fs.access(backup);
  } catch {
    return false;
  }
  await fs.cp(backup, target, { recursive: true });
  return true;
}

function applyUpdateFields(platform, update) {
  return {
    ...platform,
    latestVersion: update.latestVersion,
    updateAvailable: update.updateAvailable,
    updateCommand: update.updateCommand,
    updateCheckedAt: update.checkedAt,
    updateCheck: {
      ok: update.ok,
      degraded: update.degraded,
      error: update.error,
    },
  };
}

async function enrichPlatformWithUpdate(platform) {
  if (platform.sourceKind === "npm") {
    return applyUpdateFields(platform, await checkPackageUpdate({
      packageName: platform.source.packageName,
      currentVersion: platform.version,
      updateCommand: `lupin platform update ${platform.name}`,
    }));
  }

  if (platform.sourceKind === "builtin") {
    return applyUpdateFields(platform, await checkCoreUpdate());
  }

  return {
    ...platform,
    latestVersion: null,
    updateAvailable: false,
    updateCommand: null,
    updateCheckedAt: new Date().toISOString(),
    updateCheck: {
      ok: true,
      degraded: false,
      error: null,
      reason: "Path-backed platforms do not have a remote update source.",
    },
  };
}

export async function listPlatforms(stateDir, options = {}) {
  const registry = await loadPlatformRegistry({ stateDir });
  const platforms = registry.listPlatforms();
  return {
    platforms: options.checkUpdates
      ? await Promise.all(platforms.map((platform) => enrichPlatformWithUpdate(platform)))
      : platforms,
    issues: registry.issues,
  };
}

export async function installPlatform(stateDir, specifier) {
  const value = String(specifier || "").trim();
  if (!value) {
    throw new Error("Platform install requires a local path or npm package name.");
  }

  const config = await readPlatformConfig(stateDir);
  const maybePath = normalizeInstallPath(value);
  const pathStat = await fs.stat(maybePath).catch(() => null);
  const usePath = isLikelyPath(value) || Boolean(pathStat);

  if (usePath) {
    if (!pathStat) {
      throw new Error(`Platform path not found: ${maybePath}`);
    }

    const { manifestName } = await loadManifestNameFromPath(maybePath);
    if (!manifestName) {
      throw new Error(`Platform manifest at ${maybePath} is missing "name".`);
    }

    const nextSources = [
      ...config.sources.filter(
        (source) => !(source.kind === "path" && path.resolve(source.location) === maybePath)
      ),
      { kind: "path", location: maybePath },
    ];

    const nextDisabled = config.disabled.filter((name) => name !== manifestName);
    await validateCandidateConfig(stateDir, {
      ...config,
      sources: nextSources,
      disabled: nextDisabled,
    }, manifestName);

    await writePlatformConfig(stateDir, {
      ...config,
      sources: nextSources,
      disabled: nextDisabled,
    });

    return {
      kind: "path",
      manifestName,
      location: maybePath,
    };
  }

  const packageName = extractPackageNameFromSpecifier(value);
  if (!packageName) {
    throw new Error(
      `Unsupported npm platform specifier: ${value}. Use a package name like "@scope/lupin-platform-foo" or a local path.`
    );
  }

  const packageRoot = path.join(getPlatformNodeModulesDir(stateDir), ...packageName.split("/"));
  await ensurePlatformStore(stateDir);
  // Platform packages are treated as prebuilt plugins. Ignore package lifecycle
  // scripts so install does not execute arbitrary postinstall hooks.
  await execFileAsync("npm", ["install", "--ignore-scripts", "--no-save", "--no-package-lock", value], {
    cwd: getPlatformStoreDir(stateDir),
    env: getNpmCommandEnv(),
  });

  const { manifestName } = await loadManifestNameFromPath(packageRoot);
  if (!manifestName) {
    throw new Error(`Installed package "${packageName}" does not expose lupin.platform.json with a name.`);
  }

  const nextSources = [
    ...config.sources.filter((source) => !(source.kind === "npm" && source.packageName === packageName)),
    { kind: "npm", specifier: value, packageName, root: packageRoot },
  ];
  const nextDisabled = config.disabled.filter((name) => name !== manifestName);

  try {
    await validateCandidateConfig(stateDir, {
      ...config,
      sources: nextSources,
      disabled: nextDisabled,
    }, manifestName);
  } catch (error) {
    await execFileAsync("npm", ["uninstall", "--ignore-scripts", "--no-save", packageName], {
      cwd: getPlatformStoreDir(stateDir),
      env: getNpmCommandEnv(),
    }).catch(() => {});
    throw error;
  }

  await writePlatformConfig(stateDir, {
    ...config,
    sources: nextSources,
    disabled: nextDisabled,
  });

  return {
    kind: "npm",
    manifestName,
    packageName,
    root: packageRoot,
  };
}

export async function setPlatformEnabled(stateDir, name, enabled) {
  const registry = await loadPlatformRegistry({ stateDir });
  const platform = registry.listPlatforms().find((item) => item.name === name);
  if (!platform) {
    throw new Error(`Unknown platform: ${name}`);
  }

  const config = await updatePlatformConfig(stateDir, (current) => {
    const disabled = new Set(current.disabled || []);
    if (enabled) disabled.delete(name);
    else disabled.add(name);
    return {
      ...current,
      disabled: [...disabled].sort(),
    };
  });

  return {
    name,
    enabled,
    config,
    sourceKind: platform.sourceKind,
  };
}

export async function removePlatform(stateDir, name) {
  const registry = await loadPlatformRegistry({ stateDir });
  const platform = registry.listPlatforms().find((item) => item.name === name);
  if (!platform) {
    throw new Error(`Unknown platform: ${name}`);
  }

  if (platform.sourceKind === "builtin") {
    await setPlatformEnabled(stateDir, name, false);
    return {
      name,
      removed: false,
      disabled: true,
      sourceKind: "builtin",
    };
  }

  const config = await readPlatformConfig(stateDir);
  const source = findConfiguredSourceForPlatform(config, platform);

  if (!source) {
    throw new Error(`Platform "${name}" is registered but its source could not be located.`);
  }

  if (source.kind === "npm") {
    await ensurePlatformStore(stateDir);
    await execFileAsync(
      "npm",
      ["uninstall", "--ignore-scripts", "--no-save", source.packageName],
      {
        cwd: getPlatformStoreDir(stateDir),
        env: getNpmCommandEnv(),
      }
    ).catch(() => {});
  }

  await writePlatformConfig(stateDir, {
    ...config,
    sources: config.sources.filter((item) => item !== source),
    disabled: config.disabled.filter((value) => value !== name),
  });

  return {
    name,
    removed: true,
    disabled: false,
    sourceKind: source.kind,
  };
}

export async function updatePlatform(stateDir, name) {
  const registry = await loadPlatformRegistry({ stateDir });
  const platform = registry.listPlatforms().find((item) => item.name === name);
  if (!platform) {
    throw new Error(`Unknown platform: ${name}`);
  }

  if (platform.sourceKind === "builtin") {
    return {
      name,
      sourceKind: "builtin",
      status: "skipped-builtin",
      oldVersion: platform.version,
      newVersion: platform.version,
      message: `Built-in platform "${name}" updates with lupin-cli. Run: npm install -g lupin-cli@latest`,
      updateCommand: "npm install -g lupin-cli@latest",
    };
  }

  const config = await readPlatformConfig(stateDir);
  const source = findConfiguredSourceForPlatform(config, platform);
  if (!source) {
    throw new Error(`Platform "${name}" is registered but its source could not be located.`);
  }

  if (source.kind === "path") {
    const nextRegistry = await loadPlatformRegistry({ stateDir });
    const nextPlatform = nextRegistry.listPlatforms().find((item) => item.name === name);
    if (!nextPlatform || nextPlatform.broken) {
      return {
        name,
        sourceKind: "path",
        status: "blocked",
        oldVersion: platform.version,
        newVersion: nextPlatform?.version || null,
        error: nextPlatform?.error || `Path-backed platform "${name}" could not be loaded.`,
      };
    }

    return {
      name,
      sourceKind: "path",
      status: "revalidated",
      oldVersion: platform.version,
      newVersion: nextPlatform.version,
      location: source.location,
    };
  }

  if (source.kind !== "npm") {
    throw new Error(`Unsupported platform source kind for update: ${source.kind}`);
  }

  await ensurePlatformStore(stateDir);
  const backupRoot = path.join(
    getPlatformStoreDir(stateDir),
    `.backup-${source.packageName.replace(/[\\/]/g, "-")}-${Date.now()}`
  );
  const hadBackup = await copyDirectoryIfExists(source.root, backupRoot);
  let restored = false;

  try {
    await execFileAsync("npm", ["install", "--ignore-scripts", "--no-save", "--no-package-lock", source.specifier], {
      cwd: getPlatformStoreDir(stateDir),
      env: getNpmCommandEnv(),
    });

    const { manifestName } = await loadManifestNameFromPath(source.root);
    if (manifestName !== name) {
      throw new Error(`Updated package "${source.packageName}" exposes platform "${manifestName}" instead of "${name}".`);
    }

    await validateCandidateConfig(stateDir, config, name);
    const nextRegistry = await loadPlatformRegistry({ stateDir });
    const nextPlatform = nextRegistry.listPlatforms().find((item) => item.name === name);
    if (!nextPlatform || nextPlatform.broken) {
      throw new Error(nextPlatform?.error || `Updated platform "${name}" could not be loaded.`);
    }

    return {
      name,
      sourceKind: "npm",
      status: nextPlatform.version === platform.version ? "already-current" : "updated",
      oldVersion: platform.version,
      newVersion: nextPlatform.version,
      packageName: source.packageName,
      specifier: source.specifier,
    };
  } catch (error) {
    restored = hadBackup && await restoreDirectoryBackup(backupRoot, source.root);
    return {
      name,
      sourceKind: "npm",
      status: restored ? "failed-rolled-back" : "blocked",
      oldVersion: platform.version,
      newVersion: null,
      packageName: source.packageName,
      specifier: source.specifier,
      error: error?.message || String(error),
    };
  } finally {
    await fs.rm(backupRoot, { recursive: true, force: true });
  }
}

export async function updatePlatforms(stateDir, names) {
  const targetNames = names && names.length
    ? names
    : (await loadPlatformRegistry({ stateDir })).listPlatforms().map((platform) => platform.name);
  const results = [];
  for (const name of targetNames) {
    results.push(await updatePlatform(stateDir, name));
  }
  return { platforms: results };
}

export async function checkPlatformUpdates(stateDir, names) {
  const registry = await loadPlatformRegistry({ stateDir });
  const platforms = registry.listPlatforms();
  const selected = names && names.length
    ? platforms.filter((platform) => names.includes(platform.name))
    : platforms;
  const missing = (names || []).filter((name) => !platforms.some((platform) => platform.name === name));
  if (missing.length) {
    throw new Error(`Unknown platform: ${missing[0]}`);
  }
  return {
    platforms: await Promise.all(selected.map((platform) => enrichPlatformWithUpdate(platform))),
    issues: registry.issues,
  };
}

function buildDoctorReportForPlatform(platform, issues) {
  const platformIssues = issues.filter((issue) => issue.manifestPath === platform.manifestPath);
  const checks = [
    {
      name: "manifest",
      status: platformIssues.length ? "failed" : "ok",
      message: platformIssues.length
        ? platformIssues.map((issue) => issue.error).join("; ")
        : `Loaded manifest from ${platform.manifestPath}.`,
    },
    {
      name: "state",
      status: platform.broken ? "failed" : platform.enabled ? "ok" : "skipped",
      message: platform.broken
        ? platform.error
        : platform.enabled
          ? "Platform is enabled."
          : "Platform is disabled.",
    },
  ];

  const toolCount = platform.tools.search.length + platform.tools.fetch.length;
  checks.push({
    name: "tools",
    status: platform.enabled && !platform.broken && toolCount > 0 ? "ok" : platform.enabled ? "failed" : "skipped",
    message: `${toolCount} tool${toolCount === 1 ? "" : "s"} registered.`,
  });

  const failed = checks.some((check) => check.status === "failed");
  const skipped = checks.some((check) => check.status === "skipped");

  return {
    name: platform.name,
    displayName: platform.displayName,
    sourceKind: platform.sourceKind,
    version: platform.version,
    status: failed ? "failed" : skipped ? "degraded" : "ok",
    enabled: platform.enabled,
    broken: platform.broken,
    smokeTests: platform.smokeTests || [],
    checks,
  };
}

export async function doctorPlatforms(stateDir, names) {
  const registry = await loadPlatformRegistry({ stateDir });
  const platforms = registry.listPlatforms();
  const targetNames = names && names.length ? names : platforms.map((platform) => platform.name);
  const missing = targetNames.filter((name) => !platforms.some((platform) => platform.name === name));
  if (missing.length) {
    throw new Error(`Unknown platform: ${missing[0]}`);
  }

  return {
    snapshotDate: new Date().toISOString(),
    platforms: targetNames.map((name) => {
      const platform = platforms.find((item) => item.name === name);
      return buildDoctorReportForPlatform(platform, registry.issues);
    }),
    issues: registry.issues,
  };
}
