import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Lupin } from "./index.js";
import { BrowserManager } from "./runtime/browser-manager.js";
import {
  evaluateBrowserRequirements,
  formatDoctorReport,
  formatPreflightMessage,
  getDoctorReport,
} from "./runtime/browser-deps.js";
import { normalizeEngineName } from "./runtime/config.js";
import { BrowserSessionStore } from "./runtime/session-store.js";
import { callBrowserTool, getBrowserTools } from "./mcp/tools/browser-tools.js";
import {
  callSearchTool,
  getSearchToolBrowserRequirements,
  getSearchTools,
} from "./mcp/tools/search-tools.js";
import {
  callFetchTool,
  getFetchToolBrowserRequirements,
  getFetchTools,
} from "./mcp/tools/fetch-tools.js";
import { getYtDlpStatus } from "./runtime/video-deps.js";
import { callVideoTool, getVideoTools } from "./mcp/tools/video-tools.js";
import { callCrawlTool, getCrawlTools } from "./mcp/tools/crawl-tools.js";
import { version } from "./version.js";

function createDoctorReportFromManager(browserManager) {
  return getDoctorReport({
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });
}

function assertBrowserRequirements(browserManager, requirements, context) {
  if (!requirements.camoufox && !requirements.fallback) {
    return;
  }

  const report = createDoctorReportFromManager(browserManager);
  const readiness = evaluateBrowserRequirements(report, requirements);
  if (!readiness.ok) {
    throw new Error(formatPreflightMessage(report, context, requirements));
  }
}

async function getToolBrowserRequirements(name, args = {}, context = {}) {
  if (name === "browser_open_session") {
    const engine = normalizeEngineName(args.engine, "fallback");
    return {
      camoufox: engine === "camoufox",
      fallback: engine === "fallback",
    };
  }

  if (name === "crawl_site") {
    const engine = normalizeEngineName(args.engine, "auto");
    return {
      camoufox: engine === "camoufox",
      fallback: engine === "fallback",
    };
  }

  const searchRequirements = await getSearchToolBrowserRequirements(name, context);
  if (searchRequirements.camoufox || searchRequirements.fallback) return searchRequirements;

  const fetchRequirements = await getFetchToolBrowserRequirements(name, context);
  if (fetchRequirements.camoufox || fetchRequirements.fallback) return fetchRequirements;

  return {};
}

export async function startMcpServer() {
  // Patchright/Playwright may emit unhandled rejections when the browser
  // process crashes mid-CDP-call (e.g. Network.setCacheDisabled).  These
  // rejections are internal to the library and never surfaced through the
  // public API, so nothing in userland can catch them.  Without a handler
  // Node ≥15 terminates the process, taking the entire MCP server down.
  process.on("unhandledRejection", (reason) => {
    const msg = reason?.message || String(reason);
    console.error(`[lupin] Swallowed unhandled rejection: ${msg}`);
  });

  const browserManager = new BrowserManager();
  const scraper = new Lupin({
    browserManager,
    config: browserManager.config,
    stateDir: browserManager.stateDir,
  });
  const browserSessions = new BrowserSessionStore(browserManager);
  const browserTools = getBrowserTools();
  const searchTools = await getSearchTools({ stateDir: browserManager.stateDir });
  const fetchTools = await getFetchTools({ stateDir: browserManager.stateDir });
  const videoTools = getVideoTools();
  const crawlTools = getCrawlTools();

  const server = new Server(
    { name: "lupin", version },
    { capabilities: { tools: {}, logging: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...browserTools, ...searchTools, ...fetchTools, ...videoTools, ...crawlTools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      assertBrowserRequirements(
        browserManager,
        await getToolBrowserRequirements(name, args, { stateDir: browserManager.stateDir }),
        `MCP tool ${name}`
      );
      let result;
      if (browserTools.some((tool) => tool.name === name)) {
        result = await callBrowserTool(browserSessions, name, args);
      } else if (searchTools.some((tool) => tool.name === name)) {
        result = await callSearchTool(name, args, {
          browserManager,
          fetcher: scraper.fetch.bind(scraper),
          stateDir: browserManager.stateDir,
        });
      } else if (fetchTools.some((tool) => tool.name === name)) {
        result = await callFetchTool(name, args, { scraper, browserManager, stateDir: browserManager.stateDir });
      } else if (crawlTools.some((tool) => tool.name === name)) {
        result = await callCrawlTool(name, args, { scraper, stateDir: browserManager.stateDir });
      } else if (videoTools.some((tool) => tool.name === name)) {
        const ytdlpStatus = getYtDlpStatus({ stateDir: browserManager.stateDir });
        if (!ytdlpStatus.ok) {
          return {
            content: [{ type: "text", text: "Video support is not installed. Run: lupin setup --with-video" }],
            isError: true,
          };
        }
        result = await callVideoTool(name, args, {
          stateDir: browserManager.stateDir,
          onProgress: (line) => {
            server.sendLoggingMessage({ level: "info", data: line }).catch(() => {});
          },
        });
      } else {
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
      if (result?.screenshotBuffer) {
        content.push({
          type: "image",
          data: result.screenshotBuffer.toString("base64"),
          mimeType: result.screenshotMimeType || "image/png",
        });
      }
      return { content };
    } catch (error) {
      const payload = {
        error: error?.message || String(error),
        failure: error?.failure || null,
        attempts: error?.attempts || [],
        updateHint: error?.updateHint || null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
      };
    }
  });

  async function cleanup() {
    await browserSessions.closeAll();
    await scraper.close();
    await server.close();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const doctorReport = createDoctorReportFromManager(browserManager);
  if (!doctorReport.ok) {
    console.error(formatDoctorReport(doctorReport));
    console.error("HTTP/API-backed tools still work, but browser-backed tools may require `lupin setup`.");
  }
  console.error("lupin MCP server running on stdio");
}
