import assert from "node:assert/strict";
import test from "node:test";

import { Lupin } from "../src/scraper.js";

test("rejects an unsupported fallback provider", async () => {
  const scraper = new Lupin({ fallbackProvider: "nope" });
  await assert.rejects(
    () => scraper.getFallbackOwner(),
    /Unsupported fallback provider/
  );
  await scraper.close();
});

test("requires a CDP URL when the CDP fallback provider is selected", async () => {
  const scraper = new Lupin({ fallbackProvider: "cdp" });
  await assert.rejects(
    () => scraper.getFallbackOwner(),
    /CDP fallback provider requires LUPIN_CDP_URL/
  );
  await scraper.close();
});

test("fallback scrape returns shaped attempts when startup fails", async () => {
  const scraper = new Lupin({ fallbackProvider: "cdp", fallbackRetries: 1 });

  try {
    await assert.rejects(
      () => scraper.scrape("https://example.com", { engine: "fallback" }),
      (error) => {
        assert.equal(error.name, "ScrapeFailedError");
        assert.match(error.message, /CDP fallback provider requires LUPIN_CDP_URL/);
        assert.equal(error.attempts.length, 1);
        assert.match(error.attempts[0].reason, /CDP fallback provider requires LUPIN_CDP_URL/);
        assert.deepEqual(error.failure?.failedBy, {
          engine: "fallback",
          attempt: 1,
          reason: error.attempts[0].reason,
        });
        return true;
      }
    );
  } finally {
    await scraper.close();
  }
});

test("clears a rejected fallback owner promise after connection failures", async () => {
  const scraper = new Lupin({
    fallbackProvider: "cdp",
    cdpUrl: "http://127.0.0.1:9",
  });

  try {
    await assert.rejects(
      () => scraper.getFallbackOwner(),
      /ECONNREFUSED|connectOverCDP|fetch failed/i
    );
    assert.equal(scraper.fallbackOwnerPromise, null);

    scraper.config.cdpUrl = undefined;
    await assert.rejects(
      () => scraper.getFallbackOwner(),
      /CDP fallback provider requires LUPIN_CDP_URL/
    );
    assert.equal(scraper.fallbackOwnerPromise, null);
  } finally {
    await scraper.close();
  }
});
