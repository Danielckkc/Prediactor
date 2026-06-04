import assert from "node:assert/strict";
import test from "node:test";
import { createScopeChecker } from "../src/crawl/scope.js";

test("same-hostname rejects different hostname", () => {
  const check = createScopeChecker("https://docs.example.com/guide", { scope: "same-hostname" });
  assert.equal(check("https://blog.example.com/post"), false);
});

test("same-hostname accepts same hostname different path", () => {
  const check = createScopeChecker("https://docs.example.com/guide", { scope: "same-hostname" });
  assert.equal(check("https://docs.example.com/api/auth"), true);
});

test("same-hostname strips www from both sides", () => {
  const check = createScopeChecker("https://www.example.com/", { scope: "same-hostname" });
  assert.equal(check("https://example.com/about"), true);
});

test("same-domain accepts subdomains", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-domain" });
  assert.equal(check("https://docs.example.com/guide"), true);
  assert.equal(check("https://blog.example.com/post"), true);
});

test("same-domain rejects different domain", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-domain" });
  assert.equal(check("https://other.com/page"), false);
});

test("prefix only accepts URLs under start path", () => {
  const check = createScopeChecker("https://docs.example.com/api/v2/", { scope: "prefix" });
  assert.equal(check("https://docs.example.com/api/v2/auth"), true);
  assert.equal(check("https://docs.example.com/api/v1/auth"), false);
  assert.equal(check("https://docs.example.com/guide"), false);
});

test("include globs filter URLs", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-hostname", include: ["/docs/**"] });
  assert.equal(check("https://example.com/docs/api/auth"), true);
  assert.equal(check("https://example.com/blog/post"), false);
});

test("exclude globs reject URLs", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-hostname", exclude: ["/admin/**"] });
  assert.equal(check("https://example.com/docs/guide"), true);
  assert.equal(check("https://example.com/admin/settings"), false);
});

test("include + exclude: exclude wins", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-hostname", include: ["/docs/**"], exclude: ["/docs/v1/**"] });
  assert.equal(check("https://example.com/docs/v2/auth"), true);
  assert.equal(check("https://example.com/docs/v1/auth"), false);
});

test("rejects non-http protocols", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-hostname" });
  assert.equal(check("mailto:user@example.com"), false);
  assert.equal(check("javascript:void(0)"), false);
  assert.equal(check("tel:+1234567890"), false);
});

test("rejects fragment-only and empty URLs", () => {
  const check = createScopeChecker("https://example.com/", { scope: "same-hostname" });
  assert.equal(check("#section"), false);
  assert.equal(check(""), false);
});
