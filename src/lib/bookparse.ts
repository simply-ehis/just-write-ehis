/**
 * bookparse — plain-text extraction for book imports (EPUB / DOCX / PDF).
 * Dependency-free interface (no $lib imports) so the same module runs in
 * the app and in the node e2e harness. Parsed text is stored as the doc
 * body, so position sync, search, and export keep working unchanged.
 */
import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist";

export interface ParsedBook {
  title: string;
  author: string | null;
  text: string;
  /** EPUB cover art (capped size), for project dressing. Absent when none. */
  cover?: { b64: string; mime: string } | null;
}

/** Thrown when a PDF needs a password the caller didn't supply. */
export class PasswordNeededError extends Error {
  constructor(filename: string) {
    super(`"${filename}" is password-locked — enter its password to import.`);
    this.name = "PasswordNeededError";
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * Block HTML/XHTML to structured markdown-ish text (the Reader renders
 * stored bodies through markdownToHtmlFragment, so structure emitted
 * here survives as real headings/lists instead of flat paragraphs):
 * h1-h3 keep `#` depth, list items keep `- `, table cells keep ` | `,
 * and dropped images leave a captioned `![alt](dropped-image)` marker
 * (rendered as an explicit placeholder — never a silent gap).
 */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<img[^>]*>/gi, (tag) => {
      const alt = attr(tag, "alt")?.trim() || "image";
      return `\n\n![${alt.replace(/[\[\]]/g, "")}](dropped-image)\n\n`;
    })
    .replace(/<\/(h[1-6]|p|div|li|tr|blockquote|section|article)>/gi, "\n\n")
    .replace(/<(br|hr)[^>]*>/gi, "\n")
    .replace(/<h([1-3])[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<h[4-6][^>]*>/gi, "\n\n### ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<tr[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<(td|th)[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\|(\s*\n)/g, "$1")
    .trim();
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return m ? m[1] : null;
}

function resolveHref(baseDir: string, href: string): string {
  const clean = href.split("#")[0];
  if (!baseDir) return clean;
  const parts = baseDir.split("/");
  for (const seg of clean.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** EPUB = zip of XHTML spine items. No reader engine needed for text. */
export async function parseEpub(data: Uint8Array): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(data);
  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new Error("Not an EPUB: META-INF/container.xml missing.");
  const container = await containerFile.async("string");
  const rootTag = container.match(/<rootfile[\s/>][^>]*>/i)?.[0] ?? "";
  const opfPath = attr(rootTag, "full-path");
  if (!opfPath) throw new Error("Not an EPUB: no OPF rootfile.");
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error("Not an EPUB: OPF package missing.");
  const opf = await opfFile.async("string");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";

  const title =
    opf.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/i)?.[1]?.trim() || "Untitled";
  const author =
    opf.match(/<dc:creator[^>]*>([^<]*)<\/dc:creator>/i)?.[1]?.trim() || null;

  const idToHref = new Map<string, string>();
  const idToMime = new Map<string, string>();
  const idProps = new Map<string, string>();
  for (const m of opf.matchAll(/<item[\s/>][^>]*>/gi)) {
    const id = attr(m[0], "id");
    const href = attr(m[0], "href");
    if (id && href) {
      idToHref.set(id, resolveHref(base, href));
      const mt = attr(m[0], "media-type") ?? "";
      idToMime.set(id, mt);
      idProps.set(id, attr(m[0], "properties") ?? "");
    }
  }
  const spine: string[] = [];
  for (const m of opf.matchAll(/<itemref[\s/>][^>]*>/gi)) {
    const idref = attr(m[0], "idref");
    const href = idref ? idToHref.get(idref) : undefined;
    if (href) spine.push(href);
  }
  if (spine.length === 0) throw new Error("Not an EPUB: empty spine.");

  const parts: string[] = [];
  for (const href of spine) {
    const file = zip.file(href);
    if (!file) continue;
    const xhtml = await file.async("string");
    const body = xhtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? xhtml;
    const text = htmlToText(body);
    if (text) parts.push(text);
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("EPUB contains no readable text.");

  // Cover art: declared cover-image first, else an image id with "cover"
  // in the name. Capped — a 10MB plate must not ride into frontmatter.
  let cover: ParsedBook["cover"] = null;
  const coverId =
    [...idToHref.keys()].find((id) => (idProps.get(id) ?? "").split(/\s+/).includes("cover-image")) ??
    [...idToHref.keys()].find(
      (id) => id.toLowerCase().includes("cover") && (idToMime.get(id) ?? "").startsWith("image/")
    );
  if (coverId) {
    const href = idToHref.get(coverId);
    const file = href ? zip.file(href) : null;
    const mime = idToMime.get(coverId) ?? "image/jpeg";
    if (file) {
      try {
        const b64 = await file.async("base64");
        // ~1.5MB cap on the base64 payload.
        if (b64.length <= 2_000_000) cover = { b64, mime };
      } catch {
        /* art is dressing — a bad image never fails the import */
      }
    }
  }
  return { title: decodeEntities(title), author: author ? decodeEntities(author) : null, text, cover };
}

/**
 * DOCX straight from the OOXML (jszip only — mammoth pulls node-only
 * requires that break both bundlers). Headings keep `#` depth, list
 * items keep their bullets, everything else flows as paragraphs.
 */
export async function parseDocx(data: Uint8Array): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(data);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a DOCX: word/document.xml missing.");
  const xml = await docFile.async("string");
  const out: string[] = [];
  for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const p = m[0];
    const style = p.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] ?? "";
    const level = /^Heading([1-6])$/.exec(style)?.[1];
    const isBullet = /<w:numPr[\s>]/.test(p);
    const runs: string[] = [];
    for (const r of p.matchAll(/<w:r[\s>][\s\S]*?<\/w:r>/g)) {
      const run = r[0];
      if (/<w:br[\s/>]/.test(run)) {
        runs.push("\n");
        continue;
      }
      if (/<w:tab[\s/>]/.test(run)) runs.push("\t");
      for (const t of run.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) {
        runs.push(decodeEntities(t[1]));
      }
    }
    let line = runs.join("").replace(/[ \t]+/g, " ").trim();
    if (!line) continue;
    if (level) line = `${"#".repeat(Number(level))} ${line}`;
    else if (isBullet) line = `- ${line}`;
    out.push(line);
  }
  const text = out.join("\n\n").trim();
  if (!text) throw new Error("DOCX contains no readable text.");
  return { title: "Untitled", author: null, text };
}

/**
 * PDF text layer via pdf.js (page order, blank line between pages).
 * `workerSrc` wires the bundled worker in the app; node runs workerless.
 * `password` unlocks password-protected files — without it a locked file
 * throws PasswordNeededError (not a generic toast) so the caller can ask.
 */
export async function parsePdf(data: Uint8Array, workerSrc?: string, password?: string): Promise<ParsedBook> {
  if (workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  const copy = new Uint8Array(data);
  let pdf;
  try {
    pdf = await pdfjs.getDocument({
      data: copy,
      password: password ?? "",
      useWorkerFetch: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    if ((e as { name?: string })?.name === "PasswordException") {
      throw new PasswordNeededError("this PDF");
    }
    throw e;
  }
  let title = "Untitled";
  try {
    const meta = await pdf.getMetadata();
    const infoTitle = (meta?.info as Record<string, unknown> | undefined)?.Title;
    if (typeof infoTitle === "string" && infoTitle.trim()) title = infoTitle.trim();
  } catch {
    /* metadata is best-effort */
  }
  const pages: string[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let line = "";
    for (const item of content.items) {
      const str = (item as { str?: unknown }).str;
      if (typeof str !== "string") continue;
      line += str;
      if ((item as { hasEOL?: unknown }).hasEOL) line += "\n";
      else line += " ";
    }
    const text = line.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
    if (text) pages.push(text);
  }
  const destroyable = pdf as unknown as { destroy?: () => Promise<void> };
  if (typeof destroyable.destroy === "function") {
    // Cleanup best-effort (a failed destroy only leaks a worker), but never
    // silent. No $lib imports here by contract (node harness) — plain warn.
    await destroyable.destroy().catch((e) => console.warn("Reader PDF teardown:", e));
  }
  if (pages.length === 0) throw new Error("PDF contains no extractable text (scanned images need OCR).");
  return { title, author: null, text: pages.join("\n\n") };
}

/** Route a dropped file to the right parser by extension. */
export async function parseBookFile(
  filename: string,
  data: Uint8Array,
  workerSrc?: string,
  opts?: { password?: string }
): Promise<ParsedBook> {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const fallbackTitle = filename.replace(/\.[^.]+$/, "") || "Untitled";
  if (ext === "epub") {
    const book = await parseEpub(data);
    return { ...book, title: book.title === "Untitled" ? fallbackTitle : book.title };
  }
  if (ext === "docx") {
    const book = await parseDocx(data);
    return { ...book, title: fallbackTitle };
  }
  if (ext === "pdf") {
    const book = await parsePdf(data, workerSrc, opts?.password);
    return { ...book, title: book.title === "Untitled" ? fallbackTitle : book.title };
  }
  throw new Error(`.${ext || "?"} isn't a book format — import .epub, .pdf, .docx, .md, .txt, or .fountain.`);
}
