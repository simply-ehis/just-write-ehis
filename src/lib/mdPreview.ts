/**
 * Rendered markdown preview (GFM: tables, task lists, strikethrough, fenced
 * code) for read-only surfaces such as the Files viewer.
 *
 * Output is sanitised and made inert on purpose:
 *  - links never navigate (a plain <a href> would replace the whole app
 *    webview, and there is no opener plugin to hand them to the browser);
 *    the target stays in the tooltip so the reader can still see it.
 *  - images only render from data: URIs. Local paths and remote URLs cannot
 *    load under the app's CSP, so they show their alt text instead of a
 *    broken-image icon.
 *  - tables are wrapped so a wide table scrolls inside the column rather
 *    than pushing the page sideways.
 */
import { Marked } from "marked";

type Purifier = {
  sanitize: (dirty: string, cfg?: Record<string, unknown>) => string;
  addHook: (name: string, fn: (node: Element) => void) => void;
};

const marked = new Marked({ gfm: true, breaks: false, async: false });

function configure(purify: Purifier): Purifier {
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") ?? "";
      if (href && !href.startsWith("#")) {
        node.removeAttribute("href");
        node.setAttribute("title", href);
        node.setAttribute("class", "md-link-inert");
      }
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") ?? "";
      if (!src.startsWith("data:image/")) {
        const alt = node.getAttribute("alt") ?? "";
        const span = node.ownerDocument.createElement("span");
        span.setAttribute("class", "md-image-missing");
        span.textContent = alt ? `[image: ${alt}]` : "[image]";
        node.replaceWith(span);
      }
    }
  });
  return purify;
}

/** Build a renderer around a DOMPurify instance (tests pass a jsdom one). */
export function createMarkdownPreview(purify: Purifier): (md: string) => string {
  const p = configure(purify);
  return (md: string): string => {
    const raw = marked.parse(md ?? "") as string;
    const clean = p.sanitize(raw, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "script"],
      FORBID_ATTR: ["style", "onerror", "onload"],
    });
    return clean
      .replace(/<table>/g, '<div class="md-table-wrap"><table>')
      .replace(/<\/table>/g, "</table></div>");
  };
}

let browserRenderer: ((md: string) => string) | null = null;

/** Browser/webview entry point (lazy so DOMPurify only loads when needed). */
export async function renderMarkdownPreview(md: string): Promise<string> {
  if (!browserRenderer) {
    const { default: DOMPurify } = await import("dompurify");
    browserRenderer = createMarkdownPreview(DOMPurify as unknown as Purifier);
  }
  return browserRenderer(md);
}
