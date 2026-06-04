import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CrawlOutputWriter } from "../src/crawl/output.js";

async function makeTempFile(ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lupin-crawl-out-"));
  return path.join(dir, `output.${ext}`);
}

test("JSON array mode: writes valid JSON with multiple entries", async () => {
  const filePath = await makeTempFile("json");
  const writer = new CrawlOutputWriter(filePath, { format: "json" });
  await writer.open();
  await writer.write({ url: "https://a.com/1", title: "Page 1" });
  await writer.write({ url: "https://a.com/2", title: "Page 2" });
  await writer.close();
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].url, "https://a.com/1");
  assert.equal(parsed[1].url, "https://a.com/2");
});

test("JSON array mode: writes valid JSON with zero entries", async () => {
  const filePath = await makeTempFile("json");
  const writer = new CrawlOutputWriter(filePath, { format: "json" });
  await writer.open();
  await writer.close();
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed, []);
});

test("JSON array mode: writes valid JSON with one entry", async () => {
  const filePath = await makeTempFile("json");
  const writer = new CrawlOutputWriter(filePath, { format: "json" });
  await writer.open();
  await writer.write({ url: "https://a.com/1", title: "Page 1" });
  await writer.close();
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  assert.equal(parsed.length, 1);
});

test("JSONL mode: writes one JSON object per line", async () => {
  const filePath = await makeTempFile("jsonl");
  const writer = new CrawlOutputWriter(filePath, { format: "jsonl" });
  await writer.open();
  await writer.write({ url: "https://a.com/1" });
  await writer.write({ url: "https://a.com/2" });
  await writer.close();
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).url, "https://a.com/1");
  assert.equal(JSON.parse(lines[1]).url, "https://a.com/2");
});

test("stdout mode: collects results and returns JSON array", async () => {
  const writer = new CrawlOutputWriter(null, { format: "json" });
  await writer.open();
  await writer.write({ url: "https://a.com/1" });
  await writer.write({ url: "https://a.com/2" });
  const results = await writer.close();
  assert.equal(results.length, 2);
});

test("error entries are included in output", async () => {
  const filePath = await makeTempFile("json");
  const writer = new CrawlOutputWriter(filePath, { format: "json" });
  await writer.open();
  await writer.write({ url: "https://a.com/ok", title: "OK" });
  await writer.write({ url: "https://a.com/fail", error: "blocked", reason: "Cloudflare" });
  await writer.close();
  const content = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(content);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].error, "blocked");
});
