// test/crawl-session.test.js
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { CrawlSession } from "../src/crawl/crawler.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function createTestSite() {
  // Each page needs >= 80 chars of visible text so Lupin's HTTP engine marks it as ok
  // (analyzeAttempt requires textLength >= 80 to avoid escalating to browser engines).
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.";
  const pages = {
    "/": `<html><head><title>Home Page</title></head><body><h1>Home</h1><p>${filler}</p><a href="/about">About</a><a href="/blog">Blog</a></body></html>`,
    "/about": `<html><head><title>About Page</title></head><body><h1>About</h1><p>${filler}</p><a href="/">Home</a><a href="/team">Team</a></body></html>`,
    "/blog": `<html><head><title>Blog Page</title></head><body><h1>Blog</h1><p>${filler}</p><a href="/">Home</a><a href="/blog/post-1">Post 1</a></body></html>`,
    "/blog/post-1": `<html><head><title>Post 1</title></head><body><h1>Post 1</h1><p>${filler}</p><a href="/blog">Blog</a></body></html>`,
    "/team": `<html><head><title>Team Page</title></head><body><h1>Team</h1><p>${filler}</p><a href="/about">About</a></body></html>`,
  };

  return http.createServer((req, res) => {
    const html = pages[req.url];
    if (html) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
}

test("map: discovers all pages on test site", async () => {
  const server = createTestSite();
  await listen(server);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const session = new CrawlSession({
      url: baseUrl + "/",
      mode: "map",
      depth: 10,
      limit: 100,
      useSitemap: false,
      respectRobots: false,
    });
    const result = await session.run();
    assert.ok(result.urls.length >= 5, `Expected >= 5 URLs, got ${result.urls.length}`);
    assert.ok(result.urls.some((u) => u.includes("/about")));
    assert.ok(result.urls.some((u) => u.includes("/blog")));
    assert.ok(result.urls.some((u) => u.includes("/team")));
    assert.ok(result.urls.some((u) => u.includes("/blog/post-1")));
  } finally {
    await close(server);
  }
});

test("map: respects depth limit", async () => {
  const server = createTestSite();
  await listen(server);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const session = new CrawlSession({
      url: baseUrl + "/",
      mode: "map",
      depth: 1,
      limit: 100,
      useSitemap: false,
      respectRobots: false,
    });
    const result = await session.run();
    // Depth 0: / -> Depth 1: /about, /blog
    // /team and /blog/post-1 are at depth 2, should be excluded
    assert.ok(result.urls.length <= 3, `Expected <= 3 URLs at depth 1, got ${result.urls.length}`);
  } finally {
    await close(server);
  }
});

test("map: respects limit", async () => {
  const server = createTestSite();
  await listen(server);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const session = new CrawlSession({
      url: baseUrl + "/",
      mode: "map",
      depth: 10,
      limit: 3,
      useSitemap: false,
      respectRobots: false,
    });
    const result = await session.run();
    assert.ok(result.urls.length <= 3, `Expected <= 3 URLs, got ${result.urls.length}`);
  } finally {
    await close(server);
  }
});

test("crawl: scrapes content from pages", async () => {
  const server = createTestSite();
  await listen(server);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const session = new CrawlSession({
      url: baseUrl + "/",
      mode: "crawl",
      depth: 1,
      limit: 10,
      format: "json",
      engine: "http",
      useSitemap: false,
      respectRobots: false,
    });
    const result = await session.run();
    assert.ok(result.results.length >= 2);
    for (const entry of result.results) {
      assert.ok(entry.url, "Each result should have a url");
      if (!entry.error) {
        assert.ok(entry.title, "Successful results should have a title");
      }
    }
  } finally {
    await close(server);
  }
});

test("crawl: handles page errors gracefully", async () => {
  const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.";
  const server = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>Error Test</title></head><body><p>${filler}</p><a href="/broken">Broken</a></body></html>`);
    } else {
      res.writeHead(500);
      res.end("Server Error");
    }
  });

  await listen(server);
  const port = server.address().port;

  try {
    const session = new CrawlSession({
      url: `http://127.0.0.1:${port}/`,
      mode: "crawl",
      depth: 1,
      limit: 10,
      format: "json",
      engine: "http",
      useSitemap: false,
      respectRobots: false,
    });
    const result = await session.run();
    assert.ok(result.summary);
    assert.ok(result.summary.total >= 1);
  } finally {
    await close(server);
  }
});

test("map: scope prefix restricts to path subtree", async () => {
  const server = createTestSite();
  await listen(server);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const session = new CrawlSession({
      url: baseUrl + "/blog",
      mode: "map",
      depth: 10,
      limit: 100,
      scope: "prefix",
      useSitemap: false,
      respectRobots: false,
    });
    const result = await session.run();
    for (const u of result.urls) {
      assert.ok(u.includes("/blog"), `URL ${u} should be under /blog prefix`);
    }
  } finally {
    await close(server);
  }
});
