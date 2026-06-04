const DEFAULT_DISMISS_SELECTORS = [
  '[aria-label="Fermer"]',
  '[aria-label="Close"]',
  'button[data-testid="translation-modal-close"]',
  "#onetrust-accept-btn-handler",
  'button[aria-label*="cookie" i]',
  'button[id*="cookie" i]',
  '[id*="cookie" i] button',
  '[class*="cookie" i] button',
  '[data-testid*="consent" i] button',
];

export const BLOCK_TAGS = [
  "address", "article", "aside", "blockquote", "dd", "details",
  "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
];

function buildWaitForError(selector, error) {
  return new Error(`Required selector did not appear: ${selector}`, { cause: error });
}

export function trimText(text = "") {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function hardenPage(page, { timeout, engine } = {}) {
  page.setDefaultTimeout(Math.min(timeout, 20000));

  // Keep shared hardening conservative. Browser engines already manage their
  // own fingerprint surfaces; synthetic navigator/window shims are more
  // detectable than helpful.
  if (engine === "fallback") {
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    }).catch(() => {});
  }
}

export async function waitForContent(page, { waitFor, settleDelayMs = 1500 }) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  if (waitFor) {
    try {
      await page.waitForSelector(waitFor, { timeout: 15000 });
    } catch (error) {
      throw buildWaitForError(waitFor, error);
    }
  }

  await page.waitForTimeout(settleDelayMs);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(settleDelayMs);
}

export async function dismissPopups(page, selectors = DEFAULT_DISMISS_SELECTORS) {
  for (const selector of selectors) {
    const element = await page.$(selector);
    if (!element) continue;
    await element.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}

export async function scrollPage(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

export async function extractVisibleText(page) {
  const text = await page.evaluate((blockTags) => {
    const BLOCKS = new Set(blockTags.map((t) => t.toUpperCase()));
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

    function walk(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return "";

      const tag = node.tagName;
      if (SKIP.has(tag)) return "";
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return "";
      if (tag !== "BODY" && tag !== "HTML" && !node.offsetHeight && !node.offsetWidth) return "";

      if (tag === "BR") return "\n";

      const isBlock = BLOCKS.has(tag);
      let result = "";
      if (isBlock) result += "\n";
      for (const child of node.childNodes) result += walk(child);
      if (isBlock) result += "\n";
      return result;
    }

    const candidates = [
      document.querySelector("main"),
      document.querySelector("article"),
      document.querySelector('[role="main"]'),
      document.body,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const content = walk(candidate).trim();
      if (content && content.length > 120) return content;
    }

    return document.body?.innerText || document.body?.textContent || "";
  }, BLOCK_TAGS);

  return trimText(text);
}

export { DEFAULT_DISMISS_SELECTORS };
