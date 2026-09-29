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

/** Formats that need the pandoc sidecar (the rest are backend-native). */
export const PANDOC_FORMATS: ReadonlySet<string> = new Set(["docx", "epub", "pdf"]);

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
