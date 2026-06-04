import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPlatformRegistry } from "../src/platforms/registry.js";
import { writePlatformConfig } from "../src/platforms/state.js";

async function makeTempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-platform-registry-"));
}

async function makeTempPluginDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-platform-plugin-"));
}

test("platform registry exposes built-in platform aliases and tools", async () => {
  const stateDir = await makeTempStateDir();

  try {
    const registry = await loadPlatformRegistry({ stateDir });

    assert.equal(registry.issues.length, 0);
    assert.equal(registry.resolveFetchAlias("instagram")?.tool, "fetch_instagram_post");
    assert.equal(registry.resolveFetchAlias("tiktok-profile")?.tool, "fetch_tiktok_profile");
    assert.equal(registry.resolveSearchAlias("reddit")?.tool, "search_reddit");
    assert.equal(registry.getToolBrowserRequirements("search_instagram").camoufox, true);
    assert.equal(registry.getToolBrowserRequirements("fetch_instagram_profile").camoufox, true);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("external platform packages override matching built-ins", async () => {
  const stateDir = await makeTempStateDir();
  const packageDir = path.resolve("packages/platform-instagram");

  try {
    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: packageDir }],
      disabled: [],
    });

    const registry = await loadPlatformRegistry({ stateDir });
    const instagram = registry.listPlatforms().find((platform) => platform.name === "instagram");

    assert.equal(registry.issues.length, 0);
    assert.equal(instagram?.sourceKind, "path");
    assert.equal(instagram?.version, "0.1.0");
    assert.equal(instagram?.source.location, packageDir);
    assert.equal(registry.resolveFetchAlias("instagram")?.tool, "fetch_instagram_post");
    assert.equal(registry.resolveSearchAlias("instagram")?.tool, "search_instagram");
    assert.equal(
      registry.listPlatforms().filter((platform) => platform.name === "instagram").length,
      1
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("disabled platforms disappear from active registry resolution", async () => {
  const stateDir = await makeTempStateDir();

  try {
    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [],
      disabled: ["instagram", "tiktok"],
    });

    const registry = await loadPlatformRegistry({ stateDir });

    assert.equal(registry.resolveFetchAlias("instagram"), null);
    assert.equal(registry.resolveSearchAlias("tiktok"), null);

    const instagram = registry.listPlatforms().find((platform) => platform.name === "instagram");
    const tiktok = registry.listPlatforms().find((platform) => platform.name === "tiktok");

    assert.equal(instagram?.enabled, false);
    assert.equal(instagram?.status, "disabled");
    assert.equal(instagram?.broken, false);
    assert.equal(instagram?.source.kind, "builtin");
    assert.equal(instagram?.source.manifestPath.endsWith("lupin.platform.json"), true);
    assert.equal(tiktok?.enabled, false);
    assert.equal(tiktok?.status, "disabled");
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("disabled custom platforms are not imported while loading the registry", async () => {
  const stateDir = await makeTempStateDir();
  const pluginDir = await makeTempPluginDir();

  try {
    await fs.writeFile(
      path.join(pluginDir, "lupin.platform.json"),
      `${JSON.stringify({
        apiVersion: 1,
        name: "broken-disabled",
        displayName: "Broken Disabled",
        description: "Fixture platform that should never be imported while disabled.",
        version: "0.0.1",
        entry: "./index.js",
        tools: {
          search: [],
          fetch: [],
        },
      }, null, 2)}\n`
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      "throw new Error('disabled plugin should not be imported');\n"
    );

    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: pluginDir }],
      disabled: ["broken-disabled"],
    });

    const registry = await loadPlatformRegistry({ stateDir });

    assert.equal(
      registry.issues.some((issue) => issue.error.includes("disabled plugin should not be imported")),
      false
    );

    const platform = registry.listPlatforms().find((item) => item.name === "broken-disabled");
    assert.ok(platform);
    assert.equal(platform?.enabled, false);
    assert.equal(platform?.status, "disabled");
    assert.equal(platform?.version, "0.0.1");
    assert.equal(platform?.source.kind, "path");
    assert.equal(platform?.source.location, pluginDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});

test("enabled custom platform descriptors include status and path source metadata", async () => {
  const stateDir = await makeTempStateDir();
  const pluginDir = await makeTempPluginDir();

  try {
    await fs.writeFile(
      path.join(pluginDir, "lupin.platform.json"),
      `${JSON.stringify({
        apiVersion: 1,
        name: "metadata-demo",
        displayName: "Metadata Demo",
        description: "Fixture platform used to inspect metadata.",
        version: "1.2.3",
        entry: "./index.js",
        tools: {
          search: [],
          fetch: [],
        },
        smokeTests: [
          {
            name: "metadata",
            kind: "search",
            alias: "metadata-demo",
            query: "hello",
          },
        ],
      }, null, 2)}\n`
    );
    await fs.writeFile(path.join(pluginDir, "index.js"), "export const ok = true;\n");

    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: pluginDir }],
      disabled: [],
    });

    const registry = await loadPlatformRegistry({ stateDir });
    const platform = registry.listPlatforms().find((item) => item.name === "metadata-demo");

    assert.ok(platform);
    assert.equal(platform.status, "enabled");
    assert.equal(platform.enabled, true);
    assert.equal(platform.broken, false);
    assert.equal(platform.version, "1.2.3");
    assert.deepEqual(platform.source, {
      kind: "path",
      manifestPath: path.join(pluginDir, "lupin.platform.json"),
      location: pluginDir,
    });
    assert.deepEqual(platform.smokeTests, [
      {
        name: "metadata",
        kind: "search",
        alias: "metadata-demo",
        url: null,
        query: "hello",
        args: {},
      },
    ]);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});

test("broken enabled platforms expose broken status and error", async () => {
  const stateDir = await makeTempStateDir();
  const pluginDir = await makeTempPluginDir();

  try {
    await fs.writeFile(
      path.join(pluginDir, "lupin.platform.json"),
      `${JSON.stringify({
        apiVersion: 1,
        name: "broken-enabled",
        displayName: "Broken Enabled",
        description: "Fixture platform with a missing handler.",
        version: "0.0.2",
        entry: "./index.js",
        tools: {
          search: [
            {
              tool: "search_broken_enabled",
              alias: "broken-enabled",
              description: "Broken fixture search.",
              inputSchema: "search.standard",
              handler: "missingSearch",
            },
          ],
          fetch: [],
        },
      }, null, 2)}\n`
    );
    await fs.writeFile(path.join(pluginDir, "index.js"), "export const ok = true;\n");

    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: pluginDir }],
      disabled: [],
    });

    const registry = await loadPlatformRegistry({ stateDir });
    const platform = registry.listPlatforms().find((item) => item.name === "broken-enabled");

    assert.ok(platform);
    assert.equal(platform.status, "broken");
    assert.equal(platform.enabled, false);
    assert.equal(platform.broken, true);
    assert.match(platform.error, /missing exported handler/);
    assert.equal(platform.source.kind, "path");
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});

test("platform entry must stay within the platform directory", async () => {
  const stateDir = await makeTempStateDir();
  const pluginDir = await makeTempPluginDir();

  try {
    await fs.writeFile(
      path.join(pluginDir, "lupin.platform.json"),
      `${JSON.stringify({
        apiVersion: 1,
        name: "escaped-entry",
        displayName: "Escaped Entry",
        description: "Fixture platform with an invalid entry path.",
        version: "0.0.1",
        entry: "../outside.js",
        tools: {
          search: [],
          fetch: [],
        },
      }, null, 2)}\n`
    );
    await fs.writeFile(path.join(path.dirname(pluginDir), "outside.js"), "export const nope = true;\n");

    await writePlatformConfig(stateDir, {
      version: 1,
      sources: [{ kind: "path", location: pluginDir }],
      disabled: [],
    });

    const registry = await loadPlatformRegistry({ stateDir });

    assert.equal(
      registry.issues.some((issue) => issue.error.includes("entry must stay within its platform directory")),
      true
    );
    assert.equal(
      registry.listPlatforms().some((platform) => platform.name === "escaped-entry"),
      false
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});
