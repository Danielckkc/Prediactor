import assert from "node:assert/strict";
import test from "node:test";

import { hardenPage, waitForContent } from "../src/extractors.js";

test("waitForContent fails when a required selector never appears", async () => {
  const calls = [];
  const page = {
    waitForLoadState: async (state) => {
      calls.push(["waitForLoadState", state]);
    },
    waitForSelector: async (selector) => {
      calls.push(["waitForSelector", selector]);
      throw new Error("selector timeout");
    },
  };

  await assert.rejects(() => waitForContent(page, { waitFor: "#missing" }), /Required selector did not appear: #missing/);
  assert.deepEqual(calls, [
    ["waitForLoadState", "domcontentloaded"],
    ["waitForSelector", "#missing"],
  ]);
});

test("hardenPage avoids synthetic navigator shims for camoufox", async () => {
  const calls = [];
  const page = {
    setDefaultTimeout: (value) => calls.push(["setDefaultTimeout", value]),
    setExtraHTTPHeaders: async (headers) => calls.push(["setExtraHTTPHeaders", headers]),
    addInitScript: async () => calls.push(["addInitScript"]),
  };

  await hardenPage(page, { timeout: 30000, engine: "camoufox" });

  assert.deepEqual(calls, [["setDefaultTimeout", 20000]]);
});

test("hardenPage keeps fallback headers minimal", async () => {
  const calls = [];
  const page = {
    setDefaultTimeout: (value) => calls.push(["setDefaultTimeout", value]),
    setExtraHTTPHeaders: async (headers) => calls.push(["setExtraHTTPHeaders", headers]),
    addInitScript: async () => calls.push(["addInitScript"]),
  };

  await hardenPage(page, { timeout: 5000, engine: "fallback" });

  assert.deepEqual(calls, [
    ["setDefaultTimeout", 5000],
    ["setExtraHTTPHeaders", { "Accept-Language": "en-US,en;q=0.9" }],
  ]);
});
