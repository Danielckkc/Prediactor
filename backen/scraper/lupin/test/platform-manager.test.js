import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkPlatformUpdates, installPlatform, listPlatforms, removePlatform, updatePlatform } from "../src/platforms/manager.js";
import { loadPlatformRegistry } from "../src/platforms/registry.js";

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createFakeNpm(binDir, logPath) {
  const npmPath = path.join(binDir, "npm");
  const source = `#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const [, , command, ...args] = process.argv;
  const logPath = process.env.FAKE_NPM_LOG_PATH;
  if (logPath) {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, JSON.stringify({ command, args }) + "\\n");
  }

  const packageName = args[args.length - 1];
  const packageRoot = path.join(process.cwd(), "node_modules", ...String(packageName || "").split("/"));

  if (command === "install") {
    if (!args.includes("--ignore-scripts")) {
      throw new Error("missing --ignore-scripts");
    }

    const version = process.env.FAKE_NPM_PLATFORM_VERSION || "1.0.0";
    const broken = process.env.FAKE_NPM_PLATFORM_BROKEN === "1";
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, version, type: "module" }, null, 2) + "\\n"
    );
    await fs.writeFile(
      path.join(packageRoot, "lupin.platform.json"),
      JSON.stringify({
        apiVersion: 1,
        name: "npm-demo",
        displayName: "NPM Demo",
        description: "Fixture npm platform used by tests.",
        version,
        entry: "./index.js",
        tools: {
          search: [
            {
              tool: "search_npmdemo",
              alias: "npmdemo",
              description: "Search the npm demo platform.",
              inputSchema: "search.standard",
              handler: broken ? "missingSearch" : "search"
            }
          ],
          fetch: []
        }
      }, null, 2) + "\\n"
    );
    await fs.writeFile(
      path.join(packageRoot, "index.js"),
      "import { createSearchResponse, snapshotDateUtc } from \\"lupin-cli/platform-sdk\\";\\n" +
        "\\n" +
        "export async function search(args) {\\n" +
        "  return createSearchResponse(\\n" +
        "    \\"npm-demo\\",\\n" +
        "    args.query,\\n" +
        "    \\"fixture\\",\\n" +
        "    snapshotDateUtc(),\\n" +
        "    [],\\n" +
        "    []\\n" +
        "  );\\n" +
        "}\\n"
    );
    return;
  }

  if (command === "uninstall") {
    if (!args.includes("--ignore-scripts")) {
      throw new Error("missing --ignore-scripts");
    }
    await fs.rm(packageRoot, { recursive: true, force: true });
    return;
  }

  throw new Error("unexpected fake npm command: " + command);
}

main().catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`;

  await fs.writeFile(npmPath, source);
  await fs.chmod(npmPath, 0o755);
  return { npmPath, logPath };
}

test("npm-backed platform install ignores lifecycle scripts during install and uninstall", async () => {
  const stateDir = await makeTempDir("lupin-platform-manager-state-");
  const fakeBinDir = await makeTempDir("lupin-platform-manager-bin-");
  const logPath = path.join(fakeBinDir, "fake-npm.log");
  const originalPath = process.env.PATH;
  const originalLogPath = process.env.FAKE_NPM_LOG_PATH;

  try {
    await createFakeNpm(fakeBinDir, logPath);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ""}`;
    process.env.FAKE_NPM_LOG_PATH = logPath;

    const installed = await installPlatform(stateDir, "dummy-platform");
    assert.equal(installed.kind, "npm");
    assert.equal(installed.manifestName, "npm-demo");

    const registry = await loadPlatformRegistry({ stateDir });
    assert.equal(registry.resolveSearchAlias("npmdemo")?.tool, "search_npmdemo");
    const platform = registry.listPlatforms().find((item) => item.name === "npm-demo");
    assert.ok(platform);
    assert.equal(platform.status, "enabled");
    assert.equal(platform.version, "1.0.0");
    assert.equal(platform.source.kind, "npm");
    assert.equal(platform.source.packageName, "dummy-platform");
    assert.equal(platform.source.specifier, "dummy-platform");

    const removed = await removePlatform(stateDir, "npm-demo");
    assert.equal(removed.removed, true);

    const logLines = (await fs.readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const installCall = logLines.find((entry) => entry.command === "install");
    const uninstallCall = logLines.find((entry) => entry.command === "uninstall");

    assert.ok(installCall, "expected fake npm install call");
    assert.ok(uninstallCall, "expected fake npm uninstall call");
    assert.ok(installCall.args.includes("--ignore-scripts"));
    assert.ok(uninstallCall.args.includes("--ignore-scripts"));
  } finally {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (originalLogPath == null) delete process.env.FAKE_NPM_LOG_PATH;
    else process.env.FAKE_NPM_LOG_PATH = originalLogPath;

    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  }
});

test("npm-backed platform update reinstalls package and reports new version", async () => {
  const stateDir = await makeTempDir("lupin-platform-manager-state-");
  const fakeBinDir = await makeTempDir("lupin-platform-manager-bin-");
  const logPath = path.join(fakeBinDir, "fake-npm.log");
  const originalPath = process.env.PATH;
  const originalLogPath = process.env.FAKE_NPM_LOG_PATH;
  const originalVersion = process.env.FAKE_NPM_PLATFORM_VERSION;

  try {
    await createFakeNpm(fakeBinDir, logPath);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ""}`;
    process.env.FAKE_NPM_LOG_PATH = logPath;

    process.env.FAKE_NPM_PLATFORM_VERSION = "1.0.0";
    await installPlatform(stateDir, "dummy-platform");

    process.env.FAKE_NPM_PLATFORM_VERSION = "1.1.0";
    const updated = await updatePlatform(stateDir, "npm-demo");

    assert.equal(updated.status, "updated");
    assert.equal(updated.oldVersion, "1.0.0");
    assert.equal(updated.newVersion, "1.1.0");

    const registry = await loadPlatformRegistry({ stateDir });
    const platform = registry.listPlatforms().find((item) => item.name === "npm-demo");
    assert.equal(platform.version, "1.1.0");
    assert.equal(registry.resolveSearchAlias("npmdemo")?.tool, "search_npmdemo");
  } finally {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (originalLogPath == null) delete process.env.FAKE_NPM_LOG_PATH;
    else process.env.FAKE_NPM_LOG_PATH = originalLogPath;

    if (originalVersion == null) delete process.env.FAKE_NPM_PLATFORM_VERSION;
    else process.env.FAKE_NPM_PLATFORM_VERSION = originalVersion;

    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  }
});

test("npm-backed platform update rolls back when updated package is invalid", async () => {
  const stateDir = await makeTempDir("lupin-platform-manager-state-");
  const fakeBinDir = await makeTempDir("lupin-platform-manager-bin-");
  const logPath = path.join(fakeBinDir, "fake-npm.log");
  const originalPath = process.env.PATH;
  const originalLogPath = process.env.FAKE_NPM_LOG_PATH;
  const originalVersion = process.env.FAKE_NPM_PLATFORM_VERSION;
  const originalBroken = process.env.FAKE_NPM_PLATFORM_BROKEN;

  try {
    await createFakeNpm(fakeBinDir, logPath);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ""}`;
    process.env.FAKE_NPM_LOG_PATH = logPath;

    process.env.FAKE_NPM_PLATFORM_VERSION = "1.0.0";
    delete process.env.FAKE_NPM_PLATFORM_BROKEN;
    await installPlatform(stateDir, "dummy-platform");

    process.env.FAKE_NPM_PLATFORM_VERSION = "2.0.0";
    process.env.FAKE_NPM_PLATFORM_BROKEN = "1";
    const updated = await updatePlatform(stateDir, "npm-demo");

    assert.equal(updated.status, "failed-rolled-back");
    assert.equal(updated.oldVersion, "1.0.0");
    assert.match(updated.error, /missing exported handler/);

    const registry = await loadPlatformRegistry({ stateDir });
    const platform = registry.listPlatforms().find((item) => item.name === "npm-demo");
    assert.equal(platform.version, "1.0.0");
    assert.equal(platform.broken, false);
    assert.equal(registry.resolveSearchAlias("npmdemo")?.tool, "search_npmdemo");
  } finally {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (originalLogPath == null) delete process.env.FAKE_NPM_LOG_PATH;
    else process.env.FAKE_NPM_LOG_PATH = originalLogPath;

    if (originalVersion == null) delete process.env.FAKE_NPM_PLATFORM_VERSION;
    else process.env.FAKE_NPM_PLATFORM_VERSION = originalVersion;

    if (originalBroken == null) delete process.env.FAKE_NPM_PLATFORM_BROKEN;
    else process.env.FAKE_NPM_PLATFORM_BROKEN = originalBroken;

    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  }
});

test("npm-backed platform update checks include latest version metadata", async () => {
  const stateDir = await makeTempDir("lupin-platform-manager-state-");
  const fakeBinDir = await makeTempDir("lupin-platform-manager-bin-");
  const logPath = path.join(fakeBinDir, "fake-npm.log");
  const originalPath = process.env.PATH;
  const originalLogPath = process.env.FAKE_NPM_LOG_PATH;
  const originalVersion = process.env.FAKE_NPM_PLATFORM_VERSION;
  const originalRegistry = process.env.LUPIN_NPM_REGISTRY_URL;
  const originalFetch = globalThis.fetch;

  try {
    await createFakeNpm(fakeBinDir, logPath);
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath || ""}`;
    process.env.FAKE_NPM_LOG_PATH = logPath;
    process.env.FAKE_NPM_PLATFORM_VERSION = "1.0.0";
    await installPlatform(stateDir, "dummy-platform");

    globalThis.fetch = async (url) => {
      assert.match(url, /dummy-platform\/latest$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "1.2.0" }),
      };
    };

    const checked = await checkPlatformUpdates(stateDir, ["npm-demo"]);
    assert.equal(checked.platforms.length, 1);
    assert.equal(checked.platforms[0].latestVersion, "1.2.0");
    assert.equal(checked.platforms[0].updateAvailable, true);
    assert.equal(checked.platforms[0].updateCommand, "lupin platform update npm-demo");

    const listed = await listPlatforms(stateDir, { checkUpdates: true });
    const platform = listed.platforms.find((item) => item.name === "npm-demo");
    assert.equal(platform.latestVersion, "1.2.0");
  } finally {
    globalThis.fetch = originalFetch;

    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;

    if (originalLogPath == null) delete process.env.FAKE_NPM_LOG_PATH;
    else process.env.FAKE_NPM_LOG_PATH = originalLogPath;

    if (originalVersion == null) delete process.env.FAKE_NPM_PLATFORM_VERSION;
    else process.env.FAKE_NPM_PLATFORM_VERSION = originalVersion;

    if (originalRegistry == null) delete process.env.LUPIN_NPM_REGISTRY_URL;
    else process.env.LUPIN_NPM_REGISTRY_URL = originalRegistry;

    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  }
});
