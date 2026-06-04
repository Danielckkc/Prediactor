import {
  clickInSession,
  extractSession,
  navigateSession,
  pressInSession,
  screenshotSession,
  snapshotSession,
  typeInSession,
  waitForInSession,
} from "../../runtime/actions.js";

export function getBrowserTools() {
  return [
    {
      name: "browser_open_session",
      description:
        "Open a browser session for multi-step interaction. " +
        "Returns a sessionId for use with other browser_* tools. " +
        "Call browser_close_session when done.",
      inputSchema: {
        type: "object",
        properties: {
          engine: {
            type: "string",
            enum: ["fallback", "patchright", "camoufox"],
            default: "fallback",
            description: "Browser engine to use. 'patchright' is an alias for 'fallback'.",
          },
          timeout: {
            type: "number",
            description: "Default timeout in milliseconds for actions in this session.",
          },
        },
      },
    },
    {
      name: "browser_close_session",
      description: "Close a previously opened browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The browser session identifier." },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "browser_navigate",
      description: "Navigate an existing browser session to a URL.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          url: { type: "string" },
          waitFor: { type: "string", description: "Optional CSS selector to wait for after navigation." },
          timeout: { type: "number" },
        },
        required: ["sessionId", "url"],
      },
    },
    {
      name: "browser_click",
      description: "Click an element in an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          selector: buildSelectorSchema(),
          timeout: { type: "number" },
        },
        required: ["sessionId", "selector"],
      },
    },
    {
      name: "browser_type",
      description: "Type text into an input in an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          selector: buildSelectorSchema(),
          text: { type: "string" },
          clear: { type: "boolean", default: true },
          timeout: { type: "number" },
        },
        required: ["sessionId", "selector", "text"],
      },
    },
    {
      name: "browser_press",
      description: "Press a keyboard key in an active browser session, optionally scoped to a selector.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          key: { type: "string" },
          selector: buildSelectorSchema(false),
          timeout: { type: "number" },
        },
        required: ["sessionId", "key"],
      },
    },
    {
      name: "browser_wait_for",
      description: "Wait for an element to appear in an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          selector: buildSelectorSchema(),
          timeout: { type: "number" },
        },
        required: ["sessionId", "selector"],
      },
    },
    {
      name: "browser_snapshot",
      description: "Return a compact snapshot of the current page state for an active browser session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "browser_extract",
      description: "Extract the current page from an active browser session as JSON, Markdown, or HTML.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          format: {
            type: "string",
            enum: ["json", "markdown", "html"],
            default: "json",
          },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the current page in an active browser session. " +
        "Returns the image as a base64-encoded PNG or JPEG.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "The browser session identifier." },
          fullPage: { type: "boolean", default: false, description: "Capture full scrollable page height." },
          format: { type: "string", enum: ["png", "jpeg"], default: "png", description: "Image format." },
          quality: { type: "number", description: "JPEG quality 0-100 (default 80). Ignored for PNG." },
          clip: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              width: { type: "number" },
              height: { type: "number" },
            },
            required: ["x", "y", "width", "height"],
            description: "Capture a specific region instead of the full viewport.",
          },
        },
        required: ["sessionId"],
      },
    },
  ];
}

function buildSelectorSchema(required = true) {
  return {
    type: "object",
    properties: {
      css: { type: "string" },
      text: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      testId: { type: "string" },
      exact: { type: "boolean" },
    },
    additionalProperties: false,
    ...(required ? { minProperties: 1 } : {}),
  };
}

export async function callBrowserTool(store, name, args = {}) {
  switch (name) {
    case "browser_open_session":
      return store.createSession(args);
    case "browser_close_session": {
      const closed = await store.closeSession(args.sessionId);
      return { ok: closed, sessionId: args.sessionId };
    }
    case "browser_navigate": {
      const session = await store.getSession(args.sessionId);
      return navigateSession(session, args.url, args);
    }
    case "browser_click": {
      const session = await store.getSession(args.sessionId);
      return clickInSession(session, args.selector, args);
    }
    case "browser_type": {
      const session = await store.getSession(args.sessionId);
      return typeInSession(session, args.selector, args.text, args);
    }
    case "browser_press": {
      const session = await store.getSession(args.sessionId);
      return pressInSession(session, args.key, args);
    }
    case "browser_wait_for": {
      const session = await store.getSession(args.sessionId);
      return waitForInSession(session, args.selector, args);
    }
    case "browser_snapshot": {
      const session = await store.getSession(args.sessionId);
      return snapshotSession(session);
    }
    case "browser_extract": {
      const session = await store.getSession(args.sessionId);
      return extractSession(session, args.format || "json");
    }
    case "browser_screenshot": {
      const session = await store.getSession(args.sessionId);
      return screenshotSession(session, {
        screenshotFullPage: args.fullPage,
        screenshotFormat: args.format,
        screenshotQuality: args.quality,
        screenshotClip: args.clip,
      });
    }
    default:
      throw new Error(`Unknown browser tool: ${name}`);
  }
}
