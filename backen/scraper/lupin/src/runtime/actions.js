import { dismissPopups, hardenPage, waitForContent } from "../extractors.js";
import { extractPageHtml, extractPageJson, extractPageMarkdown } from "./extract.js";
import { resolveLocator } from "./selectors.js";
import { takeScreenshot } from "./screenshot.js";

async function getInteractiveElements(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll("a, button, input, textarea, select, [role='button']"))
        .slice(0, 40)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute("type") || null,
          text: (element.textContent || element.getAttribute("aria-label") || element.getAttribute("name") || "")
            .trim()
            .slice(0, 120),
          id: element.id || null,
          href: element instanceof HTMLAnchorElement ? element.href : null,
          name: element.getAttribute("name") || null,
        }))
    )
    .catch(() => []);
}

export async function navigateSession(session, url, options = {}) {
  const timeout = options.timeout || session.defaultTimeoutMs;
  await hardenPage(session.page, { timeout, engine: session.engine });
  const response = await session.page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout,
  });
  await waitForContent(session.page, { waitFor: options.waitFor, settleDelayMs: options.settleDelayMs });
  await dismissPopups(session.page);

  return {
    ok: true,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
    status: response?.status() ?? 0,
  };
}

export async function clickInSession(session, selector, options = {}) {
  const locator = resolveLocator(session.page, selector);
  await locator.first().click({ timeout: options.timeout || session.defaultTimeoutMs });
  return {
    ok: true,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
  };
}

export async function typeInSession(session, selector, text, options = {}) {
  const locator = resolveLocator(session.page, selector);
  const target = locator.first();
  await target.waitFor({ timeout: options.timeout || session.defaultTimeoutMs });
  if (options.clear !== false) {
    await target.fill("", { timeout: options.timeout || session.defaultTimeoutMs });
  }
  await target.fill(String(text), { timeout: options.timeout || session.defaultTimeoutMs });
  return {
    ok: true,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
  };
}

export async function pressInSession(session, key, options = {}) {
  if (options.selector) {
    const locator = resolveLocator(session.page, options.selector);
    await locator.first().press(key, { timeout: options.timeout || session.defaultTimeoutMs });
  } else {
    await session.page.keyboard.press(key);
  }

  return {
    ok: true,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
  };
}

export async function waitForInSession(session, selector, options = {}) {
  const locator = resolveLocator(session.page, selector);
  await locator.first().waitFor({ timeout: options.timeout || session.defaultTimeoutMs });
  return {
    ok: true,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
  };
}

export async function snapshotSession(session) {
  const [title, textPreview, elements] = await Promise.all([
    session.page.title().catch(() => ""),
    session.page
      .evaluate(() => (document.body?.innerText || document.body?.textContent || "").trim().slice(0, 4000))
      .catch(() => ""),
    getInteractiveElements(session.page),
  ]);

  return {
    ok: true,
    url: session.page.url(),
    title,
    textPreview,
    elements,
  };
}

export async function screenshotSession(session, options = {}) {
  const result = await takeScreenshot(session.page, { screenshot: true, ...options });
  if (!result) {
    throw new Error("Screenshot capture failed");
  }
  const response = {
    ok: true,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
  };
  // Attach buffer as non-enumerable — prevents JSON.stringify from serializing
  // the raw bytes into the MCP text content block.
  Object.defineProperty(response, "screenshotBuffer", {
    value: result.buffer, enumerable: false, configurable: true,
  });
  Object.defineProperty(response, "screenshotMimeType", {
    value: result.mimeType, enumerable: false, configurable: true,
  });
  return response;
}

export async function extractSession(session, format = "json") {
  switch (format) {
    case "json":
      return {
        ok: true,
        format,
        content: await extractPageJson(session.page),
      };
    case "markdown":
      return {
        ok: true,
        format,
        content: await extractPageMarkdown(session.page),
      };
    case "html":
      return {
        ok: true,
        format,
        content: await extractPageHtml(session.page),
      };
    default:
      throw new Error(`Unsupported extract format: ${format}`);
  }
}
