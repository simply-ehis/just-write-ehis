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
  text: string;
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

/** Block HTML/XHTML to readable text, keeping headings on their own lines. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\/(h[1-6]|p|div|li|tr|blockquote|section|article)>/gi, "\n\n")
    .replace(/<(br|hr|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(withBreaks)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
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

  const idToHref = new Map<string, string>();
  for (const m of opf.matchAll(/<item[\s/>][^>]*>/gi)) {
    const id = attr(m[0], "id");
    const href = attr(m[0], "href");
    if (id && href) idToHref.set(id, resolveHref(base, href));
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
  return { title: decodeEntities(title), text };
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
  return { title: "Untitled", text };
}

/**
 * PDF text layer via pdf.js (page order, blank line between pages).
 * `workerSrc` wires the bundled worker in the app; node runs workerless.
 */
export async function parsePdf(data: Uint8Array, workerSrc?: string): Promise<ParsedBook> {
  if (workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  }
  const copy = new Uint8Array(data);
  const pdf = await pdfjs.getDocument({
    data: copy,
    useWorkerFetch: false,
    verbosity: 0,
  }).promise;
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
    await destroyable.destroy().catch(() => {});
  }
  if (pages.length === 0) throw new Error("PDF contains no extractable text (scanned images need OCR).");
  return { title, text: pages.join("\n\n") };
}

/** Route a dropped file to the right parser by extension. */
export async function parseBookFile(
  filename: string,
  data: Uint8Array,
  workerSrc?: string
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
    const book = await parsePdf(data, workerSrc);
    return { ...book, title: book.title === "Untitled" ? fallbackTitle : book.title };
  }
  throw new Error(`.${ext || "?"} isn't a book format — import .epub, .pdf, .docx, .md, .txt, or .fountain.`);
}
