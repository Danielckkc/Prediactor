export const SEARCH_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query." },
    limit: { type: "number", default: 10, description: "Max number of results (default 10, max 200). Higher limits fetch multiple pages." },
    dateFrom: { type: "string", description: "Start date filter (YYYY-MM-DD)." },
    dateTo: { type: "string", description: "End date filter (YYYY-MM-DD)." },
    sort: {
      type: "string",
      enum: ["relevance", "recent"],
      default: "relevance",
      description: "Sort order.",
    },
    engine: { type: "string", description: "Explicit search engine override." },
    preferredEngines: {
      type: "array",
      description: "Ordered list of preferred search engines (for search_web).",
      items: { type: "string" },
    },
    site: { type: "string", description: "Restrict results to this domain (e.g. 'reddit.com')." },
    includeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Only include results from these domains.",
    },
    excludeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Exclude results from these domains.",
    },
  },
  required: ["query"],
};
