export const CRAWL_SITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "Start URL for the crawl." },
    depth: { type: "number", default: 3, description: "Max link-graph depth from the start URL." },
    limit: { type: "number", default: 100, description: "Max pages to crawl." },
    scope: {
      type: "string",
      enum: ["same-hostname", "same-domain", "prefix"],
      default: "same-hostname",
      description: "URL scope strategy. 'same-hostname' stays on the exact host, 'same-domain' includes subdomains, 'prefix' stays under the start URL path.",
    },
    include: { type: "array", items: { type: "string" }, description: "Glob patterns on URL pathname to include (e.g. '/docs/**')." },
    exclude: { type: "array", items: { type: "string" }, description: "Glob patterns on URL pathname to exclude (e.g. '/admin/**')." },
    format: {
      type: "string",
      enum: ["json", "markdown", "html"],
      default: "markdown",
      description: "Content format for each crawled page.",
    },
    concurrency: { type: "number", default: 3, description: "Max parallel page scrapes." },
    delay: { type: "number", default: 0, description: "Delay between requests in seconds." },
    engine: {
      type: "string",
      enum: ["auto", "http", "camoufox", "fallback"],
      default: "auto",
      description: "Scraping engine.",
    },
    extract: {
      type: "string",
      description: "Free-form LLM prompt to run against each crawled page's content.",
    },
    schema: {
      type: "object",
      description: "JSON Schema for structured LLM extraction on each crawled page.",
    },
    llm: {
      type: "string",
      description: "LLM provider name (uses default from config if omitted).",
    },
    llmTimeout: {
      type: "number",
      description: "LLM inference timeout in milliseconds (provider default if omitted).",
    },
  },
  required: ["url"],
};

export const MAP_SITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "Start URL for URL discovery." },
    depth: { type: "number", default: 3, description: "Max link-graph depth." },
    limit: { type: "number", default: 500, description: "Max URLs to discover." },
    scope: {
      type: "string",
      enum: ["same-hostname", "same-domain", "prefix"],
      default: "same-hostname",
      description: "URL scope strategy.",
    },
    include: { type: "array", items: { type: "string" }, description: "Glob patterns on URL pathname to include." },
    exclude: { type: "array", items: { type: "string" }, description: "Glob patterns on URL pathname to exclude." },
  },
  required: ["url"],
};
