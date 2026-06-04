import assert from "node:assert/strict";
import test from "node:test";
import { Frontier } from "../src/crawl/frontier.js";

test("enqueue and dequeue in FIFO order", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/1", 0);
  frontier.enqueue("https://a.com/2", 0);
  const first = frontier.dequeue();
  const second = frontier.dequeue();
  assert.equal(first.url, "https://a.com/1");
  assert.equal(second.url, "https://a.com/2");
});

test("dequeue returns null when empty", () => {
  const frontier = new Frontier();
  assert.equal(frontier.dequeue(), null);
});

test("deduplicates identical URLs", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/page", 0);
  frontier.enqueue("https://a.com/page", 0);
  assert.equal(frontier.size, 1);
  frontier.dequeue();
  assert.equal(frontier.dequeue(), null);
});

test("normalizes URLs: strips fragment", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/page#section", 0);
  frontier.enqueue("https://a.com/page", 0);
  assert.equal(frontier.size, 1);
});

test("normalizes URLs: sorts query params", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/page?b=2&a=1", 0);
  frontier.enqueue("https://a.com/page?a=1&b=2", 0);
  assert.equal(frontier.size, 1);
});

test("normalizes URLs: lowercases hostname", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://Example.COM/Page", 0);
  frontier.enqueue("https://example.com/Page", 0);
  assert.equal(frontier.size, 1);
});

test("normalizes URLs: strips trailing slash on path", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/page/", 0);
  frontier.enqueue("https://a.com/page", 0);
  assert.equal(frontier.size, 1);
});

test("tracks depth correctly", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/", 0);
  frontier.enqueue("https://a.com/child", 1);
  frontier.enqueue("https://a.com/deep", 2);
  assert.equal(frontier.dequeue().depth, 0);
  assert.equal(frontier.dequeue().depth, 1);
  assert.equal(frontier.dequeue().depth, 2);
});

test("respects maxDepth", () => {
  const frontier = new Frontier({ maxDepth: 1 });
  assert.equal(frontier.enqueue("https://a.com/", 0), true);
  assert.equal(frontier.enqueue("https://a.com/child", 1), true);
  assert.equal(frontier.enqueue("https://a.com/deep", 2), false);
});

test("respects maxUrls", () => {
  const frontier = new Frontier({ maxUrls: 2 });
  assert.equal(frontier.enqueue("https://a.com/1", 0), true);
  assert.equal(frontier.enqueue("https://a.com/2", 0), true);
  assert.equal(frontier.enqueue("https://a.com/3", 0), false);
});

test("visited count tracks total enqueued", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/1", 0);
  frontier.enqueue("https://a.com/2", 0);
  frontier.enqueue("https://a.com/1", 0); // dupe
  assert.equal(frontier.visitedCount, 2);
});

test("pending count tracks unprocessed items", () => {
  const frontier = new Frontier();
  frontier.enqueue("https://a.com/1", 0);
  frontier.enqueue("https://a.com/2", 0);
  assert.equal(frontier.pending, 2);
  frontier.dequeue();
  assert.equal(frontier.pending, 1);
});

test("ignoreQueryParams strips all query strings", () => {
  const frontier = new Frontier({ ignoreQueryParams: true });
  frontier.enqueue("https://a.com/page?ref=twitter", 0);
  frontier.enqueue("https://a.com/page?ref=facebook", 0);
  assert.equal(frontier.size, 1);
});
