import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createFixturePlatform(dir) {
  const manifest = {
    apiVersion: 1,
    name: "local-demo",
    displayName: "Local Demo",
    description: "Fixture platform used to test installable provider flows.",
    version: "0.0.1",
    entry: "./index.js",
    tools: {
      search: [
        {
          tool: "search_localdemo",
          alias: "localdemo",
          description: "Search the local demo platform.",
          inputSchema: "search.standard",
          handler: "search",
        },
      ],
      fetch: [
        {
          tool: "fetch_localdemo_item",
          alias: "localdemo",
          description: "Fetch a local demo item.",
          inputSchema: "fetch.standard",
          handler: "fetchItem",
        },
      ],
    },
    smokeTests: [
      {
        name: "fixture-search",
        kind: "search",
        alias: "localdemo",
        query: "smoke query",
      },
    ],
  };

  const entrySource = `export async function search(args, context) {
  const { createSearchResponse, snapshotDateUtc } = context.sdk;
  return createSearchResponse(
    "local-demo",
    args.query,
    "fixture",
    snapshotDateUtc(),
    [
      {
        rank: 1,
        title: "Fixture result",
        url: "https://example.com/local-demo",
        snippet: "query=" + args.query
      }
    ],
    []
  );
}

export async function fetchItem(args, context) {
  const { createFetchResponse, snapshotDateUtc } = context.sdk;
  return createFetchResponse(
    "local-demo",
    args.url,
    args.url,
    snapshotDateUtc(),
    args.format || "json",
    {
      entityType: "item",
      title: "Fixture item",
      author: { name: "Local Demo", handle: null, url: null },
      publishedAt: null,
      text: "served by plugin",
      stats: {},
      media: [],
      outboundLinks: [],
      comments: [],
      platform: {
        site: "localdemo",
        canonicalUrl: args.url
      }
    },
    {
      warnings: [],
      blocked: false,
      extraction: { method: "fixture", confidence: "high" },
      durationMs: 1
    }
  );
}
`;

  await fs.writeFile(path.join(dir, "lupin.platform.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(dir, "index.js"), entrySource);
}

async function runCli(args, env) {
  return execFile(process.execPath, ["./bin/lupin.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("platform CLI installs, uses, disables, enables, and removes a local platform", async () => {
  const stateDir = await makeTempDir("lupin-platform-cli-state-");
  const pluginDir = await makeTempDir("lupin-platform-plugin-");

  try {
    await createFixturePlatform(pluginDir);

    const install = await runCli(["platform", "install", pluginDir, "--json"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const installed = JSON.parse(install.stdout);
    assert.equal(installed.manifestName, "local-demo");

    const listAfterInstall = await runCli(["platform", "list", "--json"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const listed = JSON.parse(listAfterInstall.stdout);
    const listedLocalDemo = listed.platforms.find((platform) => platform.name === "local-demo");
    assert.ok(listedLocalDemo);
    assert.equal(listedLocalDemo.enabled, true);
    assert.equal(listedLocalDemo.status, "enabled");
    assert.equal(listedLocalDemo.version, "0.0.1");
    assert.equal(listedLocalDemo.source.kind, "path");
    assert.equal(listedLocalDemo.source.location, pluginDir);

    const listText = await runCli(["platform", "list"], {
      LUPIN_STATE_DIR: stateDir,
    });
    assert.match(listText.stdout, /local-demo \(path, enabled, v0\.0\.1\)/);

    const update = await runCli(["platform", "update", "local-demo", "--json"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const updateResult = JSON.parse(update.stdout);
    assert.equal(updateResult.name, "local-demo");
    assert.equal(updateResult.sourceKind, "path");
    assert.equal(updateResult.status, "revalidated");
    assert.equal(updateResult.newVersion, "0.0.1");

    const doctor = await runCli(["platform", "doctor", "local-demo", "--json"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const doctorResult = JSON.parse(doctor.stdout);
    assert.equal(doctorResult.platforms[0].name, "local-demo");
    assert.equal(doctorResult.platforms[0].status, "ok");
    assert.equal(doctorResult.platforms[0].smokeTests.length, 1);
    assert.ok(doctorResult.platforms[0].checks.some((check) => check.name === "manifest" && check.status === "ok"));

    const doctorSmoke = await runCli(["platform", "doctor", "local-demo", "--smoke", "--json"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const doctorSmokeResult = JSON.parse(doctorSmoke.stdout);
    assert.ok(
      doctorSmokeResult.platforms[0].checks.some(
        (check) => check.name === "smoke:fixture-search" && check.status === "ok"
      )
    );

    const search = await runCli(["search", "localdemo", "hello", "world"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const searchResult = JSON.parse(search.stdout);
    assert.equal(searchResult.provider, "local-demo");
    assert.equal(searchResult.results[0].snippet, "query=hello world");

    const fetch = await runCli(["fetch", "localdemo", "https://example.com/demo"], {
      LUPIN_STATE_DIR: stateDir,
    });
    const fetchResult = JSON.parse(fetch.stdout);
    assert.equal(fetchResult.provider, "local-demo");
    assert.equal(fetchResult.content.text, "served by plugin");

    await runCli(["platform", "disable", "local-demo"], {
      LUPIN_STATE_DIR: stateDir,
    });

    await assert.rejects(
      runCli(["search", "localdemo", "after", "disable"], {
        LUPIN_STATE_DIR: stateDir,
      }),
      /Unknown search platform/
    );

    await runCli(["platform", "enable", "local-demo"], {
      LUPIN_STATE_DIR: stateDir,
    });

    const searchAfterEnable = await runCli(["search", "localdemo", "back"], {
      LUPIN_STATE_DIR: stateDir,
    });
    assert.equal(JSON.parse(searchAfterEnable.stdout).provider, "local-demo");

    await runCli(["platform", "remove", "local-demo"], {
      LUPIN_STATE_DIR: stateDir,
    });

    await assert.rejects(
      runCli(["fetch", "localdemo", "https://example.com/demo"], {
        LUPIN_STATE_DIR: stateDir,
      }),
      /Unknown fetch platform/
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(pluginDir, { recursive: true, force: true });
  }
});
