import { FETCH_PAGE_INPUT_SCHEMA } from "../../schemas/fetch.js";
import { fetchPage } from "../../providers/web/fetch.js";
import { run as runLlm, resolveProviderInfo } from "../../llm/index.js";
import { LlmConfigError } from "../../llm/errors.js";
import { resolveMedia, isMultimodalModel } from "../../llm/media.js";
import { probeProvider } from "../../llm/probe.js";
import * as platformSdk from "../../platform-sdk.js";
import { loadPlatformRegistry } from "../../platforms/registry.js";
import { attachPlatformFailureHint } from "../../platforms/failure-hints.js";

const CORE_FETCH_TOOLS = [
  {
    name: "fetch_page",
    description:
      "Fetch any web page as JSON, Markdown, or raw HTML. " +
      "For social media and known platforms, prefer the dedicated fetch tools instead.",
    inputSchema: FETCH_PAGE_INPUT_SCHEMA,
    browserRequirements: {},
  },
];

export async function getFetchTools(context = {}) {
  const registry = await loadPlatformRegistry({ stateDir: context.stateDir });
  return [
    ...CORE_FETCH_TOOLS.map(({ browserRequirements: _browserRequirements, ...tool }) => tool),
    ...registry.listFetchTools(),
  ];
}

export async function getFetchToolBrowserRequirements(name, context = {}) {
  const coreTool = CORE_FETCH_TOOLS.find((tool) => tool.name === name);
  if (coreTool) return coreTool.browserRequirements || {};

  const registry = await loadPlatformRegistry({ stateDir: context.stateDir });
  return registry.getToolBrowserRequirements(name);
}

export async function callFetchTool(name, args, context = {}) {
  // Early LLM availability check — fail fast before any expensive fetch work.
  // If the provider is misconfigured or unreachable, throw immediately so the
  // user doesn't wait through a full page load only to get content: null.
  const hasLlm = Boolean(args.extract || args.schema);
  if (hasLlm) {
    await probeProvider({ stateDir: context.stateDir, llm: args.llm });
  }

  // fetch_page handles LLM internally
  if (name === "fetch_page") {
    return fetchPage(context.scraper, args.url, { ...args, stateDir: context.stateDir });
  }

  const registry = await loadPlatformRegistry({ stateDir: context.stateDir });
  const tool = registry.getFetchTool(name);
  if (!tool) {
    throw new Error(`Unknown fetch tool: ${name}`);
  }

  // When LLM extraction is requested, force JSON format so the model sees the
  // full structured payload (comments, metadata, captions) instead of a lossy
  // markdown rendering.
  const providerArgs = hasLlm ? { ...args, format: "json" } : args;

  let result;
  try {
    result = await tool.execute(providerArgs, {
      ...context,
      fetcher: context.fetcher || context.scraper?.fetch?.bind(context.scraper) || fetch,
      sdk: platformSdk,
    });
  } catch (error) {
    const platform = registry.listPlatforms().find((item) => item.name === tool.platformName);
    throw attachPlatformFailureHint(error, platform);
  }

  // LLM post-processing for platform providers
  if (hasLlm && result) {
    const llmInput = JSON.stringify(result.content, null, 2);
    const llmStartMs = Date.now();
    try {
      // Resolve media for multimodal extraction only for remote providers
      // with known vision support. Skip text-only models to avoid HTTP 400s.
      let media;
      const providerMedia = result.content?.media;
      if (providerMedia?.length) {
        const providerInfo = resolveProviderInfo({ stateDir: context.stateDir, llm: args.llm });
        if (isMultimodalModel(providerInfo.model)) {
          media = await resolveMedia(providerMedia, {
            model: providerInfo.model,
            stateDir: context.stateDir,
            sourceUrl: args.url,
            entityType: result.content?.entityType,
          });
        }
      }

      const llmResult = await runLlm(llmInput, {
        prompt: args.extract,
        schema: args.schema,
        llm: args.llm,
        stateDir: context.stateDir,
        timeoutMs: args.llmTimeout,
        media,
      });
      result.content = llmResult.result;
      result.llm = {
        model: llmResult.model,
        provider: llmResult.provider,
        prompt: args.extract || undefined,
        durationMs: llmResult.durationMs,
      };
    } catch (error) {
      if (error instanceof LlmConfigError) throw error;
      result.content = null;
      result.llm = {
        model: null,
        provider: null,
        error: error.message,
        durationMs: Date.now() - llmStartMs,
      };
    }
  }

  return result;
}
