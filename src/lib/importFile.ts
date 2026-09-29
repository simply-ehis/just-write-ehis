/**
 * importFile — the single entry point for bringing outside text in.
 *
 * Novel, Reader, and Script each had their own copy of the same dispatch
 * (NUL-check + extension switch + error strings + pdf.js worker wiring).
 * They all call readImportFile() now; workspace-specific shaping
 * (chapters, shelves, fountain docs) stays with the caller.
 */
import { parseBookFile, PasswordNeededError, type ParsedBook } from "$lib/bookparse";

export const TEXT_EXTS = ["md", "txt", "fountain"] as const;
export const BOOK_EXTS = ["epub", "pdf", "docx"] as const;
export const IMPORTABLE_EXTS = [...TEXT_EXTS, ...BOOK_EXTS] as const;

/** True for book/container files the book parser handles. */
export function isBookFile(name: string): boolean {
  const lower = (name || "").toLowerCase();
  return (BOOK_EXTS as readonly string[]).some((ext) => lower.endsWith(`.${ext}`));
}

/** File-picker accept for book+text imports (one order everywhere). */
export const BOOK_ACCEPT = ".fountain,.md,.txt,.epub,.pdf,.docx";

export interface ImportResult {
  title: string;
  text: string;
  /** Original extension (lowercased, no dot). */
  ext: string;
  /** Set when the bytes weren't UTF-8 and fell back to Windows-1252. */
  encodingNote: string | null;
  /** EPUB metadata. Absent for other formats. */
  author: string | null;
  cover: ParsedBook["cover"];
}

async function pdfWorkerSrc(): Promise<string | undefined> {
  try {
    return (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  } catch {
    return undefined;
  }
}

/** Strip BOM; decode strict UTF-8, fall back to Windows-1252 (legacy exports). */
export function decodeTextFile(data: Uint8Array): { text: string; encodingNote: string | null } {
  let bytes = data;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.slice(3);
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encodingNote: null };
  } catch {
    return {
      text: new TextDecoder("windows-1252").decode(bytes),
      encodingNote: "Not UTF-8 — read as Windows-1252; check accented characters.",
    };
  }
}

/**
 * Read one dropped/picked file. Throws Error with a user-facing message.
 * Locked PDFs trigger `askPassword` (defaults to window.prompt) and retry.
 */
export async function readImportFile(
  file: File,
  opts?: { askPassword?: (filename: string) => string | null }
): Promise<ImportResult> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const fallbackTitle = file.name.replace(/\.[^.]+$/, "") || "Untitled";
  if (!ext || !(IMPORTABLE_EXTS as readonly string[]).includes(ext)) {
    throw new Error(`.${ext || "?"} isn't importable — use .epub, .pdf, .docx, .md, .txt, or .fountain.`);
  }

  if ((TEXT_EXTS as readonly string[]).includes(ext)) {
    const { text, encodingNote } = decodeTextFile(new Uint8Array(await file.arrayBuffer()));
    if (text.includes("\0")) {
      throw new Error("That file looks binary, not text — import refused.");
    }
    if (!text.trim()) throw new Error("That file is empty.");
    return { title: fallbackTitle, text, ext, encodingNote, author: null, cover: null };
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const worker = ext === "pdf" ? await pdfWorkerSrc() : undefined;
  try {
    const book = await parseBookFile(file.name, data, worker);
    if (!book.text.trim()) throw new Error("No text could be extracted.");
    return {
      title: book.title || fallbackTitle,
      text: book.text,
      ext,
      encodingNote: null,
      author: book.author,
      cover: book.cover ?? null,
    };
  } catch (e) {
    if (e instanceof PasswordNeededError) {
      const ask = opts?.askPassword ?? ((name) => window.prompt(`Password for "${name}":`));
      const password = ask(file.name);
      if (password == null) throw new Error("Import cancelled — the PDF stayed locked.");
      const book = await parseBookFile(file.name, data, worker, { password });
      if (!book.text.trim()) throw new Error("No text could be extracted.");
      return {
        title: book.title || fallbackTitle,
        text: book.text,
        ext,
        encodingNote: null,
        author: book.author,
        cover: book.cover ?? null,
      };
    }
    throw e;
  }
}

/** Short content hash for duplicate-import detection (djb2 — identity hint, not security). */
export function contentHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
