import assert from "node:assert/strict";
import test from "node:test";
import { extractLinks } from "../src/crawl/discovery.js";

test("extracts absolute links from HTML", () => {
  const html = `<html><body><a href="https://example.com/page1">Page 1</a><a href="https://example.com/page2">Page 2</a></body></html>`;
  const links = extractLinks(html, "https://example.com/");
  assert.deepEqual(links, [
    "https://example.com/page1",
    "https://example.com/page2",
  ]);
});

test("resolves relative links against base URL", () => {
  const html = `<a href="/about">About</a><a href="contact">Contact</a>`;
  const links = extractLinks(html, "https://example.com/docs/");
  assert.ok(links.includes("https://example.com/about"));
  assert.ok(links.includes("https://example.com/docs/contact"));
});

test("deduplicates links", () => {
  const html = `<a href="/page">Link 1</a><a href="/page">Link 2</a><a href="/page#section">Link 3</a>`;
  const links = extractLinks(html, "https://example.com/");
  const pageLinks = links.filter((l) => l.includes("/page"));
  assert.equal(pageLinks.length, 1);
});

test("skips non-http links", () => {
  const html = `<a href="mailto:user@example.com">Email</a><a href="javascript:void(0)">Click</a><a href="tel:+123">Call</a><a href="https://example.com/real">Real</a>`;
  const links = extractLinks(html, "https://example.com/");
  assert.equal(links.length, 1);
  assert.equal(links[0], "https://example.com/real");
});

test("skips links with no href", () => {
  const html = `<a>No href</a><a href="">Empty</a>`;
  const links = extractLinks(html, "https://example.com/");
  assert.equal(links.length, 0);
});

test("strips fragments from extracted links", () => {
  const html = `<a href="/page#top">Top</a>`;
  const links = extractLinks(html, "https://example.com/");
  assert.equal(links[0], "https://example.com/page");
});

test("skips common non-page extensions", () => {
  const html = `<a href="/file.pdf">PDF</a><a href="/image.png">PNG</a><a href="/style.css">CSS</a><a href="/page">Page</a><a href="/doc.html">HTML</a>`;
  const links = extractLinks(html, "https://example.com/");
  assert.deepEqual(links, [
    "https://example.com/page",
    "https://example.com/doc.html",
  ]);
});
