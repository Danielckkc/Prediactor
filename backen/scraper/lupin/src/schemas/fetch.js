const SCREENSHOT_PROPERTIES = {
  screenshot: { type: "boolean", default: false, description: "Capture a screenshot of the page after loading (browser engines only). Silently ignored for HTTP-only fetches." },
  screenshotFullPage: { type: "boolean", default: false, description: "Capture the full scrollable page height instead of only the viewport." },
  screenshotFormat: { type: "string", enum: ["png", "jpeg"], default: "png", description: "Screenshot image format." },
  screenshotQuality: { type: "number", description: "JPEG quality 0-100 (default 80). Ignored for PNG." },
};

// Base schema shared by all fetch tools (social providers, etc.)
// Does NOT include screenshot fields — those are only on fetch_page.
export const FETCH_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "URL to fetch." },
    format: {
      type: "string",
      enum: ["json", "markdown", "html"],
      default: "json",
      description: "Output format.",
    },
    engine: {
      type: "string",
      enum: ["auto", "http", "camoufox", "fallback", "fast", "patchright"],
      default: "auto",
      description: "Scraping engine. 'auto' escalates on failure. 'fast' = http, 'patchright' = fallback.",
    },
    timeout: { type: "number", description: "Timeout in milliseconds." },
    waitFor: { type: "string", description: "CSS selector to wait for before extraction." },
    maxComments: { type: "number", default: 10, description: "Max comments to return (for providers that support comments)." },
    maxRepliesPerComment: { type: "number", default: 1, description: "Max replies per comment (for providers that support threaded comments)." },
    minCommentLikes: { type: "number", default: 0, description: "Minimum likes threshold for comments. Comments below this are excluded." },
    extract: {
      type: "string",
      description: "Free-form LLM prompt to run against page content. Requires a configured LLM provider.",
    },
    schema: {
      type: "object",
      description: "JSON Schema for structured LLM extraction. The model output will conform to this schema.",
    },
    llm: {
      type: "string",
      description: "LLM provider name (uses default from ~/.lupin/llm.json if not specified).",
    },
    llmTimeout: {
      type: "number",
      description: "LLM inference timeout in milliseconds (default: 180000).",
    },
  },
  required: ["url"],
};

// Extended schema for fetch_page — includes screenshot options.
export const FETCH_PAGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ...FETCH_TOOL_INPUT_SCHEMA.properties,
    ...SCREENSHOT_PROPERTIES,
  },
  required: ["url"],
};
