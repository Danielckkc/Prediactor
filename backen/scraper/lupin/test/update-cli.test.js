import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

function startRegistryServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function runCli(args, env = {}) {
  return execFile(process.execPath, ["./bin/lupin.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
  });
}

test("update check reports newer core CLI release", async () => {
  const registry = await startRegistryServer((request, response) => {
    assert.equal(request.url, "/lupin-cli/latest");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "99.0.0" }));
  });

  try {
    const result = await runCli(["update", "check", "--json"], {
      LUPIN_NPM_REGISTRY_URL: registry.url,
    });
    const body = JSON.parse(result.stdout);

    assert.equal(body.lupin.ok, true);
    assert.equal(body.lupin.latestVersion, "99.0.0");
    assert.equal(body.lupin.updateAvailable, true);
    assert.equal(body.lupin.updateCommand, "npm install -g lupin-cli@latest");
  } finally {
    await registry.close();
  }
});

test("update check reports degraded registry failures", async () => {
  const registry = await startRegistryServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unavailable" }));
  });

  try {
    const result = await runCli(["update", "check"], {
      LUPIN_NPM_REGISTRY_URL: registry.url,
    });

    assert.match(result.stdout, /Lupin CLI: 0\.2\.0 installed/);
    assert.match(result.stdout, /Update check: DEGRADED - npm registry returned HTTP 503/);
  } finally {
    await registry.close();
  }
});

test("doctor JSON includes core update check metadata", async () => {
  const registry = await startRegistryServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "99.0.0" }));
  });

  try {
    const result = await runCli(["doctor", "--json"], {
      LUPIN_NPM_REGISTRY_URL: registry.url,
    });
    const body = JSON.parse(result.stdout);

    assert.equal(body.lupin.ok, true);
    assert.equal(body.lupin.latestVersion, "99.0.0");
    assert.equal(body.lupin.updateAvailable, true);
  } finally {
    await registry.close();
  }
});

