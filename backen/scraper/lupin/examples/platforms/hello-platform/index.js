function titleFromUrl(value) {
  try {
    const pathname = new URL(value).pathname.split("/").filter(Boolean);
    const last = pathname.at(-1) || "post";
    return last
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  } catch {
    return "Example Post";
  }
}

export async function search(args, context) {
  const { createSearchResponse, snapshotDateUtc } = context.sdk;
  const query = String(args.query || "").trim();
  const encodedQuery = encodeURIComponent(query || "example");

  return createSearchResponse(
    "hello-example",
    query,
    "example-package",
    snapshotDateUtc(),
    [
      {
        rank: 1,
        title: `Hello Example result for "${query || "example"}"`,
        url: `https://example.com/hello/${encodedQuery}`,
        snippet: "This result came from the custom platform example package."
      }
    ],
    []
  );
}

export async function fetchPost(args, context) {
  const { createFetchResponse, snapshotDateUtc } = context.sdk;
  const url = String(args.url || "");

  return createFetchResponse(
    "hello-example",
    url,
    url,
    snapshotDateUtc(),
    args.format || "json",
    {
      entityType: "post",
      title: titleFromUrl(url),
      author: {
        name: "Hello Example",
        handle: "hello-example",
        url: "https://example.com/hello"
      },
      publishedAt: null,
      text: "This payload came from the example custom platform package bundled with the Lupin repo.",
      stats: {
        likes: 42
      },
      media: [],
      outboundLinks: [],
      comments: [],
      platform: {
        site: "hello-example",
        canonicalUrl: url
      }
    },
    {
      extraction: {
        method: "example-package",
        confidence: "high"
      }
    }
  );
}
