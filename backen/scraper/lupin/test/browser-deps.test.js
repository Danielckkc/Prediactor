import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBrowserRequirements,
  formatDoctorReport,
  formatPreflightMessage,
} from "../src/runtime/browser-deps.js";

test("evaluateBrowserRequirements requires requested assets only", () => {
  const report = {
    camoufox: { ok: false, message: "Camoufox missing." },
    fallback: { ok: true, verified: true, message: "Fallback ready." },
  };

  assert.deepEqual(
    evaluateBrowserRequirements(report, { camoufox: true, fallback: false }),
    { ok: false, missing: ["camoufox"], warnings: [] }
  );
});

test("evaluateBrowserRequirements flags provisional fallback as warning", () => {
  const report = {
    camoufox: { ok: true, message: "Camoufox ready." },
    fallback: { ok: true, verified: false, message: "Fallback will use channel chrome." },
  };

  assert.deepEqual(
    evaluateBrowserRequirements(report, { fallback: true }),
    {
      ok: true,
      missing: [],
      warnings: ["Fallback browser has only a provisional channel-based configuration."],
    }
  );
});

test("formatDoctorReport marks provisional fallback as partial", () => {
  const text = formatDoctorReport({
    ok: false,
    snapshotDate: "2026-03-28",
    stateDir: "/tmp/absolute",
    http: { ok: true, message: "HTTP is ready." },
    camoufox: { ok: true, message: "Camoufox ready.", installDir: "/tmp/camoufox" },
    fallback: {
      ok: true,
      verified: false,
      message: "Fallback will use channel chrome.",
    },
    warnings: ["Fallback is provisional."],
  });

  assert.match(text, /Fallback: PARTIAL/);
  assert.match(text, /Suggested fix: lupin setup/);
});

test("formatPreflightMessage includes only requested missing assets", () => {
  const text = formatPreflightMessage(
    {
      camoufox: { ok: false, message: "Camoufox missing." },
      fallback: { ok: true, verified: true, message: "Fallback ready." },
    },
    "search web",
    { camoufox: true }
  );

  assert.match(text, /search web requires browser assets/);
  assert.match(text, /Camoufox missing/);
  assert.doesNotMatch(text, /Fallback ready/);
});
