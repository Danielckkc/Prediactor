import assert from "node:assert/strict";
import test from "node:test";

import { checkCoreUpdate, checkPackageUpdate, compareSemver, formatCoreUpdateReport } from "../../src/runtime/update-check.js";

test("compareSemver compares stable versions", () => {
  assert.equal(compareSemver("1.2.3", "1.2.4"), -1);
  assert.equal(compareSemver("1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("1.3.0", "1.2.9"), 1);
});

test("checkCoreUpdate reports update availability from registry metadata", async () => {
  const result = await checkCoreUpdate({
    currentVersion: "0.2.0",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: "0.3.0" }),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.latestVersion, "0.3.0");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.updateCommand, "npm install -g lupin-cli@latest");
});

test("checkPackageUpdate supports custom update commands", async () => {
  const result = await checkPackageUpdate({
    packageName: "@scope/lupin-platform-demo",
    currentVersion: "1.0.0",
    updateCommand: "lupin platform update demo",
    fetchImpl: async (url) => {
      assert.match(url, /@scope\/lupin-platform-demo\/latest$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "1.0.1" }),
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.latestVersion, "1.0.1");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.updateCommand, "lupin platform update demo");
});

test("checkCoreUpdate reports degraded registry failures", async () => {
  const result = await checkCoreUpdate({
    currentVersion: "0.2.0",
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.degraded, true);
  assert.match(result.error, /HTTP 503/);
  assert.equal(result.updateAvailable, false);
});

test("formatCoreUpdateReport labels success and degraded output", async () => {
  assert.match(
    formatCoreUpdateReport({
      ok: true,
      version: "0.2.0",
      latestVersion: "0.3.0",
      updateAvailable: true,
      updateCommand: "npm install -g lupin-cli@latest",
    }),
    /Update available/
  );

  assert.match(
    formatCoreUpdateReport({
      ok: false,
      degraded: true,
      version: "0.2.0",
      error: "network unavailable",
    }),
    /DEGRADED - network unavailable/
  );
});
