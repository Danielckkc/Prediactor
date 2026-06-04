import { CRAWL_SITE_INPUT_SCHEMA, MAP_SITE_INPUT_SCHEMA } from "../../schemas/crawl.js";
import { CrawlSession } from "../../crawl/crawler.js";

export function getCrawlTools() {
  return [
    {
      name: "crawl_site",
      description:
        "Crawl a website by following links from a start URL. " +
        "Returns { results, summary, failures }. " +
        "results is an array of page objects (url, title, depth, content or error). " +
        "summary has total/succeeded/failed counts. failures lists error details. " +
        "Use map_site first to preview which URLs will be crawled.",
      inputSchema: CRAWL_SITE_INPUT_SCHEMA,
    },
    {
      name: "map_site",
      description:
        "Discover all reachable URLs on a website without scraping content. " +
        "Fast HTTP-only link following. Returns a list of URLs found. " +
        "Use this to preview crawl scope before running crawl_site.",
      inputSchema: MAP_SITE_INPUT_SCHEMA,
    },
  ];
}

export async function callCrawlTool(name, args, context = {}) {
  if (name === "map_site") {
    const session = new CrawlSession({
      url: args.url,
      mode: "map",
      depth: args.depth ?? 3,
      limit: args.limit ?? 500,
      scope: args.scope || "same-hostname",
      include: args.include || [],
      exclude: args.exclude || [],
    });
    try {
      return await session.run();
    } finally {
      await session.close();
    }
  }

  if (name === "crawl_site") {
    const session = new CrawlSession({
      url: args.url,
      mode: "crawl",
      depth: args.depth ?? 3,
      limit: args.limit ?? 100,
      scope: args.scope || "same-hostname",
      include: args.include || [],
      exclude: args.exclude || [],
      format: args.format || "markdown",
      concurrency: args.concurrency ?? 3,
      delay: (args.delay ?? 0) * 1000,
      engine: args.engine || "auto",
      scraper: context.scraper,
      // LLM extraction options
      extract: args.extract,
      schema: args.schema,
      llm: args.llm,
      llmTimeout: args.llmTimeout,
      stateDir: context.stateDir,
    });
    try {
      return await session.run();
    } finally {
      await session.close();
    }
  }

  throw new Error(`Unknown crawl tool: ${name}`);
}
