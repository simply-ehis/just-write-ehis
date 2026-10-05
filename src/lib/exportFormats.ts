/**
 * exportFormats — one definition of the six export/compile formats.
 *
 * Previously copy-pasted across EditorPane, ScriptWorkspace, NovelWorkspace
 * and CommandPalette under four different names (ALL_/BULK_/COMPILE_) —
 * adding a format needed four synchronized edits. Import from here; keep
 * each surface's own gating/message logic where it is.
 */

/** Every export/compile format, in menu order. */
export const ALL_EXPORT_FORMATS = ["md", "txt", "html", "docx", "epub", "pdf"];

/**
 * Formats that need a bundled binary. Only pdf qualifies now: docx and epub
 * are written in-process by Rust (src-tauri/src/docx.rs, epub.rs), and
 * md/txt/html never needed a binary. pdf goes through the pinned Typst CLI
 * (Tauri externalBin), so it is gated when that binary is missing.
 */
export const BINARY_FORMATS: ReadonlySet<string> = new Set(["pdf"]);

/** @deprecated use BINARY_FORMATS. Retained so old imports keep working. */
export const PANDOC_FORMATS = BINARY_FORMATS;

/** True when `format` needs a bundled binary to produce. */
export function needsBinary(format: string): boolean {
  return BINARY_FORMATS.has(format);
}

export function exportLabel(format: string): string {
  switch (format) {
    case "md": return "Markdown (.md)";
    case "txt": return "Plain Text (.txt)";
    case "html": return "HTML (.html)";
    case "docx": return "Word (.docx)";
    case "epub": return "eBook (.epub)";
    case "pdf": return "PDF (.pdf)";
    default: return format;
  }
}
