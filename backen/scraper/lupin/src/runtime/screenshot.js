/**
 * Screenshot utility for live Playwright/Camoufox pages.
 *
 * Returns a Buffer + metadata when options.screenshot is truthy,
 * or null when screenshots are not requested or the page is unavailable.
 */

const VALID_FORMATS = new Set(["png", "jpeg"]);
const DEFAULT_FORMAT = "png";
const DEFAULT_JPEG_QUALITY = 80;
const SCREENSHOT_CAPTURE_STYLE = `
  html {
    scrollbar-width: none !important;
  }

  ::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
`;

// Full HD desktop viewport — ensures sites render their complete desktop layout.
export const SCREENSHOT_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

async function waitForStableScreenshot(page) {
  try {
    await page.evaluate(async () => {
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      await nextFrame();
      await document.fonts?.ready?.catch?.(() => {});
      await nextFrame();
    });
  } catch {
    // best-effort
  }
}

/**
 * Prepare a page for a deterministic screenshot before navigation.
 *
 * Playwright documents that `page.setViewportSize()` should be done before
 * navigating because resizing a live page can produce unexpected layout
 * changes. We only force the desktop screenshot viewport for flows that know
 * ahead of time that a screenshot will be captured.
 *
 * @param {import('playwright').Page | null | undefined} page
 * @param {object} options
 * @param {boolean} [options.screenshot]
 * @returns {Promise<void>}
 */
export async function preparePageForScreenshot(page, options = {}) {
  if (!options.screenshot || !page) {
    return;
  }

  const currentViewport = page.viewportSize();
  if (
    currentViewport
    && currentViewport.width === SCREENSHOT_VIEWPORT.width
    && currentViewport.height === SCREENSHOT_VIEWPORT.height
  ) {
    return;
  }

  await page.setViewportSize(SCREENSHOT_VIEWPORT);
}

/**
 * @param {import('playwright').Page | null | undefined} page
 * @param {object} options
 * @param {boolean}  [options.screenshot]          - Whether to take a screenshot
 * @param {boolean}  [options.screenshotFullPage]   - Capture full scrollable height
 * @param {string}   [options.screenshotFormat]     - "png" (default) or "jpeg"
 * @param {number}   [options.screenshotQuality]    - JPEG quality 0-100 (default 80, ignored for PNG)
 * @param {{ x: number, y: number, width: number, height: number }} [options.screenshotClip] - Region clip
 * @returns {Promise<{ buffer: Buffer, mimeType: string, format: string } | null>}
 */
export async function takeScreenshot(page, options = {}) {
  if (!options.screenshot || !page) {
    return null;
  }

  const format = VALID_FORMATS.has(options.screenshotFormat) ? options.screenshotFormat : DEFAULT_FORMAT;
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";

  const screenshotOptions = {
    type: format,
    fullPage: Boolean(options.screenshotFullPage),
    scale: "css",
    animations: "disabled",
    style: SCREENSHOT_CAPTURE_STYLE,
  };

  if (format === "jpeg") {
    screenshotOptions.quality = Number.isFinite(options.screenshotQuality)
      ? Math.max(0, Math.min(100, options.screenshotQuality))
      : DEFAULT_JPEG_QUALITY;
  }

  if (options.screenshotClip && typeof options.screenshotClip === "object") {
    const { x, y, width, height } = options.screenshotClip;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) {
      screenshotOptions.clip = { x, y, width, height };
      screenshotOptions.fullPage = false;
    }
  }

  try {
    await waitForStableScreenshot(page);

    const buffer = await page.screenshot(screenshotOptions);

    return { buffer, mimeType, format };
  } catch {
    // Screenshot is secondary to content extraction — don't fail the scrape.
    return null;
  }
}

/**
 * Attach a screenshot buffer as a non-enumerable property on an object.
 * Mirrors the rawHtml pattern in scraper.js — invisible to JSON.stringify,
 * accessible by explicit property access.
 *
 * @param {object} target - Object to attach screenshot properties to
 * @param {{ buffer: Buffer, mimeType: string, format: string } | null} screenshotResult - Result from takeScreenshot
 */
export function attachScreenshot(target, screenshotResult) {
  if (!screenshotResult) return;
  Object.defineProperty(target, "screenshotBuffer", {
    value: screenshotResult.buffer,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(target, "screenshotMimeType", {
    value: screenshotResult.mimeType,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(target, "screenshotFormat", {
    value: screenshotResult.format,
    enumerable: false,
    configurable: true,
  });
}
