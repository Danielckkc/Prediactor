import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FETCH_PAGE_INPUT_SCHEMA, FETCH_TOOL_INPUT_SCHEMA } from "../schemas/fetch.js";
import { SEARCH_TOOL_INPUT_SCHEMA } from "../schemas/search.js";
import { ensureHostPackageLink, resolveNodeModulesDirForPlatformSource } from "./host-package.js";
import { readPlatformConfig, resolveManifestPathForSource } from "./state.js";

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");

function cloneSchema(schema) {
  return structuredClone(schema);
}

function resolveSchema(inputSchema, kind) {
  if (!inputSchema) {
    return cloneSchema(kind === "search" ? SEARCH_TOOL_INPUT_SCHEMA : FETCH_TOOL_INPUT_SCHEMA);
  }

  if (typeof inputSchema === "object") {
    return cloneSchema(inputSchema);
  }

  switch (String(inputSchema)) {
    case "search.standard":
      return cloneSchema(SEARCH_TOOL_INPUT_SCHEMA);
    case "fetch.standard":
      return cloneSchema(FETCH_TOOL_INPUT_SCHEMA);
    case "fetch.page":
      return cloneSchema(FETCH_PAGE_INPUT_SCHEMA);
    default:
      throw new Error(`Unknown platform schema reference: ${inputSchema}`);
  }
}

function normalizeBrowserRequirements(value) {
  if (!value || typeof value !== "object") return {};
  const requirements = {};
  if (value.camoufox) requirements.camoufox = true;
  if (value.fallback) requirements.fallback = true;
  return requirements;
}

function normalizeSmokeTests(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      name: typeof item.name === "string" ? item.name : null,
      kind: item.kind === "fetch" ? "fetch" : item.kind === "search" ? "search" : null,
      alias: typeof item.alias === "string" ? item.alias : null,
      url: typeof item.url === "string" ? item.url : null,
      query: typeof item.query === "string" ? item.query : null,
      args: item.args && typeof item.args === "object" ? structuredClone(item.args) : {},
    }))
    .filter((item) => item.kind && item.alias);
}

function validateManifest(manifest, source) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`Invalid platform manifest at ${source.manifestPath}: expected an object.`);
  }

  if (manifest.apiVersion !== 1) {
    throw new Error(
      `Unsupported platform apiVersion in ${source.manifestPath}: ${manifest.apiVersion}. Expected 1.`
    );
  }

  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error(`Platform manifest at ${source.manifestPath} must include a string "name".`);
  }

  if (!manifest.entry || typeof manifest.entry !== "string") {
    throw new Error(`Platform manifest "${manifest.name}" must include a string "entry".`);
  }

  if (!manifest.tools || typeof manifest.tools !== "object") {
    throw new Error(`Platform manifest "${manifest.name}" must include a "tools" object.`);
  }
}

function validateToolEntry(manifestName, section, entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Platform "${manifestName}" has an invalid ${section} tool entry.`);
  }

  if (!entry.tool || typeof entry.tool !== "string") {
    throw new Error(`Platform "${manifestName}" ${section} entry is missing "tool".`);
  }

  if (!entry.alias || typeof entry.alias !== "string") {
    throw new Error(`Platform "${manifestName}" ${entry.tool} is missing "alias".`);
  }

  if (!entry.description || typeof entry.description !== "string") {
    throw new Error(`Platform "${manifestName}" ${entry.tool} is missing "description".`);
  }

  if (!entry.handler || typeof entry.handler !== "string") {
    throw new Error(`Platform "${manifestName}" ${entry.tool} is missing "handler".`);
  }
}

async function listBuiltinSources() {
  const entries = await fs.readdir(BUILTIN_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      kind: "builtin",
      manifestPath: path.join(BUILTIN_DIR, entry.name, "lupin.platform.json"),
    }))
    .sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

async function loadSourceRecord(source) {
  const manifestPath = resolveManifestPathForSource(source);
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const resolvedSource = { ...source, manifestPath };
  validateManifest(manifest, resolvedSource);
  const manifestDir = path.dirname(manifestPath);
  const entryPath = path.resolve(manifestDir, manifest.entry);
  const relativeEntryPath = path.relative(manifestDir, entryPath);
  if (
    !relativeEntryPath ||
    relativeEntryPath.startsWith("..") ||
    path.isAbsolute(relativeEntryPath)
  ) {
    throw new Error(
      `Platform manifest "${manifest.name}" entry must stay within its platform directory.`
    );
  }

  if (resolvedSource.kind === "npm") {
    await ensureHostPackageLink(resolveNodeModulesDirForPlatformSource(resolvedSource));
  } else if (resolvedSource.kind === "path") {
    await ensureHostPackageLink(path.join(manifestDir, "node_modules"));
  }

  return {
    source: resolvedSource,
    manifest,
    manifestDir,
    entryPath,
    moduleUrl: pathToFileURL(entryPath).href,
  };
}

async function loadHandlers(record) {
  if (record.handlers) return record;
  return {
    ...record,
    handlers: await import(record.moduleUrl),
  };
}

function registerTool(registry, descriptor, tool) {
  registry.allToolNames.add(tool.tool);
  const aliasMap = tool.kind === "search" ? registry.searchAliases : registry.fetchAliases;
  aliasMap.set(tool.alias, tool);
  const toolMap = tool.kind === "search" ? registry.searchTools : registry.fetchTools;
  toolMap.set(tool.tool, tool);
  descriptor.tools[tool.kind].push({
    alias: tool.alias,
    tool: tool.tool,
  });
}

function createRegistryShape(config) {
  return {
    config,
    issues: [],
    allToolNames: new Set(),
    searchTools: new Map(),
    fetchTools: new Map(),
    searchAliases: new Map(),
    fetchAliases: new Map(),
    platforms: new Map(),
    platformOrder: [],
  };
}

function addIssue(registry, source, error) {
  registry.issues.push({
    sourceKind: source.kind,
    manifestPath: source.manifestPath || resolveManifestPathForSource(source),
    error: error?.message || String(error),
  });
}

function buildPlatformDescriptor(record, enabled) {
  const { manifest, source, manifestPath, entryPath } = {
    ...record,
    manifestPath: record.source.manifestPath,
    entryPath: record.entryPath,
  };
  const sourceInfo = {
    kind: source.kind,
    manifestPath,
  };

  if (source.kind === "path") {
    sourceInfo.location = source.location;
  } else if (source.kind === "npm") {
    sourceInfo.packageName = source.packageName;
    sourceInfo.specifier = source.specifier;
    sourceInfo.root = source.root;
  }

  return {
    name: manifest.name,
    displayName: manifest.displayName || manifest.name,
    version: manifest.version || null,
    description: manifest.description || null,
    enabled,
    status: enabled ? "enabled" : "disabled",
    broken: false,
    sourceKind: source.kind,
    source: sourceInfo,
    manifestPath,
    entryPath,
    smokeTests: normalizeSmokeTests(manifest.smokeTests),
    tools: {
      search: [],
      fetch: [],
    },
  };
}

function normalizeTool(record, section, entry) {
  validateToolEntry(record.manifest.name, section, entry);
  const handler = record.handlers[entry.handler];
  if (typeof handler !== "function") {
    throw new Error(
      `Platform "${record.manifest.name}" is missing exported handler "${entry.handler}" in ${record.entryPath}.`
    );
  }

  return {
    kind: section,
    platformName: record.manifest.name,
    platformDisplayName: record.manifest.displayName || record.manifest.name,
    tool: entry.tool,
    alias: entry.alias,
    description: entry.description,
    inputSchema: resolveSchema(entry.inputSchema, section),
    browserRequirements: normalizeBrowserRequirements(entry.browser),
    execute: handler,
  };
}

function finalizeRegistry(registry) {
  return {
    issues: registry.issues,
    listPlatforms() {
      return registry.platformOrder.map((name) => registry.platforms.get(name));
    },
    listSearchTools() {
      return [...registry.searchTools.values()].map((tool) => ({
        name: tool.tool,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    listFetchTools() {
      return [...registry.fetchTools.values()].map((tool) => ({
        name: tool.tool,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    getSearchTool(name) {
      return registry.searchTools.get(name) || null;
    },
    getFetchTool(name) {
      return registry.fetchTools.get(name) || null;
    },
    resolveSearchAlias(alias) {
      return registry.searchAliases.get(alias) || null;
    },
    resolveFetchAlias(alias) {
      return registry.fetchAliases.get(alias) || null;
    },
    getToolBrowserRequirements(name) {
      return (
        registry.searchTools.get(name)?.browserRequirements ||
        registry.fetchTools.get(name)?.browserRequirements ||
        {}
      );
    },
  };
}

export async function loadPlatformRegistry(options = {}) {
  const config = options.config || await readPlatformConfig(options.stateDir);
  const builtinSources = await listBuiltinSources();
  const disabled = new Set(config.disabled || []);
  const registry = createRegistryShape(config);
  const manifestNames = new Set();
  const sources = [...(config.sources || []), ...builtinSources];

  for (const source of sources) {
    let record;
    try {
      record = await loadSourceRecord(source);
    } catch (error) {
      addIssue(registry, source, error);
      continue;
    }

    const enabled = !disabled.has(record.manifest.name);
    if (manifestNames.has(record.manifest.name)) {
      const existing = registry.platforms.get(record.manifest.name);
      if (record.source.kind === "builtin" && existing?.sourceKind !== "builtin") {
        continue;
      }
      addIssue(
        registry,
        record.source,
        new Error(`Duplicate platform name detected: ${record.manifest.name}`)
      );
      continue;
    }
    manifestNames.add(record.manifest.name);

    const descriptor = buildPlatformDescriptor(record, enabled);
    registry.platforms.set(descriptor.name, descriptor);
    registry.platformOrder.push(descriptor.name);

    if (!enabled) {
      continue;
    }

    try {
      record = await loadHandlers(record);
      const searchEntries = Array.isArray(record.manifest.tools.search)
        ? record.manifest.tools.search
        : [];
      const fetchEntries = Array.isArray(record.manifest.tools.fetch)
        ? record.manifest.tools.fetch
        : [];
      const pendingTools = [];

      for (const entry of searchEntries) {
        pendingTools.push(normalizeTool(record, "search", entry));
      }

      for (const entry of fetchEntries) {
        pendingTools.push(normalizeTool(record, "fetch", entry));
      }

      for (const tool of pendingTools) {
        if (registry.allToolNames.has(tool.tool)) {
          throw new Error(`Duplicate platform tool name detected: ${tool.tool}`);
        }

        const aliasMap = tool.kind === "search" ? registry.searchAliases : registry.fetchAliases;
        if (aliasMap.has(tool.alias)) {
          throw new Error(
            `Duplicate ${tool.kind} platform alias detected: ${tool.alias} (${tool.platformName} vs ${aliasMap.get(tool.alias).platformName})`
          );
        }
      }

      for (const tool of pendingTools) {
        registerTool(registry, descriptor, tool);
      }
    } catch (error) {
      registry.platforms.set(descriptor.name, {
        ...descriptor,
        enabled: false,
        status: "broken",
        broken: true,
        error: error?.message || String(error),
      });
      addIssue(registry, record.source, error);
    }
  }

  return finalizeRegistry(registry);
}
