import assert from "node:assert/strict";
import test from "node:test";

import { SCREENSHOT_VIEWPORT, preparePageForScreenshot, takeScreenshot } from "../src/runtime/screenshot.js";

test("preparePageForScreenshot applies the desktop viewport before navigation", async () => {
  const calls = [];
  const page = {
    viewportSize: () => null,
    setViewportSize: async (viewport) => {
      calls.push(viewport);
    },
  };

  await preparePageForScreenshot(page, { screenshot: true });

  assert.deepEqual(calls, [SCREENSHOT_VIEWPORT]);
});

test("preparePageForScreenshot skips resizing when screenshots are disabled or already sized", async () => {
  const calls = [];
  const page = {
    viewportSize: () => ({ ...SCREENSHOT_VIEWPORT }),
    setViewportSize: async (viewport) => {
      calls.push(viewport);
    },
  };

  await preparePageForScreenshot(page, { screenshot: false });
  await preparePageForScreenshot(page, { screenshot: true });

  assert.deepEqual(calls, []);
});

test("takeScreenshot captures the current viewport without mutating it again", async () => {
  const setViewportCalls = [];
  const screenshotCalls = [];
  const page = {
    setViewportSize: async (viewport) => {
      setViewportCalls.push(viewport);
    },
    evaluate: async () => {},
    screenshot: async (options) => {
      screenshotCalls.push(options);
      return Buffer.from("png-bytes");
    },
  };

  const result = await takeScreenshot(page, {
    screenshot: true,
    screenshotFullPage: true,
  });

  assert.equal(setViewportCalls.length, 0);
  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0].type, "png");
  assert.equal(screenshotCalls[0].fullPage, true);
  assert.equal(screenshotCalls[0].scale, "css");
  assert.equal(screenshotCalls[0].animations, "disabled");
  assert.match(screenshotCalls[0].style, /scrollbar-width: none/);
  assert.deepEqual(result, {
    buffer: Buffer.from("png-bytes"),
    mimeType: "image/png",
    format: "png",
  });
});

test("takeScreenshot preserves clip captures and clamps jpeg quality", async () => {
  const screenshotCalls = [];
  const page = {
    evaluate: async () => {},
    screenshot: async (options) => {
      screenshotCalls.push(options);
      return Buffer.from("jpeg-bytes");
    },
  };

  const result = await takeScreenshot(page, {
    screenshot: true,
    screenshotFullPage: true,
    screenshotFormat: "jpeg",
    screenshotQuality: 500,
    screenshotClip: { x: 10, y: 20, width: 300, height: 200 },
  });

  assert.equal(screenshotCalls.length, 1);
  assert.equal(screenshotCalls[0].type, "jpeg");
  assert.equal(screenshotCalls[0].quality, 100);
  assert.equal(screenshotCalls[0].fullPage, false);
  assert.deepEqual(screenshotCalls[0].clip, { x: 10, y: 20, width: 300, height: 200 });
  assert.deepEqual(result, {
    buffer: Buffer.from("jpeg-bytes"),
    mimeType: "image/jpeg",
    format: "jpeg",
  });
});
