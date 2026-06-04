import { htmlToMarkdown, buildScrapeMarkdown } from "../../runtime/markdown.js";
import { extractStructuredJson } from "../../runtime/extract-structured.js";
import { renderPageMarkdown } from "../../runtime/render-structured.js";
import { createFetchResponse } from "../base/result-shapes.js";
import { snapshotDateUtc } from "../base/fallbacks.js";
import { run as runLlm } from "../../llm/index.js";
import { LlmConfigError } from "../../llm/errors.js";

function buildContentForFormat(result, format) {
  if (format === "html") return result.rawHtml || "";
  if (format === "markdown") return buildScrapeMarkdown(result);
  // json
  const structured = result.rawHtml ? extractStructuredJson(result.rawHtml, result.url) : null;
  if (structured) {
    return {
      ...structured.metadata,
      url: result.url,
      text: result.text,
      headings: structured.headings,
      links: structured.links,
      images: structured.images,
      status: result.status,
    };
  }
  return { title: result.title, url: result.url, text: result.text, status: result.status };
}

export async function fetchPage(scraper, url, options = {}) {
  const startedAt = Date.now();
  const hasLlm = Boolean(options.extract || options.schema);
  const format = options.format || "json";

  const result = await scraper.scrape(url, {
    engine: options.engine,
    timeout: options.timeout,
    waitFor: options.waitFor,
    screenshot: options.screenshot,
    screenshotFullPage: options.screenshotFullPage,
    screenshotFormat: options.screenshotFormat,
    screenshotQuality: options.screenshotQuality,
  });

  let content;
  let llmMeta;

  if (hasLlm) {
    const llmInput = buildScrapeMarkdown(result);
    const llmStartMs = Date.now();
    try {
      const llmResult = await runLlm(llmInput, {
        prompt: options.extract,
        schema: options.schema,
        llm: options.llm,
        stateDir: options.stateDir,
        timeoutMs: options.llmTimeout,
      });
      content = llmResult.result;
      llmMeta = {
        model: llmResult.model,
        provider: llmResult.provider,
        prompt: options.extract || undefined,
        durationMs: llmResult.durationMs,
      };
    } catch (error) {
      if (error instanceof LlmConfigError) throw error;
      llmMeta = {
        model: null,
        provider: null,
        error: error.message,
        durationMs: Date.now() - llmStartMs,
      };
      content = null;
    }
  } else {
    content = buildContentForFormat(result, format);
  }

  const response = createFetchResponse(
    "page",
    url,
    result.url,
    snapshotDateUtc(),
    format,
    content,
    {
      startedAt,
      warnings: result.warnings,
      blocked: result.blocked,
      screenshotBuffer: result.screenshotBuffer,
      screenshotMimeType: result.screenshotMimeType,
      screenshotFormat: result.screenshotFormat,
      extraction: {
        method: result.engine,
        confidence: result.confidence,
      },
    }
  );

  if (llmMeta) {
    response.llm = llmMeta;
  }

  return response;
}
