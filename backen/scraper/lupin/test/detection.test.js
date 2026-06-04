import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeAttempt } from "../src/detection.js";
import { summarizeFailureAttempts } from "../src/scraper.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(TEST_DIR, "fixtures");

async function loadFixture(name) {
  const raw = await fs.readFile(path.join(FIXTURES_DIR, name), "utf8");
  return JSON.parse(raw);
}

async function expectChallengeFixture(name, provider) {
  const fixture = await loadFixture(name);
  const result = analyzeAttempt(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.mitigation?.provider, provider);
  assert.equal(result.mitigation?.kind, "challenge");
  assert.match(result.reason, new RegExp(`${provider} challenge`, "i"));
}

async function expectSuccessFixture(name) {
  const fixture = await loadFixture(name);
  const result = analyzeAttempt(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.mitigation, null);
  assert.equal(result.reason, null);
}

test("detects Cloudflare challenge pages from exact provider signals", async () => {
  await expectChallengeFixture("cloudflare-challenge.json", "cloudflare");
  await expectChallengeFixture("rakuten-cloudflare-challenge.json", "cloudflare");
  await expectChallengeFixture("nexusmods-cloudflare-challenge.json", "cloudflare");
});

test("does not reject successful Cloudflare-backed pages", async () => {
  await expectSuccessFixture("cloudflare-success.json");
  await expectSuccessFixture("rakuten-cloudflare-success.json");
  await expectSuccessFixture("nexusmods-cloudflare-success.json");
});

test("detects DataDome challenge pages from exact provider signals", async () => {
  await expectChallengeFixture("datadome-challenge.json", "datadome");
  await expectChallengeFixture("g2-datadome-challenge.json", "datadome");
  await expectChallengeFixture("view-datadome-challenge.json", "datadome");
});

test("detects PerimeterX challenge pages from exact provider signals", async () => {
  await expectChallengeFixture("perimeterx-challenge.json", "perimeterx");
});

test("does not reject a successful page just because DataDome artifacts exist", async () => {
  await expectSuccessFixture("datadome-success.json");
});

test("ignores DataDome cookies that belong to a different domain", () => {
  const result = analyzeAttempt({
    url: "https://target.example/article",
    status: 403,
    title: "Blocked",
    text: "Short blocked page",
    headers: {
      "x-datadome": "protected",
    },
    cookies: [
      { name: "datadome", domain: ".other-site.example" },
    ],
  });

  assert.equal(result.mitigation, null);
  assert.equal(result.reason, "status 403");
});

test("does not reject a normal page titled 'Just a moment...'", async () => {
  const fixture = await loadFixture("just-a-moment-legit.json");
  const result = analyzeAttempt(fixture);

  assert.equal(result.ok, true);
  assert.equal(result.mitigation, null);
});

test("classifies browser network error pages as failures", async () => {
  const fixture = await loadFixture("browser-error.json");
  const result = analyzeAttempt(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.mitigation?.provider, "browser");
  assert.equal(result.mitigation?.kind, "network_error");
});

test("keeps a low-confidence generic fallback for unknown blocked pages", async () => {
  const fixture = await loadFixture("generic-blocked.json");
  const result = analyzeAttempt(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.mitigation?.provider, "generic");
  assert.equal(result.mitigation?.confidence, "low");
});

test("skips JS shell detection when browserRendered is true", () => {
  // SPA page: huge HTML, tiny visible text — would fail without browserRendered
  const result = analyzeAttempt({
    url: "https://www.tiktok.com/@user/video/123",
    status: 200,
    title: "TikTok Video",
    text: "A".repeat(200),
    rawHtml: "X".repeat(100000),
    headers: {},
    browserRendered: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test("detects JS shell when browserRendered is false (HTTP engine)", () => {
  const result = analyzeAttempt({
    url: "https://www.tiktok.com/@user/video/123",
    status: 200,
    title: "TikTok",
    text: "A".repeat(130),
    rawHtml: "X".repeat(100000),
    headers: {},
    browserRendered: false,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /JS shell detected/);
});

test("summarizeFailureAttempts prefers browser failure over HTTP JS shell", () => {
  const attempts = [
    {
      blocked: true,
      engine: "http",
      attempt: 1,
      reason: "JS shell detected: 134 chars visible text in 456955 byte HTML",
      mitigation: null,
    },
    {
      blocked: true,
      engine: "camoufox",
      attempt: 1,
      reason: "status 403",
      mitigation: null,
    },
    {
      blocked: true,
      engine: "fallback",
      attempt: 1,
      reason: "insufficient visible text",
      mitigation: null,
    },
  ];

  const summary = summarizeFailureAttempts(attempts);
  assert.equal(summary.reason, "insufficient visible text");
  assert.ok(!summary.reason.includes("JS shell"));
});

test("summarizeFailureAttempts still surfaces JS shell when no browser attempts exist", () => {
  const attempts = [
    {
      blocked: true,
      engine: "http",
      attempt: 1,
      reason: "JS shell detected: 100 chars visible text in 80000 byte HTML",
      mitigation: null,
    },
  ];

  const summary = summarizeFailureAttempts(attempts);
  assert.match(summary.reason, /JS shell detected/);
});

test("summarizeFailureAttempts still prefers high-confidence mitigation over browser reason", () => {
  const attempts = [
    {
      blocked: true,
      engine: "http",
      attempt: 1,
      reason: "JS shell detected: 134 chars visible text in 456955 byte HTML",
      mitigation: null,
    },
    {
      blocked: true,
      engine: "camoufox",
      attempt: 1,
      reason: "cloudflare challenge: header cf-mitigated=challenge",
      mitigation: { provider: "cloudflare", kind: "challenge", confidence: "high", signals: ["header cf-mitigated=challenge"] },
    },
  ];

  const summary = summarizeFailureAttempts(attempts);
  assert.match(summary.reason, /cloudflare challenge/);
  assert.equal(summary.blockedBy?.provider, "cloudflare");
});
