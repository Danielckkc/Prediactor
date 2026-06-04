import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { fetchSitemap, parseRobotsTxt } from "../src/crawl/sitemap.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("parseRobotsTxt: extracts disallow rules for wildcard user-agent", () => {
  const content = `
User-agent: *
Disallow: /admin/
Disallow: /private
Allow: /admin/public

User-agent: Googlebot
Disallow: /no-google/
  `;
  const rules = parseRobotsTxt(content);
  assert.deepEqual(rules.disallow, ["/admin/", "/private"]);
  assert.deepEqual(rules.allow, ["/admin/public"]);
});

test("parseRobotsTxt: extracts sitemap URLs", () => {
  const content = `
User-agent: *
Disallow: /admin/

Sitemap: https://example.com/sitemap.xml
Sitemap: https://example.com/sitemap-posts.xml
  `;
  const rules = parseRobotsTxt(content);
  assert.deepEqual(rules.sitemaps, [
    "https://example.com/sitemap.xml",
    "https://example.com/sitemap-posts.xml",
  ]);
});

test("parseRobotsTxt: returns empty rules for empty content", () => {
  const rules = parseRobotsTxt("");
  assert.deepEqual(rules.disallow, []);
  assert.deepEqual(rules.allow, []);
  assert.deepEqual(rules.sitemaps, []);
});

test("fetchSitemap: parses urlset XML", async () => {
  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(sitemapXml);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await listen(server);
  const port = server.address().port;
  try {
    const urls = await fetchSitemap(`http://127.0.0.1:${port}/sitemap.xml`);
    assert.deepEqual(urls, ["https://example.com/page1", "https://example.com/page2"]);
  } finally {
    await close(server);
  }
});

test("fetchSitemap: handles sitemap index (recursive)", async () => {
  const pagesXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/from-index</loc></url>
</urlset>`;

  const server = http.createServer((req, res) => {
    if (req.url === "/sitemap.xml") {
      const indexXml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1:${server.address().port}/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(indexXml);
    } else if (req.url === "/sitemap-pages.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(pagesXml);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await listen(server);
  const port = server.address().port;
  try {
    const urls = await fetchSitemap(`http://127.0.0.1:${port}/sitemap.xml`);
    assert.deepEqual(urls, ["https://example.com/from-index"]);
  } finally {
    await close(server);
  }
});

test("fetchSitemap: returns empty array on 404", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });

  await listen(server);
  const port = server.address().port;
  try {
    const urls = await fetchSitemap(`http://127.0.0.1:${port}/sitemap.xml`);
    assert.deepEqual(urls, []);
  } finally {
    await close(server);
  }
});
