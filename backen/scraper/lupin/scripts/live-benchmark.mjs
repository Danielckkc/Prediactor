import assert from "node:assert/strict";
import process from "node:process";

import { parseToolText, withLiveMcpClient } from "../test-support/live-mcp.js";

const PROFILES = {
  balanced: [
    {
      id: "search_web_example",
      tool: "search_web",
      args: { query: "\"Example Domain\"", site: "example.com", limit: 5 },
      validate(result) {
        assert.equal(result.provider, "web");
        assert.ok(Array.isArray(result.attemptedEngines));
        assert.ok(result.attemptedEngines.length >= 1);
        assert.ok(result.results.some((item) => /example\.com/.test(item.url)));
      },
    },
    {
      id: "search_google_example",
      tool: "search_google",
      args: { query: "\"Example Domain\"", site: "example.com", limit: 5 },
      validate(result) {
        assert.equal(result.provider, "google");
        if (result.blocked) {
          assert.ok(result.warnings.length > 0);
          return;
        }
        assert.ok(result.results.some((item) => /example\.com/.test(item.url)));
      },
    },
    {
      id: "search_reddit_ux",
      tool: "search_reddit",
      args: { query: "ux design portfolio", limit: 5, sort: "recent" },
      validate(result) {
        assert.equal(result.provider, "reddit");
        assert.ok(Array.isArray(result.results));
        assert.ok(result.results.length > 0);
        assert.ok(result.results.some((item) => /reddit\.com\/r\//.test(item.url)));
      },
    },
    {
      id: "fetch_reddit_thread",
      tool: "fetch_reddit_post",
      args: {
        url: "https://www.reddit.com/r/node/comments/1iv5ge4/what_are_your_favorite_nodejs_libraries_right_now/",
        format: "json",
        maxComments: 3,
      },
      validate(result) {
        assert.equal(result.provider, "reddit");
        assert.equal(result.blocked, false);
        assert.ok(result.content.title);
        assert.ok(Array.isArray(result.content.comments));
      },
    },
    {
      id: "search_hn_karpathy",
      tool: "search_hn",
      args: { query: "karpathy", limit: 3, sort: "relevance" },
      validate(result) {
        assert.equal(result.provider, "hn");
        assert.ok(Array.isArray(result.results));
        assert.ok(result.results.length > 0);
        assert.ok(result.results.some((item) => /news\.ycombinator\.com\/item\?id=/.test(item.url)));
      },
    },
    {
      id: "fetch_hn_item",
      tool: "fetch_hn_item",
      args: {
        url: "https://news.ycombinator.com/item?id=42861475",
        format: "json",
        maxComments: 3,
      },
      validate(result) {
        assert.equal(result.provider, "hn");
        assert.equal(result.blocked, false);
        assert.ok(result.content.title);
        assert.ok(Array.isArray(result.content.comments));
      },
    },
    {
      id: "search_youtube_karpathy",
      tool: "search_youtube",
      args: { query: "karpathy", limit: 3, sort: "relevance" },
      validate(result) {
        assert.equal(result.provider, "youtube");
        assert.ok(Array.isArray(result.results));
        assert.ok(result.results.length > 0);
        assert.ok(result.results.some((item) => /youtube\.com\/watch\?v=/.test(item.url)));
      },
    },
    {
      id: "fetch_youtube_video",
      tool: "fetch_youtube_video",
      args: {
        url: "https://www.youtube.com/watch?v=zjkBMFhNj_g",
        format: "json",
      },
      validate(result) {
        assert.equal(result.provider, "youtube");
        assert.equal(result.blocked, false);
        assert.ok(result.content.title);
        assert.ok(result.content.author?.name);
        assert.ok("viewCount" in result.content.stats);
      },
    },
    {
      id: "search_x_recent",
      tool: "search_x",
      args: { query: "UX UI best practice", sort: "recent", limit: 5 },
      validate(result) {
        assert.equal(result.provider, "x");
        assert.ok(Array.isArray(result.results));
        if (result.blocked || result.results.length === 0) {
          assert.ok(result.warnings.length > 0);
          return;
        }
        assert.ok(result.results.some((item) => /x\.com/.test(item.url)));
      },
    },
    {
      id: "fetch_tiktok_post",
      tool: "fetch_tiktok_post",
      args: {
        url: "https://www.tiktok.com/@scout2015/video/6718335390845095173",
        format: "json",
      },
      validate(result) {
        assert.equal(result.provider, "tiktok");
        assert.equal(result.blocked, false);
        assert.equal(result.content.entityType, "video");
        assert.ok(result.content.author.handle?.startsWith("@"));
        assert.ok(Array.isArray(result.content.media));
      },
    },
  ],
};

function parseArgs(argv) {
  const options = {
    profile: "balanced",
    output: "json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--profile" && argv[index + 1]) {
      options.profile = argv[index + 1];
      index += 1;
      continue;
    }
    if (current === "--output" && argv[index + 1]) {
      options.output = argv[index + 1];
      index += 1;
      continue;
    }
    if (current === "--fail-on-error") {
      options.failOnError = true;
    }
  }

  if (!PROFILES[options.profile]) {
    throw new Error(`Unknown benchmark profile: ${options.profile}`);
  }

  return options;
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return sortedValues[index];
}

function median(sortedValues) {
  if (sortedValues.length === 0) return 0;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle];
  return Math.round((sortedValues[middle - 1] + sortedValues[middle]) / 2);
}

function computeSummary(profile, requests) {
  const latencies = requests.map((request) => request.durationMs).sort((left, right) => left - right);
  const passCount = requests.filter((request) => request.ok).length;
  const blockedCount = requests.filter((request) => request.blocked).length;
  const totalDurationMs = requests.reduce((sum, request) => sum + request.durationMs, 0);
  const errorCount = requests.length - passCount;
  const score = passCount * 1_000_000 - totalDurationMs;

  return {
    profile,
    requestCount: requests.length,
    passCount,
    errorCount,
    blockedCount,
    passRate: Number((passCount / Math.max(1, requests.length)).toFixed(4)),
    totalDurationMs,
    medianDurationMs: median(latencies),
    p95DurationMs: percentile(latencies, 0.95),
    score,
    requests,
  };
}

async function runBenchmark(profileName, failOnError) {
  const definitions = PROFILES[profileName];
  const requests = [];

  await withLiveMcpClient(
    { skip(message) { throw new Error(message); } },
    { clientName: `lupin-benchmark-${profileName}`, statePrefix: `lupin-benchmark-${profileName}-` },
    async (client) => {
      for (const definition of definitions) {
        const startedAt = Date.now();
        try {
          const raw = await client.callTool({ name: definition.tool, arguments: definition.args });
          const result = parseToolText(raw);
          definition.validate(result);
          requests.push({
            id: definition.id,
            tool: definition.tool,
            durationMs: Date.now() - startedAt,
            ok: true,
            blocked: Boolean(result.blocked),
            warnings: result.warnings || [],
          });
        } catch (error) {
          const entry = {
            id: definition.id,
            tool: definition.tool,
            durationMs: Date.now() - startedAt,
            ok: false,
            blocked: false,
            error: error?.message || String(error),
          };
          requests.push(entry);
          if (failOnError) {
            throw error;
          }
        }
      }
    }
  );

  return computeSummary(profileName, requests);
}

const options = parseArgs(process.argv.slice(2));
const summary = await runBenchmark(options.profile, options.failOnError);

if (options.output === "metric") {
  console.log(summary.score);
} else if (options.output === "pretty") {
  console.log(
    [
      `profile=${summary.profile}`,
      `score=${summary.score}`,
      `pass=${summary.passCount}/${summary.requestCount}`,
      `blocked=${summary.blockedCount}`,
      `median_ms=${summary.medianDurationMs}`,
      `p95_ms=${summary.p95DurationMs}`,
      `total_ms=${summary.totalDurationMs}`,
    ].join(" ")
  );
} else {
  console.log(JSON.stringify(summary, null, 2));
}
