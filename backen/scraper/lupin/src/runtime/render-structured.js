export function renderPageMarkdown(payload) {
  const parts = [];

  if (payload.title) {
    parts.push(`# ${payload.title}`);
  }

  if (payload.url) {
    parts.push(`Source: ${payload.url}`);
  }

  if (payload.text) {
    parts.push(payload.text);
  }

  if (payload.links?.length) {
    parts.push(
      ["Links:", ...payload.links.slice(0, 20).map((link) => `- ${link.text || link.href}: ${link.href}`)].join("\n")
    );
  }

  return parts.filter(Boolean).join("\n\n").trim();
}
