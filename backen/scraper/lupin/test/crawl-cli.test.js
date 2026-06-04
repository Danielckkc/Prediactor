import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIN = new URL("../bin/lupin.js", import.meta.url).pathname;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("lupin map outputs URL list", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><head><title>Test Page</title></head><body><p>${"Hello world. ".repeat(20)}</p><a href="/page2">P2</a></body></html>`);
  });
  await listen(server);
  const port = server.address().port;

  try {
    const { stdout } = await execFileAsync("node", [
      BIN, "map", `http://127.0.0.1:${port}/`, "--depth", "1", "--limit", "10",
    ], { timeout: 30000 });
    const lines = stdout.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "Should output at least 1 URL");
    assert.ok(lines[0].startsWith("http"), "Each line should be a URL");
  } finally {
    await close(server);
  }
});

test("lupin crawl outputs JSON array", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><head><title>Test Page Title</title></head><body><main><p>${"This is a test page with enough content to pass analysis. ".repeat(10)}</p></main></body></html>`);
  });
  await listen(server);
  const port = server.address().port;

  try {
    const { stdout } = await execFileAsync("node", [
      BIN, "crawl", `http://127.0.0.1:${port}/`, "--depth", "0", "--limit", "1",
    ], { timeout: 30000 });
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed), "Output should be a JSON array");
    assert.ok(parsed.length >= 1, "Should have at least 1 result");
    assert.ok(parsed[0].url, "Each result should have a url");
  } finally {
    await close(server);
  }
});

test("lupin crawl without URL shows usage", async () => {
  try {
    await execFileAsync("node", [BIN, "crawl"], { timeout: 10000 });
    assert.fail("Should have exited with error");
  } catch (error) {
    assert.ok(error.stderr.includes("Usage"));
  }
});
