import { trimText } from "../extractors.js";
import { extractStructuredJson } from "./extract-structured.js";
import { htmlToMarkdown } from "./markdown.js";

export async function extractPageJson(page) {
  const [url, text, rawHtml] = await Promise.all([
    Promise.resolve(page.url()),
    page.evaluate(() => document.body?.innerText || document.body?.textContent || "").catch(() => ""),
    page.evaluate(() => document.documentElement?.outerHTML || "").catch(() => ""),
  ]);

  const structured = rawHtml ? extractStructuredJson(rawHtml, url) : null;

  if (structured) {
    return {
      ...structured.metadata,
      url,
      text: trimText(text),
      headings: structured.headings,
      links: structured.links,
      images: structured.images,
    };
  }

  // Fallback when no HTML available (shouldn't happen in browser context)
  const title = await page.title().catch(() => "");
  return { title, url, text: trimText(text) };
}

export async function extractPageMarkdown(page) {
  const [url, html] = await Promise.all([
    Promise.resolve(page.url()),
    extractPageHtml(page),
  ]);
  return htmlToMarkdown(html, url);
}

export async function extractPageHtml(page) {
  return page.evaluate(() => document.documentElement?.outerHTML || "").catch(() => "");
}
