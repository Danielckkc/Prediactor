import { SEARCH_TOOL_INPUT_SCHEMA } from "../../schemas/search.js";
import { searchGoogle } from "../../providers/google/search.js";
import { searchWeb } from "../../providers/web/search.js";
import * as platformSdk from "../../platform-sdk.js";
import { loadPlatformRegistry } from "../../platforms/registry.js";
import { attachPlatformFailureHint } from "../../platforms/failure-hints.js";

const CORE_SEARCH_TOOLS = [
  {
    name: "search_google",
    description:
      "Search Google directly. Returns ranked results with title, URL, and snippet. " +
      "Supports site restriction, date filters, and relevance/recent sort.",
    inputSchema: SEARCH_TOOL_INPUT_SCHEMA,
    browserRequirements: { camoufox: true },
  },
  {
    name: "search_web",
    description:
      "General-purpose web search. Returns ranked results with title, URL, and snippet. " +
      "Use platform-specific search tools (search_reddit, search_hn, etc.) " +
      "when you know the target platform.",
    inputSchema: SEARCH_TOOL_INPUT_SCHEMA,
    browserRequirements: { camoufox: true },
  },
];

export async function getSearchTools(context = {}) {
  const registry = await loadPlatformRegistry({ stateDir: context.stateDir });
  return [
    ...CORE_SEARCH_TOOLS.map(({ browserRequirements: _browserRequirements, ...tool }) => tool),
    ...registry.listSearchTools(),
  ];
}

export async function getSearchToolBrowserRequirements(name, context = {}) {
  const coreTool = CORE_SEARCH_TOOLS.find((tool) => tool.name === name);
  if (coreTool) return coreTool.browserRequirements || {};

  const registry = await loadPlatformRegistry({ stateDir: context.stateDir });
  return registry.getToolBrowserRequirements(name);
}

export async function callSearchTool(name, args, context = {}) {
  if (name === "search_google") {
    return searchGoogle(args.query, args, context.browserManager);
  }

  if (name === "search_web") {
    return searchWeb(args.query, args, context.browserManager);
  }

  const registry = await loadPlatformRegistry({ stateDir: context.stateDir });
  const tool = registry.getSearchTool(name);
  if (!tool) {
    throw new Error(`Unknown search tool: ${name}`);
  }

  try {
    return await tool.execute(args, {
      ...context,
      fetcher: context.fetcher || context.scraper?.fetch?.bind(context.scraper) || fetch,
      sdk: platformSdk,
    });
  } catch (error) {
    const platform = registry.listPlatforms().find((item) => item.name === tool.platformName);
    throw attachPlatformFailureHint(error, platform);
  }
}
