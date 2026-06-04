import { renderPageMarkdown } from "../../runtime/render-structured.js";

export function buildProfileMarkdownContent(content, finalUrl, platformName = "Profile") {
  const lines = [];
  if (content.title) lines.push(content.title);
  if (content.author?.handle) lines.push(content.author.handle);
  if (content.text) lines.push(content.text);
  if (content.stats) {
    const statLines = Object.entries(content.stats)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${value}`);
    if (statLines.length) lines.push(statLines.join("\n"));
  }
  if (content.latestPosts?.length) {
    const label = content.latestPosts[0]?.type === "video" ? "Latest videos" : "Latest posts";
    lines.push(`${label}:\n${content.latestPosts.map((p) => `  ${p.url}`).join("\n")}`);
  }

  return renderPageMarkdown({
    title: content.title || `${platformName} Profile`,
    url: finalUrl,
    text: lines.join("\n\n"),
    links: [],
  });
}
