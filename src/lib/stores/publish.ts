import { writable } from "svelte/store";
import { api } from "$lib/api";
import { showToast } from "./notifications";

export interface PublishConfig {
  title: string;
  description: string;
  baseUrl: string;
  theme: "light" | "dark" | "auto";
  includeWorkspaces: string[];
  includeDrafts: boolean;
  tocDepth: number;
  customCss?: string;
  customJs?: string;
  favicon?: string;
}

export interface PublishResult {
  outputDir: string;
  files: string[];
  indexHtml: string;
}

const defaultConfig: PublishConfig = {
  title: "My Writing",
  description: "Published from Just Write",
  baseUrl: "/",
  theme: "auto",
  includeWorkspaces: ["write", "novel", "projects"],
  includeDrafts: false,
  tocDepth: 3,
};

export const publishConfig = writable<PublishConfig>(defaultConfig);
export const isPublishing = writable(false);
export const lastPublishResult = writable<PublishResult | null>(null);

function renderHtml(title: string, content: string, config: PublishConfig): string {
  const themeCss = config.theme === "dark" ? "dark" : config.theme === "light" ? "light" : "auto";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(config.description)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-body: 'Merriweather', Georgia, serif;
      --font-mono: 'JetBrains Mono', monospace;
      --font-heading: 'Merriweather', Georgia, serif;
      --color-bg: #fafafa;
      --color-text: #1a1a2e;
      --color-muted: #6b6b80;
      --color-primary: #2d6cdf;
      --color-border: #e0e0e8;
      --max-width: 720px;
      --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 32px;
      --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --color-bg: #1a1a2e;
        --color-text: #e8e8f0;
        --color-muted: #8b8ba8;
        --color-primary: #7aa2f7;
        --color-border: #2d2d44;
      }
    }
    [data-theme="dark"] {
      --color-bg: #1a1a2e;
      --color-text: #e8e8f0;
      --color-muted: #8b8ba8;
      --color-primary: #7aa2f7;
      --color-border: #2d2d44;
    }
    [data-theme="light"] {
      --color-bg: #fafafa;
      --color-text: #1a1a2e;
      --color-muted: #6b6b80;
      --color-primary: #2d6cdf;
      --color-border: #e0e0e8;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--font-body);
      background: var(--color-bg);
      color: var(--color-text);
      line-height: 1.8;
      max-width: var(--max-width);
      margin: 0 auto;
      padding: var(--space-5) var(--space-3);
      font-size: 18px;
    }
    header { margin-bottom: var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--color-border); }
    header h1 { font-size: 2.5rem; margin: 0 0 var(--space-2); font-weight: 700; }
    header .meta { color: var(--color-muted); font-size: 0.95rem; }
    nav { margin-bottom: var(--space-5); padding: var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
    nav ul { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-2); }
    nav a { color: var(--color-primary); text-decoration: none; padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); }
    nav a:hover { background: var(--color-border); }
    article { padding-top: var(--space-4); }
    h1, h2, h3, h4 { font-family: var(--font-heading); color: var(--color-text); margin-top: var(--space-5); margin-bottom: var(--space-3); line-height: 1.3; }
    h1 { font-size: 2rem; } h2 { font-size: 1.6rem; } h3 { font-size: 1.3rem; } h4 { font-size: 1.1rem; }
    p { margin: var(--space-3) 0; }
    code { font-family: var(--font-mono); background: var(--color-border); padding: 2px 6px; border-radius: var(--radius-sm); font-size: 0.9em; }
    pre { background: #1e1e2e; color: #e8e8f0; padding: var(--space-3); border-radius: var(--radius-md); overflow-x: auto; font-size: 0.9rem; line-height: 1.6; }
    pre code { background: none; padding: 0; font-size: inherit; }
    blockquote { border-left: 3px solid var(--color-primary); padding-left: var(--space-3); margin: var(--space-3) 0; color: var(--color-muted); font-style: italic; }
    a { color: var(--color-primary); }
    a:hover { text-decoration: underline; }
    img { max-width: 100%; height: auto; border-radius: var(--radius-md); }
    hr { border: none; border-top: 1px solid var(--color-border); margin: var(--space-5) 0; }
    footer { margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--color-border); color: var(--color-muted); font-size: 0.85rem; text-align: center; }
    .toc { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-4); }
    .toc ul { list-style: none; padding-left: var(--space-3); }
    .toc li { margin: var(--space-1) 0; }
    .toc a { text-decoration: none; color: var(--color-text); }
    .toc a:hover { color: var(--color-primary); }
    @media (max-width: 600px) { body { font-size: 16px; padding: var(--space-3); } header h1 { font-size: 1.8rem; } }
    ${config.customCss || ""}
  </style>
    ${config.customJs ? `<script>${config.customJs}</script>` : ""}
</head>
  <body data-theme="${escapeHtml(config.theme)}">
  <header>
    <h1>${escapeHtml(config.title)}</h1>
    <div class="meta">${escapeHtml(config.description)}</div>
  </header>
  <nav><ul>${config.includeWorkspaces.map(w => `<li><a href="#${escapeHtml(w)}">${escapeHtml(w)}</a></li>`).join("")}</ul></nav>
  <article>${content}</article>
  <footer>Published from Just Write · ${new Date().toLocaleDateString()}</footer>
  <script>
    // Theme toggle
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const saved = localStorage.getItem('theme');
    if (saved) document.body.dataset.theme = saved;
    else if (prefersDark) document.body.dataset.theme = 'dark';
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function processDocForPublish(doc: any, config: PublishConfig): Promise<string> {
  let content = doc.content || "";
  // Process transclusions
  const transcludeRegex = /!\[\[([^\]]+)\]\]/g;
  const matches = [...content.matchAll(transcludeRegex)];
  for (const match of matches) {
    const target = match[1];
    const { content: transcluded, error } = await loadTransclusion(target);
    if (!error && transcluded) {
      content = content.replace(match[0], transcluded);
    }
  }
  return content;
}

async function loadTransclusion(target: string): Promise<{ content: string; error: string | null }> {
  try {
    const [titlePart, heading] = target.split("#");
    const isId = /^[a-z0-9-]{20,}$/.test(titlePart.trim());
    let doc;
    if (isId) {
      doc = await api.docGet(titlePart.trim());
    } else {
      const results = await api.docSearchFull(titlePart.trim());
      const match = results.find((r) => r.doc.title.toLowerCase() === titlePart.trim().toLowerCase());
      if (!match) throw new Error(`Document "${titlePart}" not found`);
      doc = match.doc;
    }
    if (doc.locked) return { content: "", error: "Locked document" };
    let text = doc.content || "";
    if (heading) {
      const headingRegex = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
      const lines = text.split("\n");
      let startIdx = -1, headingLevel = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(headingRegex);
        if (m) { startIdx = i; headingLevel = m[1].length; break; }
      }
      if (startIdx === -1) return { content: "", error: `Heading "${heading}" not found` };
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s+/);
        if (m && m[1].length <= headingLevel) { endIdx = i; break; }
      }
      text = lines.slice(startIdx, endIdx).join("\n");
    }
    return { content: text, error: null };
  } catch (e) {
    return { content: "", error: e instanceof Error ? e.message : "Failed to load transclusion" };
  }
}

function buildToc(content: string, maxDepth: number): string {
  const headings = content.match(/^(#{1,${maxDepth}})\s+(.+)$/gm) || [];
  if (headings.length === 0) return "";
  let toc = '<div class="toc"><strong>Contents</strong><ul>';
  for (const h of headings) {
    const match = h.match(/^(#+)\s+(.+)$/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2];
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    toc += `<li style="margin-left: ${(level - 1) * 1.5}rem"><a href="#${id}">${escapeHtml(text)}</a></li>`;
  }
  toc += '</ul></div>';
  return toc;
}

function processMarkdown(md: string): string {
  // Use a simple markdown processor for static generation
  // In production, this would use the same pulldown-cmark logic
  const slug = (t: string) =>
    escapeHtml(t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  // javascript: URIs execute with no quotes to break out of — never emit them.
  const safeHref = (src: string) =>
    /^\s*javascript:/i.test(src) ? "#" : escapeHtml(src);
  return md
    .replace(/^### (.+)$/gm, (_, t) => `<h3 id="${slug(t)}">${escapeHtml(t)}</h3>`)
    .replace(/^## (.+)$/gm, (_, t) => `<h2 id="${slug(t)}">${escapeHtml(t)}</h2>`)
    .replace(/^# (.+)$/gm, (_, t) => `<h1 id="${slug(t)}">${escapeHtml(t)}</h1>`)
    .replace(/\*\*(.+?)\*\*/g, (_, t) => `<strong>${escapeHtml(t)}</strong>`)
    .replace(/\*(.+?)\*/g, (_, t) => `<em>${escapeHtml(t)}</em>`)
    .replace(/`(.+?)`/g, (_, t) => `<code>${escapeHtml(t)}</code>`)
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (m, alt, src) => m.startsWith("!") ? `<img src="${safeHref(src)}" alt="${escapeHtml(alt)}">` : `<a href="${safeHref(src)}">${escapeHtml(alt)}</a>`)
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^\- \[ \] (.+)$/gm, '<label><input type="checkbox" disabled> $1</label>')
    .replace(/^\- \[x\] (.+)$/gm, '<label><input type="checkbox" checked disabled> $1</label>')
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n)+/g, '<ul>$&</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(.+)$/gm, '<p>$1</p>')
    .replace(/<p><h([1-6])/g, '<h$1')
    .replace(/<\/h([1-6])><\/p>/g, '</h$1>')
    .replace(/<p><ul>/g, '<ul>')
    .replace(/<\/ul><\/p>/g, '</ul>')
    .replace(/<p><blockquote>/g, '<blockquote>')
    .replace(/<\/blockquote><\/p>/g, '</blockquote>')
    .replace(/<p><img/g, '<img')
    .replace(/><\/p>/g, '>')
    .replace(/<p><code>/g, '<code>')
    .replace(/<\/code><\/p>/g, '</code>');
}

export async function publishStaticSite(config: Partial<PublishConfig> = {}): Promise<PublishResult> {
  const fullConfig = { ...defaultConfig, ...config };
  isPublishing.set(true);
  
  try {
    const allDocs: any[] = [];
    for (const ws of fullConfig.includeWorkspaces) {
      const docs = await api.docListByWorkspace(ws);
      // Locked docs never publish — mirrors the Rust backend filter.
      allDocs.push(...docs.filter(d => (fullConfig.includeDrafts || d.status !== "draft") && !d.locked));
    }

    let html = "";
    let files: string[] = [];

    // Group by workspace
    const byWs = new Map<string, any[]>();
    for (const doc of allDocs) {
      if (!byWs.has(doc.workspace)) byWs.set(doc.workspace, []);
      byWs.get(doc.workspace)!.push(doc);
    }

    for (const [ws, docs] of byWs) {
      html += `<section id="${escapeHtml(ws)}"><h2>${escapeHtml(ws)}</h2>`;
      for (const doc of docs) {
        const content = await processDocForPublish(doc, fullConfig);
        const processed = processMarkdown(content);
        const toc = buildToc(content, fullConfig.tocDepth);
        html += `<article><h1 id="${escapeHtml(doc.id)}">${escapeHtml(doc.title)}${toc}${processed}</article>`;
      }
      html += "</section>";
    }

    const fullHtml = renderHtml(fullConfig.title, html, fullConfig);
    files.push("index.html");

    // For now, return the HTML content; actual file writing happens in Tauri
    const result: PublishResult = {
      outputDir: "",
      files,
      indexHtml: fullHtml,
    };

    lastPublishResult.set(result);
    isPublishing.set(false);
    showToast("Static site generated successfully", "success");
    return result;
  } catch (e) {
    isPublishing.set(false);
    showToast(`Publish failed: ${e instanceof Error ? e.message : e}`, "error");
    throw e;
  }
}