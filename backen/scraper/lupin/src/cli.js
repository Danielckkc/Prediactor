import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Lupin } from "./index.js";
import { BrowserManager } from "./runtime/browser-manager.js";
import { CrawlSession, formatCrawlResult } from "./crawl/crawler.js";
import { buildScrapeMarkdown } from "./runtime/markdown.js";
import { CrawlOutputWriter } from "./crawl/output.js";
import { runVideoSetup, getYtDlpStatus } from "./runtime/video-deps.js";
import { downloadVideo } from "./providers/video/download.js";
import {
  evaluateBrowserRequirements,
  formatDoctorReport,
  formatPreflightMessage,
  getDoctorReport,
  runSetup,
} from "./runtime/browser-deps.js";
import { checkCoreUpdate, formatCoreUpdateReport } from "./runtime/update-check.js";
import { normalizeEngineName, resolveStateDir } from "./runtime/config.js";
import { loadProxyListFile, parseProxy } from "./runtime/proxy-pool.js";
import {
  callFetchTool,
  getFetchToolBrowserRequirements,
} from "./mcp/tools/fetch-tools.js";
import {
  callSearchTool,
  getSearchToolBrowserRequirements,
} from "./mcp/tools/search-tools.js";
import { addProvider, removeProvider, setDefault, listProviders } from "./llm/config.js";
import { run as runLlm } from "./llm/index.js";
import { LlmConfigError } from "./llm/errors.js";
import {
  installPlatform,
  listPlatforms,
  removePlatform,
  setPlatformEnabled,
  checkPlatformUpdates,
  doctorPlatforms,
  updatePlatform,
  updatePlatforms,
} from "./platforms/manager.js";
import { loadPlatformRegistry } from "./platforms/registry.js";

function hasFlag(args, name) {
  return args.includes(name);
}

function readFlag(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function readFormatFlag(args, fallback = "json") {
  if (hasFlag(args, "--json")) {
    return "json";
  }
  return readFlag(args, "--format", fallback);
}

async function resolveProxyFlags(proxyFlag, proxyListFlag, proxyStrategy) {
  const config = {};

  if (proxyFlag) {
    config.proxy = parseProxy(proxyFlag);
  }

  if (proxyListFlag) {
    // Could be a file path or inline comma-separated list
    if (proxyListFlag.includes(",")) {
      config.proxyList = proxyListFlag.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      // Treat as file path
      try {
        config.proxyList = await loadProxyListFile(proxyListFlag);
      } catch (error) {
        console.error(`Failed to load proxy list from ${proxyListFlag}: ${error.message}`);
        process.exitCode = 1;
        throw error;
      }
    }
  }

  if (proxyStrategy) {
    config.proxyStrategy = proxyStrategy;
  }

  return config;
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

function looksLikeDomain(value) {
  return /^[a-z0-9]([a-z0-9-]*\.)+[a-z]{2,}(\/\S*)?$/i.test(value);
}

function normalizeUrl(value) {
  if (looksLikeUrl(value)) return value;
  if (looksLikeDomain(value)) return `https://${value}`;
  return value;
}

function parseFetchArgs(flags) {
  // Parse --schema: inline JSON or file path
  let schemaValue = readFlag(flags, "--schema");
  if (schemaValue) {
    try {
      if (schemaValue.startsWith("{") || schemaValue.startsWith("[")) {
        schemaValue = JSON.parse(schemaValue);
      } else {
        const schemaContent = readFileSync(schemaValue, "utf8");
        schemaValue = JSON.parse(schemaContent);
      }
    } catch (err) {
      throw new Error(`Invalid --schema: ${err.message}`);
    }
  }

  return {
    format: readFormatFlag(flags, "json"),
    engine: readFlag(flags, "--engine", "auto"),
    timeout: Number(readFlag(flags, "--timeout", "0")) || undefined,
    waitFor: readFlag(flags, "--wait-for"),
    maxComments: Number(readFlag(flags, "--max-comments", "0")) || undefined,
    maxRepliesPerComment: Number(readFlag(flags, "--max-replies", "0")) || undefined,
    minCommentLikes: Number(readFlag(flags, "--min-comment-likes", "0")) || undefined,
    screenshot: hasFlag(flags, "--screenshot"),
    screenshotFullPage: hasFlag(flags, "--screenshot-full-page"),
    screenshotFormat: readFlag(flags, "--screenshot-format"),
    screenshotQuality: readFlag(flags, "--screenshot-quality") != null ? Number(readFlag(flags, "--screenshot-quality")) : undefined,
    screenshotPath: readFlag(flags, "--screenshot-to"),
    proxy: readFlag(flags, "--proxy"),
    proxyList: readFlag(flags, "--proxy-list"),
    proxyStrategy: readFlag(flags, "--proxy-rotate"),
    // LLM extraction flags
    extract: readFlag(flags, "--extract"),
    schema: schemaValue || undefined,
    llm: readFlag(flags, "--llm"),
    llmTimeout: Number(readFlag(flags, "--llm-timeout", "0")) || undefined,
  };
}

function parseSearchArgs(flags) {
  return {
    limit: Number(readFlag(flags, "--limit", "0")) || undefined,
    sort: readFlag(flags, "--sort"),
    dateFrom: readFlag(flags, "--date-from"),
    dateTo: readFlag(flags, "--date-to"),
    site: readFlag(flags, "--site"),
    engine: readFlag(flags, "--engine"),
    proxy: readFlag(flags, "--proxy"),
    proxyList: readFlag(flags, "--proxy-list"),
    proxyStrategy: readFlag(flags, "--proxy-rotate"),
  };
}

function formatOutput(result, format, hasLlm = false) {
  if (hasLlm && format !== "json") {
    if (typeof result.content === "string") return result.content;
    return JSON.stringify(result.content, null, 2);
  }
  if ((format === "markdown" || format === "html") && typeof result.content === "string") {
    return result.content;
  }
  return JSON.stringify(result, null, 2);
}

async function getPlatformCliCatalog(stateDir = resolveStateDir()) {
  const registry = await loadPlatformRegistry({ stateDir });
  const fetchPlatforms = new Map([["page", { tool: "fetch_page", browserRequirements: {} }]]);
  const searchPlatforms = new Map([
    ["web", { tool: "search_web", browserRequirements: { camoufox: true } }],
    ["google", { tool: "search_google", browserRequirements: { camoufox: true } }],
  ]);

  for (const tool of registry.listFetchTools()) {
    const descriptor = registry.getFetchTool(tool.name);
    fetchPlatforms.set(descriptor.alias, {
      tool: descriptor.tool,
      browserRequirements: descriptor.browserRequirements,
    });
  }

  for (const tool of registry.listSearchTools()) {
    const descriptor = registry.getSearchTool(tool.name);
    searchPlatforms.set(descriptor.alias, {
      tool: descriptor.tool,
      browserRequirements: descriptor.browserRequirements,
    });
  }

  return {
    fetchPlatforms,
    searchPlatforms,
  };
}

export async function runCli(argv) {
  const [command, second, third, ...rest] = argv;

  if (command === "setup") {
    return runSetupCommand([second, third, ...rest].filter(Boolean));
  }
  if (command === "doctor") {
    return runDoctorCommand([second, third, ...rest].filter(Boolean));
  }
  if (command === "update") {
    return runUpdateCommand(second, [third, ...rest].filter(Boolean));
  }
  if (command === "fetch") {
    return runFetch(second, third, rest);
  }
  if (command === "search") {
    return runSearch(second, third, rest);
  }
  if (command === "download") {
    return runDownload(second, [third, ...rest].filter(Boolean));
  }
  if (command === "crawl") {
    return runCrawl([second, third, ...rest].filter(Boolean));
  }
  if (command === "map") {
    return runMap([second, third, ...rest].filter(Boolean));
  }
  if (command === "llm") {
    return runLlmCommand(second, [third, ...rest].filter(Boolean));
  }
  if (command === "platform") {
    return runPlatformCommand(second, [third, ...rest].filter(Boolean));
  }

  console.error(
    "Usage: lupin <command> [options]\n\n" +
    "Commands:\n" +
    "  setup      Install browser assets (--with-video)\n" +
    "  doctor     Inspect runtime readiness (--json)\n" +
    "  update     Check for Lupin CLI updates\n" +
    "  fetch      Fetch structured data from a URL\n" +
    "  search     Search a platform\n" +
    "  download   Download a video\n" +
    "  crawl      Crawl a site and extract content\n" +
    "  map        Discover all URLs on a site\n" +
    "  llm        Manage LLM providers (add, list, remove, default)\n" +
    "  platform   Manage installable platform providers\n\n" +
    "Run lupin --help for full usage or lupin <command> for command-specific help."
  );
  process.exitCode = 1;
}

function createDoctorReportFromManager(browserManager) {
  return getDoctorReport({
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });
}

function ensureBrowserRequirements(browserManager, requirements, context) {
  if (!requirements.camoufox && !requirements.fallback) {
    return;
  }

  const report = createDoctorReportFromManager(browserManager);
  const readiness = evaluateBrowserRequirements(report, requirements);
  if (!readiness.ok) {
    throw new Error(formatPreflightMessage(report, context, requirements));
  }
}

async function runSetupCommand(flags = []) {
  try {
    const report = await runSetup();
    console.log(formatDoctorReport(report));

    if (hasFlag(flags, "--with-video")) {
      const browserManager = new BrowserManager();
      const videoReport = await runVideoSetup(browserManager.stateDir);
      console.log(`\nVideo support installed:`);
      console.log(`  yt-dlp: ${videoReport.ytdlp.message}`);
      console.log(`  FFmpeg: ${videoReport.ffmpeg.message}`);
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}

async function runDoctorCommand(flags = []) {
  const browserManager = new BrowserManager();
  const report = createDoctorReportFromManager(browserManager);
  const format = readFormatFlag(flags, "text");
  if (!hasFlag(flags, "--no-update-check")) {
    report.lupin = await checkCoreUpdate();
    if (report.lupin.degraded) {
      report.warnings.push(`Lupin update check was degraded: ${report.lupin.error}`);
    }
  }

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(formatDoctorReport(report));
}

async function runUpdateCommand(action, flags = []) {
  const format = readFormatFlag(flags, "text");

  if (!action || action === "help") {
    console.error(
      "Usage: lupin update check [--json]\n\n" +
      "Commands:\n" +
      "  check    Check whether a newer lupin-cli release is available\n\n" +
      "Options:\n" +
      "  --json   Output machine-readable JSON"
    );
    process.exitCode = action ? 0 : 1;
    return;
  }

  if (action !== "check") {
    console.error(`Unknown update action: ${action}`);
    process.exitCode = 1;
    return;
  }

  const result = await checkCoreUpdate();
  if (format === "json") {
    console.log(JSON.stringify({ lupin: result }, null, 2));
    return;
  }

  console.log(formatCoreUpdateReport(result));
}

async function runFetch(platformOrUrl, urlOrFlag, rest) {
  let platform, url, flags;
  const stateDir = resolveStateDir();
  const catalog = await getPlatformCliCatalog(stateDir);
  const fetchPlatformNames = [...catalog.fetchPlatforms.keys()];

  if (!platformOrUrl) {
    console.error(
      "Usage: lupin fetch <platform> <url> [flags]\n" +
      "       lupin fetch <url> [flags]\n\n" +
      `Platforms: ${fetchPlatformNames.join(", ")}\n\n` +
      "Options:\n" +
      "  --format <fmt>          Output format: json (default), markdown, html\n" +
      "  --json                  Alias for --format json\n" +
      "  --engine <engine>       Engine: auto, http, camoufox, fallback\n" +
      "  --wait-for <selector>   CSS selector to wait for before extraction\n" +
      "  --timeout <ms>          Timeout in milliseconds\n" +
      "  --max-comments <n>      Max comments to return\n" +
      "  --max-replies <n>       Max replies per comment (default: 1)\n" +
      "  --min-comment-likes <n> Minimum likes for a comment to be included\n\n" +
      "Screenshot options (requires browser engine):\n" +
      "  --screenshot              Capture a screenshot after page load\n" +
      "  --screenshot-full-page    Capture full scrollable height\n" +
      "  --screenshot-format <fmt> Image format: png (default), jpeg\n" +
      "  --screenshot-quality <n>  JPEG quality 0-100 (default 80)\n" +
      "  --screenshot-to <path>    Output file path\n\n" +
      "LLM extraction:\n" +
      "  --extract <prompt>      Natural-language extraction prompt\n" +
      "  --schema <json|file>    JSON Schema for structured extraction\n" +
      "  --llm <provider>        LLM provider name (see: lupin llm list)\n" +
      "  --llm-timeout <ms>      LLM inference timeout\n\n" +
      "Proxy options:\n" +
      "  --proxy <url>             Proxy URL\n" +
      "  --proxy-list <file>       File with one proxy per line, or comma-separated list\n" +
      "  --proxy-rotate <strategy> Rotation strategy for proxy list"
    );
    process.exitCode = 1;
    return;
  }

  // `fetch <url>` or `fetch <domain>` → `fetch page <url>`
  if (looksLikeUrl(platformOrUrl) || looksLikeDomain(platformOrUrl)) {
    platform = "page";
    url = normalizeUrl(platformOrUrl);
    flags = [urlOrFlag, ...rest].filter(Boolean);
  } else {
    platform = platformOrUrl;
    url = urlOrFlag;
    flags = rest;
  }

  if (!catalog.fetchPlatforms.has(platform)) {
    console.error(`Unknown fetch platform: ${platform}\nAvailable: ${fetchPlatformNames.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  url = normalizeUrl(url ?? "");
  if (!url || !looksLikeUrl(url)) {
    console.error(`Missing or invalid URL.\nUsage: lupin fetch ${platform} <url> [flags]`);
    process.exitCode = 1;
    return;
  }

  let parsedArgs;
  try {
    parsedArgs = parseFetchArgs(flags);
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exitCode = 1;
    return;
  }
  const { screenshotPath, proxy: proxyFlag, proxyList: proxyListFlag, proxyStrategy, ...toolArgs } = parsedArgs;
  const proxyConfig = await resolveProxyFlags(proxyFlag, proxyListFlag, proxyStrategy);
  const browserManager = new BrowserManager(proxyConfig);
  const runtimeStateDir = browserManager.stateDir;
  const args = { url, ...toolArgs, stateDir: runtimeStateDir };
  const platformEntry = catalog.fetchPlatforms.get(platform);
  const toolName = platformEntry.tool;

  const scraper = new Lupin({
    browserManager,
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });

  try {
    const normalizedEngine = normalizeEngineName(args.engine, "auto");
    const toolBrowserRequirements = await getFetchToolBrowserRequirements(toolName, { stateDir: runtimeStateDir });
    ensureBrowserRequirements(
      browserManager,
      {
        camoufox: normalizedEngine === "camoufox" || toolBrowserRequirements.camoufox,
        fallback: normalizedEngine === "fallback",
      },
      `fetch ${platform}`
    );
    const result = await callFetchTool(toolName, args, { scraper, browserManager, stateDir: runtimeStateDir });
    if (args.screenshot && !result?.screenshotBuffer) {
      console.error("Warning: screenshot requested but no browser engine was used. Pass --engine fallback or --engine camoufox to force a browser.");
    }
    if (result?.screenshotBuffer) {
      const ext = result.screenshotMimeType === "image/jpeg" ? "jpg" : "png";
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outPath = screenshotPath || `${hostname}-${timestamp}.${ext}`;
      try {
        await fs.writeFile(outPath, result.screenshotBuffer);
        console.error(`Screenshot saved to ${outPath} (${result.screenshotBuffer.length} bytes)`);
      } catch (writeError) {
        console.error(`Failed to write screenshot: ${writeError.message}`);
      }
    }
    const hasLlm = Boolean(parsedArgs.extract || parsedArgs.schema);
    console.log(formatOutput(result, args.format, hasLlm));
  } catch (error) {
    console.error(JSON.stringify({
      error: error?.message || String(error),
      failure: error?.failure || null,
      attempts: error?.attempts || [],
      updateHint: error?.updateHint || null,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await scraper.close();
  }
}

async function runSearch(platform, queryStart, rest) {
  const stateDir = resolveStateDir();
  const catalog = await getPlatformCliCatalog(stateDir);
  const searchPlatformNames = [...catalog.searchPlatforms.keys()];
  const allFlags = [queryStart, ...rest].filter(Boolean);
  if (hasFlag(allFlags, "--extract") || hasFlag(allFlags, "--schema")) {
    console.error("Error: --extract and --schema are not supported with search commands.\nSearch results are already structured.");
    process.exitCode = 1;
    return;
  }

  if (!platform) {
    console.error(
      "Usage: lupin search <platform> <query> [flags]\n\n" +
      `Platforms: ${searchPlatformNames.join(", ")}\n\n` +
      "Options:\n" +
      "  --format <fmt>          Output format: json (default), markdown\n" +
      "  --json                  Alias for --format json\n" +
      "  --limit <n>             Max number of results (default: 10, max: 200)\n" +
      "  --sort <order>          Sort order: relevance (default), recent\n" +
      "  --date-from <date>      Start date filter (YYYY-MM-DD)\n" +
      "  --date-to <date>        End date filter (YYYY-MM-DD)\n" +
      "  --site <domain>         Restrict results to this domain\n" +
      "  --engine <engine>       Explicit search engine override\n\n" +
      "Proxy options:\n" +
      "  --proxy <url>             Proxy URL\n" +
      "  --proxy-list <file>       File with one proxy per line, or comma-separated list\n" +
      "  --proxy-rotate <strategy> Rotation strategy for proxy list"
    );
    process.exitCode = 1;
    return;
  }

  if (!catalog.searchPlatforms.has(platform)) {
    console.error(`Unknown search platform: ${platform}\nAvailable: ${searchPlatformNames.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Collect query words (everything before the first --flag)
  const queryParts = [];
  const flags = [];
  let inFlags = false;

  for (const part of [queryStart, ...rest].filter(Boolean)) {
    if (part.startsWith("--")) {
      inFlags = true;
    }
    if (inFlags) {
      flags.push(part);
    } else {
      queryParts.push(part);
    }
  }

  const query = queryParts.join(" ");
  if (!query) {
    console.error(`Missing query.\nUsage: lupin search ${platform} <query> [flags]`);
    process.exitCode = 1;
    return;
  }

  const parsedFlags = parseSearchArgs(flags);
  const { proxy: proxyFlag, proxyList: proxyListFlag, proxyStrategy, ...searchArgs } = parsedFlags;
  const args = { query, ...searchArgs };
  const toolName = catalog.searchPlatforms.get(platform).tool;
  const format = readFormatFlag(flags, "json");

  const proxyConfig = await resolveProxyFlags(proxyFlag, proxyListFlag, proxyStrategy);
  const browserManager = new BrowserManager(proxyConfig);
  const scraper = new Lupin({
    browserManager,
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });

  try {
    const toolBrowserRequirements = await getSearchToolBrowserRequirements(toolName, { stateDir: browserManager.stateDir });
    ensureBrowserRequirements(
      browserManager,
      {
        camoufox: toolBrowserRequirements.camoufox,
        fallback: toolBrowserRequirements.fallback,
      },
      `search ${platform}`
    );
    const result = await callSearchTool(toolName, args, {
      browserManager,
      fetcher: scraper.fetch.bind(scraper),
      stateDir: browserManager.stateDir,
    });
    console.log(formatOutput(result, format));
  } catch (error) {
    console.error(JSON.stringify({
      error: error?.message || String(error),
      failure: error?.failure || null,
      attempts: error?.attempts || [],
      updateHint: error?.updateHint || null,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    await scraper.close();
  }
}

function summarizeSmokeResult(result, smoke) {
  if (!result || result.blocked) {
    return {
      status: "failed",
      message: result?.blocked ? "Smoke result was blocked." : "Smoke returned no result.",
    };
  }

  if (smoke.kind === "search") {
    const count = Array.isArray(result.results) ? result.results.length : 0;
    return {
      status: count > 0 ? "ok" : "failed",
      message: `${count} search result${count === 1 ? "" : "s"} returned.`,
    };
  }

  const content = result.content;
  const hasContent = content && (
    typeof content === "string"
      ? content.trim().length > 0
      : Object.keys(content).length > 0
  );
  return {
    status: hasContent ? "ok" : "failed",
    message: hasContent ? "Fetch returned non-empty content." : "Fetch returned empty content.",
  };
}

async function runPlatformSmokeChecks(result, stateDir) {
  const catalog = await getPlatformCliCatalog(stateDir);
  const browserManager = new BrowserManager();
  const scraper = new Lupin({
    browserManager,
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });

  try {
    for (const platform of result.platforms) {
      if (!platform.enabled || platform.broken) {
        platform.checks.push({
          name: "smoke",
          status: "skipped",
          message: "Smoke checks skipped because the platform is disabled or broken.",
        });
        continue;
      }

      if (!platform.smokeTests.length) {
        platform.checks.push({
          name: "smoke",
          status: "skipped",
          message: "No smoke tests declared in the platform manifest.",
        });
        continue;
      }

      for (const smoke of platform.smokeTests) {
        const checkName = `smoke:${smoke.name || `${smoke.kind}:${smoke.alias}`}`;
        const startedAt = new Date().toISOString();
        try {
          let smokeResult;
          if (smoke.kind === "search") {
            const entry = catalog.searchPlatforms.get(smoke.alias);
            if (!entry) throw new Error(`Unknown search smoke alias: ${smoke.alias}`);
            smokeResult = await callSearchTool(entry.tool, {
              query: smoke.query || smoke.args.query || "lupin smoke",
              ...smoke.args,
            }, {
              browserManager,
              fetcher: scraper.fetch.bind(scraper),
              stateDir: browserManager.stateDir,
            });
          } else {
            const entry = catalog.fetchPlatforms.get(smoke.alias);
            if (!entry) throw new Error(`Unknown fetch smoke alias: ${smoke.alias}`);
            if (!smoke.url && !smoke.args.url) throw new Error("Fetch smoke test requires a URL.");
            smokeResult = await callFetchTool(entry.tool, {
              url: smoke.url || smoke.args.url,
              format: "json",
              ...smoke.args,
            }, {
              scraper,
              browserManager,
              stateDir: browserManager.stateDir,
            });
          }

          const summary = summarizeSmokeResult(smokeResult, smoke);
          platform.checks.push({
            name: checkName,
            status: summary.status,
            message: summary.message,
            target: smoke.url || smoke.query || smoke.args.url || smoke.args.query || null,
            snapshotDate: smokeResult?.snapshotDate || startedAt,
          });
        } catch (error) {
          platform.checks.push({
            name: checkName,
            status: "failed",
            message: error?.message || String(error),
            target: smoke.url || smoke.query || smoke.args.url || smoke.args.query || null,
            snapshotDate: startedAt,
          });
        }
      }

      if (platform.checks.some((check) => check.name.startsWith("smoke:") && check.status === "failed")) {
        platform.status = "failed";
      }
    }
  } finally {
    await scraper.close();
  }
}

async function runPlatformCommand(action, flags) {
  const stateDir = resolveStateDir();
  const format = readFormatFlag(flags, "text");

  if (!action || action === "help") {
    console.error(
      "Usage: lupin platform <list|install|remove|enable|disable|update|doctor> [args]\n\n" +
      "Commands:\n" +
      "  list                       Show registered platforms\n" +
      "  install <path|package>     Register a local platform or install an npm package\n" +
      "  remove <name>              Remove an installed platform, or disable a built-in one\n" +
      "  enable <name>              Re-enable a disabled platform\n" +
      "  disable <name>             Disable a platform without uninstalling it\n" +
      "  update <name|--all>        Revalidate or update registered platforms\n" +
      "  update --check [name]      Check platform update availability\n\n" +
      "  doctor <name|--all>        Inspect platform health, optionally with --smoke\n\n" +
      "Options:\n" +
      "  --json                     Output machine-readable JSON\n" +
      "  --updates                  Include update availability in platform list\n" +
      "  --smoke                    Run manifest-declared smoke tests"
    );
    process.exitCode = action ? 0 : 1;
    return;
  }

  try {
    if (action === "list") {
      const result = await listPlatforms(stateDir, { checkUpdates: hasFlag(flags, "--updates") });
      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const platform of result.platforms) {
        const version = platform.version ? `, v${platform.version}` : "";
        const update = platform.updateAvailable ? ", update available" : "";
        console.log(`${platform.name} (${platform.sourceKind}, ${platform.status}${version}${update})`);
        if (platform.updateCheck?.degraded) {
          console.log(`  update check degraded: ${platform.updateCheck.error}`);
        }
        if (platform.tools.search.length || platform.tools.fetch.length) {
          const aliases = [
            ...platform.tools.search.map((tool) => tool.alias),
            ...platform.tools.fetch.map((tool) => tool.alias),
          ];
          console.log(`  aliases: ${[...new Set(aliases)].join(", ")}`);
        }
      }

      if (result.issues.length) {
        console.log("\nIssues:");
        for (const issue of result.issues) {
          console.log(`- ${issue.manifestPath}: ${issue.error}`);
        }
      }
      return;
    }

    if (action === "install") {
      const specifier = flags.find((value) => !value.startsWith("--"));
      const result = await installPlatform(stateDir, specifier);
      console.log(
        format === "json"
          ? JSON.stringify(result, null, 2)
          : `Installed platform "${result.manifestName}" from ${result.kind === "npm" ? result.packageName : result.location}.`
      );
      return;
    }

    if (action === "enable" || action === "disable") {
      const name = flags.find((value) => !value.startsWith("--"));
      if (!name) {
        throw new Error(`Usage: lupin platform ${action} <name>`);
      }
      const result = await setPlatformEnabled(stateDir, name, action === "enable");
      console.log(
        format === "json"
          ? JSON.stringify(result, null, 2)
          : `Platform "${result.name}" ${result.enabled ? "enabled" : "disabled"}.`
      );
      return;
    }

    if (action === "doctor") {
      const doctorAll = hasFlag(flags, "--all");
      const runSmoke = hasFlag(flags, "--smoke");
      const name = flags.find((value) => !value.startsWith("--"));
      if (!doctorAll && !name) {
        throw new Error("Usage: lupin platform doctor <name|--all> [--smoke]");
      }

      const result = await doctorPlatforms(stateDir, doctorAll ? null : [name]);
      if (runSmoke) {
        await runPlatformSmokeChecks(result, stateDir);
      }

      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      for (const platform of result.platforms) {
        console.log(`${platform.name}: ${platform.status} (${platform.sourceKind}, v${platform.version || "unknown"})`);
        for (const check of platform.checks) {
          console.log(`  ${check.name}: ${check.status} - ${check.message}`);
        }
      }
      return;
    }

    if (action === "update") {
      const checkOnly = hasFlag(flags, "--check");
      const updateAll = hasFlag(flags, "--all");
      const name = flags.find((value) => !value.startsWith("--"));
      if (checkOnly) {
        const result = await checkPlatformUpdates(stateDir, name ? [name] : null);
        if (format === "json") {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        for (const item of result.platforms) {
          const latest = item.latestVersion ? ` latest ${item.latestVersion}` : " latest unknown";
          const status = item.updateAvailable ? "update available" : "current/no remote update";
          const degraded = item.updateCheck?.degraded ? ` (degraded: ${item.updateCheck.error})` : "";
          console.log(`${item.name}: ${status}, installed ${item.version || "unknown"},${latest}${degraded}`);
        }
        return;
      }

      if (!updateAll && !name) {
        throw new Error("Usage: lupin platform update <name|--all|--check>");
      }
      const result = updateAll
        ? await updatePlatforms(stateDir)
        : await updatePlatform(stateDir, name);
      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const results = Array.isArray(result.platforms) ? result.platforms : [result];
      for (const item of results) {
        const version = item.oldVersion || item.newVersion
          ? ` (${item.oldVersion || "unknown"} -> ${item.newVersion || item.oldVersion || "unknown"})`
          : "";
        const suffix = item.error ? `: ${item.error}` : item.message ? `: ${item.message}` : "";
        console.log(`${item.name}: ${item.status}${version}${suffix}`);
      }
      return;
    }

    if (action === "remove") {
      const name = flags.find((value) => !value.startsWith("--"));
      if (!name) {
        throw new Error("Usage: lupin platform remove <name>");
      }
      const result = await removePlatform(stateDir, name);
      console.log(
        format === "json"
          ? JSON.stringify(result, null, 2)
          : result.removed
            ? `Platform "${result.name}" removed.`
            : `Built-in platform "${result.name}" disabled.`
      );
      return;
    }

    throw new Error(`Unknown platform action: ${action}`);
  } catch (error) {
    console.error(format === "json" ? JSON.stringify({ error: error.message }, null, 2) : error.message);
    process.exitCode = 1;
  }
}

async function runDownload(url, flags) {
  url = normalizeUrl(url ?? "");
  if (!url || !looksLikeUrl(url)) {
    console.error(
      "Usage: lupin download <url> [options]\n\n" +
      "Options:\n" +
      "  --output-dir <dir>   Directory to save the file (default: current directory)\n" +
      "  --audio-only         Extract audio only as MP3\n" +
      "  --subtitles          Download subtitles if available\n" +
      "  --timeout <ms>       Download timeout in milliseconds (default: 300000)\n" +
      "  --quiet              Suppress yt-dlp progress output on stderr"
    );
    process.exitCode = 1;
    return;
  }

  if (hasFlag(flags, "--extract") || hasFlag(flags, "--schema")) {
    console.error("Error: --extract and --schema are not supported with download.\nVideo files are binary — not text content.");
    process.exitCode = 1;
    return;
  }

  const timeoutRaw = readFlag(flags, "--timeout");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutRaw && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    console.error(`Invalid --timeout value: ${timeoutRaw} (must be a positive number of milliseconds)`);
    process.exitCode = 1;
    return;
  }

  const stateDir = resolveStateDir();
  const ytdlpStatus = getYtDlpStatus({ stateDir });

  if (!ytdlpStatus.ok) {
    console.error("Video support is not installed.\nRun: lupin setup --with-video");
    process.exitCode = 1;
    return;
  }

  const quiet = hasFlag(flags, "--quiet");
  const onProgress = quiet ? undefined : (chunk) => process.stderr.write(chunk);

  try {
    const result = await downloadVideo(url, {
      outputDir: readFlag(flags, "--output-dir"),
      audioOnly: hasFlag(flags, "--audio-only"),
      subtitles: hasFlag(flags, "--subtitles"),
      timeoutMs,
      onProgress,
    }, { stateDir });

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error?.message || String(error),
    }, null, 2));
    process.exitCode = 1;
  }
}

function parseCrawlFlags(args) {
  const includeRaw = readFlag(args, "--include");
  const excludeRaw = readFlag(args, "--exclude");
  return {
    depth: Number(readFlag(args, "--depth", "3")),
    limit: Number(readFlag(args, "--limit", "100")),
    scope: readFlag(args, "--scope", "same-hostname"),
    include: includeRaw ? includeRaw.split(",") : [],
    exclude: excludeRaw ? excludeRaw.split(",") : [],
    concurrency: Number(readFlag(args, "--concurrency", "3")),
    delay: Number(readFlag(args, "--delay", "0")) * 1000,
    outputFile: readFlag(args, "-o") || readFlag(args, "--output"),
    format: readFormatFlag(args, "json"),
    engine: readFlag(args, "--engine", "auto"),
    ignoreQueryParams: hasFlag(args, "--ignore-query-params"),
    noRobots: hasFlag(args, "--ignore-robots"),
    noSitemap: hasFlag(args, "--no-sitemap"),
    fromFile: readFlag(args, "--from"),
    proxy: readFlag(args, "--proxy"),
    proxyList: readFlag(args, "--proxy-list"),
    proxyStrategy: readFlag(args, "--proxy-rotate"),
    // LLM extraction flags
    extract: readFlag(args, "--extract"),
    schema: parseCrawlSchema(readFlag(args, "--schema")),
    llm: readFlag(args, "--llm"),
    llmTimeout: Number(readFlag(args, "--llm-timeout", "0")) || undefined,
  };
}

function parseCrawlSchema(value) {
  if (!value) return undefined;
  try {
    if (value.startsWith("{") || value.startsWith("[")) {
      return JSON.parse(value);
    }
    return JSON.parse(readFileSync(value, "utf8"));
  } catch (err) {
    throw new Error(`Invalid --schema: ${err.message}`);
  }
}

function extractUrlArg(args) {
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      const normalized = normalizeUrl(arg);
      if (looksLikeUrl(normalized)) return normalized;
    }
  }
  return null;
}

function formatProgress(index, total, url, ok) {
  const icon = ok ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m";
  return `[${index}/${total}] ${icon} ${url}\n`;
}

async function runCrawl(args) {
  let flags;
  try {
    flags = parseCrawlFlags(args);
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (flags.fromFile) {
    return runCrawlFromFile(flags);
  }

  const url = extractUrlArg(args);
  if (!url) {
    console.error(
      "Usage: lupin crawl <url> [options]\n\n" +
      "Options:\n" +
      "  --depth <N>          Max crawl depth (default: 3)\n" +
      "  --limit <N>          Max pages to crawl (default: 100)\n" +
      "  --scope <strategy>   Scope strategy (default: same-hostname)\n" +
      "  --include <globs>    Comma-separated include globs\n" +
      "  --exclude <globs>    Comma-separated exclude globs\n" +
      "  --concurrency <N>    Parallel requests (default: 3)\n" +
      "  --delay <seconds>    Delay between requests\n" +
      "  --engine <name>      Scraping engine (default: auto)\n" +
      "  --format <fmt>       Output format: json, markdown, html\n" +
      "  -o, --output <file>  Write output to file\n" +
      "  --from <file>        Read URLs from file (one per line)\n" +
      "  --ignore-query-params  Treat URLs with different query params as same\n" +
      "  --ignore-robots      Ignore robots.txt rules\n" +
      "  --no-sitemap         Skip sitemap discovery\n" +
      "  --extract <prompt>   LLM extraction prompt for each page\n" +
      "  --schema <json|file> JSON Schema for structured LLM extraction\n" +
      "  --llm <provider>     LLM provider name\n" +
      "  --llm-timeout <ms>   LLM inference timeout\n\n" +
      "Proxy options:\n" +
      "  --proxy <url>             Proxy URL\n" +
      "  --proxy-list <file>       File with one proxy per line, or comma-separated list\n" +
      "  --proxy-rotate <strategy> Rotation strategy for proxy list"
    );
    process.exitCode = 1;
    return;
  }

  const proxyConfig = await resolveProxyFlags(flags.proxy, flags.proxyList, flags.proxyStrategy);

  const hasLlm = Boolean(flags.extract || flags.schema);
  const stateDir = hasLlm ? resolveStateDir() : undefined;

  const session = new CrawlSession({
    url,
    mode: "crawl",
    depth: flags.depth,
    limit: flags.limit,
    scope: flags.scope,
    include: flags.include,
    exclude: flags.exclude,
    concurrency: flags.concurrency,
    delay: flags.delay,
    format: flags.format,
    outputFile: flags.outputFile,
    outputFormat: flags.format === "markdown" || flags.format === "html" ? "jsonl" : "json",
    engine: flags.engine,
    ignoreQueryParams: flags.ignoreQueryParams,
    respectRobots: !flags.noRobots,
    useSitemap: !flags.noSitemap,
    scraperOptions: proxyConfig,
    // LLM extraction options
    extract: flags.extract,
    schema: flags.schema,
    llm: flags.llm,
    llmTimeout: flags.llmTimeout,
    stateDir,
    onProgress(index, total, url, ok) {
      process.stderr.write(formatProgress(index, total, url, ok));
    },
    onLlmProgress: hasLlm
      ? (url) => { process.stderr.write(`\x1b[2m⠋ Extracting (${url})...\x1b[0m\n`); }
      : undefined,
  });

  try {
    const result = await session.run();

    if (!flags.outputFile) {
      const output = result.results || [];
      console.log(JSON.stringify(output, null, 2));
    }

    const s = result.summary;
    process.stderr.write(
      `\nCrawl complete: ${s.succeeded} succeeded, ${s.failed} failed out of ${s.total}\n`
    );

    if (s.failed > 0 && result.summary.errorBreakdown) {
      process.stderr.write("Error breakdown:\n");
      for (const [reason, count] of Object.entries(result.summary.errorBreakdown)) {
        process.stderr.write(`  ${reason}: ${count}\n`);
      }
    }

    if (result.failures?.length) {
      const failPath = flags.outputFile
        ? flags.outputFile.replace(/\.[^.]+$/, "") + ".failures.txt"
        : "crawl-failures.txt";
      await fs.writeFile(failPath, result.failures.join("\n") + "\n");
      process.stderr.write(`Failed URLs written to ${failPath}\n`);
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

async function runCrawlFromFile(flags) {
  let lines;
  try {
    const content = await fs.readFile(flags.fromFile, "utf8");
    lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (error) {
    console.error(`Failed to read URL file: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  if (lines.length === 0) {
    console.error("No URLs found in file.");
    process.exitCode = 1;
    return;
  }

  const proxyConfig = await resolveProxyFlags(flags.proxy, flags.proxyList, flags.proxyStrategy);
  const browserManager = new BrowserManager(proxyConfig);
  const scraper = new Lupin({
    browserManager,
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });

  const hasLlm = Boolean(flags.extract || flags.schema);
  const stateDir = hasLlm ? resolveStateDir() : undefined;

  const outputFormat = flags.outputFile?.endsWith(".jsonl") ? "jsonl" : "json";
  const writer = new CrawlOutputWriter(flags.outputFile, { format: outputFormat });
  await writer.open();

  let succeeded = 0;
  let failed = 0;
  const failures = [];

  try {
    for (let i = 0; i < lines.length; i++) {
      const url = normalizeUrl(lines[i]);
      if (!looksLikeUrl(url)) {
        process.stderr.write(formatProgress(i + 1, lines.length, lines[i], false));
        failed++;
        failures.push(lines[i]);
        continue;
      }

      try {
        const result = await scraper.scrape(url, { engine: flags.engine });
        const { data } = formatCrawlResult(result, { depth: 0 }, flags.format);

        if (hasLlm) {
          process.stderr.write(`\x1b[2m⠋ Extracting (${url})...\x1b[0m\n`);
          const llmInput = buildScrapeMarkdown(result);
          const llmStartMs = Date.now();
          try {
            const llmResult = await runLlm(llmInput, {
              prompt: flags.extract,
              schema: flags.schema,
              llm: flags.llm,
              stateDir,
              timeoutMs: flags.llmTimeout,
            });
            data.content = llmResult.result;
            data.llm = {
              model: llmResult.model,
              provider: llmResult.provider,
              prompt: flags.extract || undefined,
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
        }

        await writer.write(data);
        succeeded++;
        process.stderr.write(formatProgress(i + 1, lines.length, url, true));
      } catch (error) {
        if (error instanceof LlmConfigError) throw error;
        failed++;
        failures.push(url);
        await writer.write({ url, error: error.message || "scrape failed" });
        process.stderr.write(formatProgress(i + 1, lines.length, url, false));
      }

      if (flags.delay > 0) await new Promise((r) => setTimeout(r, flags.delay));
    }

    const results = await writer.close();
    if (!flags.outputFile && results) {
      console.log(JSON.stringify(results, null, 2));
    }

    process.stderr.write(`\nCrawl complete: ${succeeded} succeeded, ${failed} failed out of ${succeeded + failed}\n`);

    if (failures.length) {
      const failPath = flags.outputFile
        ? flags.outputFile.replace(/\.[^.]+$/, "") + ".failures.txt"
        : "crawl-failures.txt";
      await fs.writeFile(failPath, failures.join("\n") + "\n");
      process.stderr.write(`Failed URLs written to ${failPath}\n`);
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await scraper.close();
  }
}

async function runLlmCommand(action, flags) {
  const stateDir = resolveStateDir();

  if (action === "add") {
    const name = flags[0];
    if (!name) {
      console.error("Usage: lupin llm add <name> --base-url <url> --model <model> [--api-key <key>] [--default]");
      process.exitCode = 1;
      return;
    }
    const baseUrl = readFlag(flags, "--base-url");
    const model = readFlag(flags, "--model");
    if (!baseUrl || !model) {
      console.error("Required: --base-url and --model");
      process.exitCode = 1;
      return;
    }
    addProvider(stateDir, name, {
      baseUrl,
      model,
      apiKey: readFlag(flags, "--api-key"),
      setAsDefault: hasFlag(flags, "--default"),
    });
    console.log(`Provider "${name}" added.${hasFlag(flags, "--default") ? " Set as default." : ""}`);
    return;
  }

  if (action === "list") {
    const info = listProviders(stateDir);
    console.log(`  default → ${info.default || "(none)"}\n`);
    for (const [name, prov] of Object.entries(info.providers)) {
      console.log(`  ${name.padEnd(12)} ${prov.model.padEnd(25)} ${prov.baseUrl}`);
    }
    if (Object.keys(info.providers).length === 0) {
      console.log("  No providers configured.");
      console.log("  Add one: lupin llm add <name> --base-url <url> --model <model>");
    }
    return;
  }

  if (action === "remove") {
    const name = flags[0];
    if (!name) {
      console.error("Usage: lupin llm remove <name>");
      process.exitCode = 1;
      return;
    }
    removeProvider(stateDir, name);
    console.log(`Provider "${name}" removed.`);
    return;
  }

  if (action === "default") {
    const name = flags[0];
    if (!name) {
      console.error("Usage: lupin llm default <name>");
      process.exitCode = 1;
      return;
    }
    try {
      setDefault(stateDir, name);
      console.log(`Default provider set to "${name}".`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
    return;
  }

  console.error(
    "Usage: lupin llm <action>\n\n" +
    "Actions:\n" +
    "  add <name>       Add a remote LLM provider\n" +
    "  list             Show configured providers\n" +
    "  remove <name>    Remove a provider\n" +
    "  default <name>   Set the default provider"
  );
  process.exitCode = 1;
}

async function runMap(args) {
  const flags = parseCrawlFlags(args);
  // Map defaults to higher limit
  if (!args.includes("--limit")) {
    flags.limit = 500;
  }

  const url = extractUrlArg(args);
  if (!url) {
    console.error(
      "Usage: lupin map <url> [options]\n\n" +
      "Options:\n" +
      "  --depth <N>          Max crawl depth (default: 3)\n" +
      "  --limit <N>          Max URLs to discover (default: 500)\n" +
      "  --scope <strategy>   Scope strategy (default: same-hostname)\n" +
      "  --include <globs>    Comma-separated include globs\n" +
      "  --exclude <globs>    Comma-separated exclude globs\n" +
      "  --delay <seconds>    Delay between requests\n" +
      "  -o, --output <file>  Write output to file\n" +
      "  --ignore-query-params  Treat URLs with different query params as same\n" +
      "  --ignore-robots      Ignore robots.txt rules\n" +
      "  --no-sitemap         Skip sitemap discovery"
    );
    process.exitCode = 1;
    return;
  }

  if (hasFlag(args, "--extract") || hasFlag(args, "--schema")) {
    console.error("Error: --extract and --schema are not supported with map.\nMap discovers URLs only — no page content to extract from.");
    process.exitCode = 1;
    return;
  }

  const session = new CrawlSession({
    url,
    mode: "map",
    depth: flags.depth,
    limit: flags.limit,
    scope: flags.scope,
    include: flags.include,
    exclude: flags.exclude,
    delay: flags.delay,
    ignoreQueryParams: flags.ignoreQueryParams,
    respectRobots: !flags.noRobots,
    useSitemap: !flags.noSitemap,
    onProgress(index, total, url, ok) {
      process.stderr.write(formatProgress(index, total, url, ok));
    },
  });

  try {
    const result = await session.run();
    const output = result.urls.join("\n");

    if (flags.outputFile) {
      await fs.writeFile(flags.outputFile, output + "\n");
      process.stderr.write(`URLs written to ${flags.outputFile}\n`);
    } else {
      console.log(output);
    }

    process.stderr.write(`\nMap complete: ${result.summary.total} URLs discovered\n`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}
