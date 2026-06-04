import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { parseHTML } from "linkedom";
import { renderPageMarkdown } from "./render-structured.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  hr: "---",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

turndown.use(gfm);

turndown.addRule("removeImages", {
  filter: "img",
  replacement: () => "",
});

turndown.addRule("preserveCodeBlocks", {
  filter: (node) => node.nodeName === "PRE" && node.querySelector("code"),
  replacement: (_, node) => {
    const code = node.querySelector("code");
    const lang = (code.className.match(/language-(\S+)/) || [])[1] || "";
    return `\n\n\`\`\`${lang}\n${code.textContent}\n\`\`\`\n\n`;
  },
});

/**
 * Convert raw HTML into clean, LLM-ready markdown.
 *
 * Pipeline: linkedom DOM parse -> @mozilla/readability (boilerplate strip) -> turndown (HTML->MD).
 * Falls back to full-body conversion when Readability rejects the document (e.g. non-article pages).
 */
export function htmlToMarkdown(html, url) {
  if (!html || typeof html !== "string") return "";

  const { document } = parseHTML(html);

  if (url) {
    try {
      const base = document.createElement("base");
      base.setAttribute("href", url);
      document.head.appendChild(base);
    } catch {
      // ignore — relative links will stay relative
    }
  }

  // Clone before Readability — it mutates the DOM, so the fallback path needs the original
  const clone = document.cloneNode(true);

  const reader = new Readability(clone, {
    charThreshold: 0,
  });
  const article = reader.parse();

  let contentHtml;
  let title;

  if (article && article.content) {
    contentHtml = article.content;
    title = article.title || "";
  } else {
    // Readability rejected the document — fall back to body after stripping boilerplate tags
    for (const sel of ["nav", "footer", "header", "aside", "script", "style", "noscript", "form", "svg", "button", "select", "textarea"]) {
      for (const el of document.querySelectorAll(sel)) {
        el.remove();
      }
    }
    contentHtml = document.body?.innerHTML || html;
    title = document.querySelector("title")?.textContent || "";
  }

  const markdown = turndown.turndown(contentHtml);

  const parts = [];
  if (title) parts.push(`# ${title}`);
  if (url) parts.push(`Source: ${url}`);
  parts.push(markdown);

  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Build markdown from a scrape result, preferring Readability-based markdown
 * with a fallback to structured text when conversion quality is low.
 */
export function buildScrapeMarkdown(result) {
  if (!result.rawHtml) return result.text || "";
  const md = htmlToMarkdown(result.rawHtml, result.url);
  const textFallback = renderPageMarkdown({ title: result.title, url: result.url, text: result.text, links: result.links || [] });
  const mdBody = md.replace(/^(#[^\n]*\n+)?Source:[^\n]*\n*/m, "").trim();
  // Reject conversions that are too short OR still mostly HTML (layout-table sites like HN)
  const htmlTagCount = (mdBody.match(/<[a-z][^>]*>/gi) || []).length;
  const isHtmlHeavy = htmlTagCount > 10 && htmlTagCount / mdBody.length > 0.01;
  if (mdBody.length < result.textLength * 0.65 || isHtmlHeavy) return textFallback;
  return md;
}
