/**
 * Transclude processor — handles `![[doc]]` and `![[doc#heading]]` syntax.
 * Returns processed HTML with transclusions rendered as inline components.
 */
import { api } from "$lib/api";

const TRANSCLUDE_REGEX = /!\[\[([^\]]+)\]\]/g;

interface TranscludeResult {
  html: string;
  transclusions: Array<{ target: string; docId: string | null; content: string; error: string | null }>;
}

/** Simple in-memory cache for transclusions */
const transcludeCache = new Map<string, { content: string; error: string | null; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCacheKey(target: string): string {
  return target;
}

function getCached(target: string): { content: string; error: string | null } | null {
  const cached = transcludeCache.get(getCacheKey(target));
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    transcludeCache.delete(getCacheKey(target));
    return null;
  }
  return { content: cached.content, error: cached.error };
}

function setCache(target: string, content: string, error: string | null): void {
  transcludeCache.set(getCacheKey(target), { content, error, timestamp: Date.now() });
}

function parseTarget(target: string): { title: string; heading?: string; isId: boolean } {
  if (!target) return { title: "", isId: false };
  const [titlePart, heading] = target.split("#");
  const isId = /^[a-z0-9-]{20,}$/.test(titlePart.trim());
  return { title: titlePart.trim(), heading: heading?.trim(), isId };
}

/** Load transclusion content for a single target */
export async function loadTransclusion(target: string): Promise<{ content: string; error: string | null }> {
  const cached = getCached(target);
  if (cached) return cached;

  try {
    const { title, heading, isId } = parseTarget(target);
    if (!title) return { content: "", error: "Empty transclusion target" };

    let doc;
    if (isId) {
      doc = await api.docGet(title);
    } else {
      const results = await api.docSearchFull(title);
      const match = results.find((r) => r.doc.title.toLowerCase() === title.toLowerCase());
      if (!match) throw new Error(`Document "${title}" not found`);
      doc = match.doc;
    }

    if (doc.locked) {
      return { content: "", error: "Locked document — cannot transclude" };
    }

    let text = doc.content || "";
    setCache(target, text, null);

    // Extract heading section if specified
    if (heading) {
      const headingRegex = new RegExp(`^(#{1,6})\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
      const lines = text.split("\n");
      let startIdx = -1;
      let headingLevel = 0;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(headingRegex);
        if (m) {
          startIdx = i;
          headingLevel = m[1].length;
          break;
        }
      }
      if (startIdx === -1) {
        return { content: "", error: `Heading "${heading}" not found` };
      }
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#{1,6})\s+/);
        if (m && m[1].length <= headingLevel) {
          endIdx = i;
          break;
        }
      }
      text = lines.slice(startIdx, endIdx).join("\n");
      setCache(target, text, null);
    }

    return { content: text, error: null };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Failed to load transclusion";
    setCache(target, "", error);
    return { content: "", error };
  }
}

/** Process markdown content and replace transclusions with rendered HTML */
export async function processTransclusions(markdown: string): Promise<string> {
  const matches = [...markdown.matchAll(TRANSCLUDE_REGEX)];
  if (matches.length === 0) return markdown;

  let result = markdown;
  const processed = new Set<string>();

  for (const match of matches) {
    const target = match[1];
    if (processed.has(target)) continue;
    processed.add(target);

    const { content, error } = await loadTransclusion(target);
    const placeholder = `\n\n::transclude::${target}::\n\n`;

    if (error) {
      const errorHtml = `<div class="transclude transclude-error" title="${escapeHtml(error)}">
        <span>⚠ Transclusion failed: ${escapeHtml(error)}</span>
        <button class="transclude-retry" data-target="${escapeHtml(target)}">Retry</button>
      </div>`;
      result = result.replace(match[0], placeholder + errorHtml + placeholder);
    } else if (content) {
      const transcludeHtml = `<div class="transclude" data-transclude-target="${escapeHtml(target)}">
        <div class="transclude-content">${escapeHtml(content).replace(/\n/g, "<br>")}</div>
        <div class="transclude-footer">
          <span class="transclude-source">← [[${escapeHtml(target)}]]</span>
          <span class="transclude-open" data-doc-id="">↗ Open</span>
        </div>
      </div>`;
      result = result.replace(match[0], placeholder + transcludeHtml + placeholder);
    }
  }

  return result;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/'/g, "&#039;");
}

/** Clear transclusion cache (call on doc save/delete) */
export function clearTranscludeCache(): void {
  transcludeCache.clear();
}