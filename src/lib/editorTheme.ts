/**
 * editorTheme — per-style×mode CodeMirror palettes, mirroring app.css.
 *
 * Canvas (CodeMirror) can't read CSS vars through its theme objects
 * reliably across all surfaces, so each style+mode combination gets an
 * explicit palette here: default paper/ink-well, brutalist hazard (dark
 * concrete + paper editions), glass abyssal-glow (dark frost + paper
 * frost). EditorPane and JustWriteWorkspace both build their editor
 * theme from editorPalette(), which keeps the two editors identical
 * per combination. Unknown styles fall back to default, modes to dark.
 */
import { EDITOR_FONT_VALUES } from "./settingsValidate";

export interface EditorPalette {
  bg: string;
  fg: string;
  muted: string;
  overlay: string;
  accent: string;
  /** Selection / search-match washes (accent at low alpha). */
  sel: string;
  selFocus: string;
  match: string;
  matchSel: string;
  /** Panel/input corner radius: 0 brutalist, swollen glass. */
  radius: string;
}

const PALETTES: Record<string, EditorPalette> = {
  light: {
    bg: "#F1EFE6", fg: "#2B2A25", muted: "#5F5C50", overlay: "#EBE7D9",
    accent: "#3F6656",
    sel: "#3F665630", selFocus: "#3F665640",
    match: "#3F665640", matchSel: "#3F665680",
    radius: "6px",
  },
  dark: {
    bg: "#100E0B", fg: "#ECE7D8", muted: "#9C9686", overlay: "#1C1815",
    accent: "#8FC7A9",
    sel: "#8FC7A930", selFocus: "#8FC7A940",
    match: "#8FC7A940", matchSel: "#8FC7A980",
    radius: "6px",
  },
  brutalist: {
    bg: "#100E0B", fg: "#ECE7D8", muted: "#9C9686", overlay: "#1C1815",
    accent: "#FFB000",
    sel: "#FFB00030", selFocus: "#FFB00040",
    match: "#FFB00040", matchSel: "#FFB00080",
    radius: "0",
  },
  "brutalist-light": {
    bg: "#F1EFE6", fg: "#2B2A25", muted: "#5F5C50", overlay: "#EBE7D9",
    accent: "#FFB000",
    sel: "#FFB00030", selFocus: "#FFB00040",
    match: "#FFB00040", matchSel: "#FFB00080",
    radius: "0",
  },
  glass: {
    bg: "rgba(10,10,10,0.55)", fg: "#ECE7D8", muted: "#9C9686",
    overlay: "rgba(255,255,255,0.07)", accent: "#A9E8C6",
    sel: "rgba(143,199,169,0.3)", selFocus: "rgba(143,199,169,0.35)",
    match: "rgba(143,199,169,0.3)", matchSel: "rgba(143,199,169,0.45)",
    radius: "14px",
  },
  "glass-light": {
    bg: "rgba(250,249,243,0.72)", fg: "#2B2A25", muted: "#5F5C50",
    overlay: "rgba(43,42,37,0.07)", accent: "#1F7A52",
    sel: "rgba(31,122,82,0.18)", selFocus: "rgba(31,122,82,0.25)",
    match: "rgba(31,122,82,0.18)", matchSel: "rgba(31,122,82,0.3)",
    radius: "14px",
  },
};

export function editorPalette(style: string, mode = "dark"): EditorPalette {
  if (style === "brutalist" || style === "glass") {
    return PALETTES[mode === "light" ? `${style}-light` : style] ?? PALETTES.dark;
  }
  return PALETTES[mode === "light" ? "light" : "dark"];
}

/** Autocorrect suggestion underline — theme warning via CSS var. */
export const AUTOCORRECT_WAVY = "underline wavy var(--warning) 1px";

export const EDITOR_FONTS = EDITOR_FONT_VALUES;

export type EditorFont = (typeof EDITOR_FONTS)[number];

/**
 * Families fetched on demand (everything else is eager in main.ts or a
 * system font). The CSS var already names the family, so text paints the
 * fallback stack first and swaps in via font-display: swap once the chunk
 * arrives. Safe to call on every typography apply; failures re-try next
 * time instead of sticking the family as "loaded".
 */
const loadedEditorFonts = new Set<string>(["JetBrains Mono"]);

export const LAZY_FONT_LOADERS: Record<string, () => Promise<unknown>> = {
  "Fira Code": () =>
    Promise.all([import("@fontsource/fira-code/400.css"), import("@fontsource/fira-code/700.css")]),
  "Source Code Pro": () =>
    Promise.all([import("@fontsource/source-code-pro/400.css"), import("@fontsource/source-code-pro/700.css")]),
  "IBM Plex Mono": () =>
    Promise.all([import("@fontsource/ibm-plex-mono/400.css"), import("@fontsource/ibm-plex-mono/700.css")]),
};

export function ensureEditorFont(family: string): void {
  if (loadedEditorFonts.has(family)) return;
  const load = LAZY_FONT_LOADERS[family];
  if (!load) return;
  loadedEditorFonts.add(family);
  void load().catch(() => {
    loadedEditorFonts.delete(family);
  });
}

let brutalistFontsLoaded = false;

/**
 * Brutalist display type for runtime theme switches (first paint is
 * covered by main.ts when the stored theme is Brutalist). Same literals
 * as main.ts — dynamic import specifiers must stay literal for bundling.
 */
export function ensureBrutalistFonts(): void {
  if (brutalistFontsLoaded) return;
  brutalistFontsLoaded = true;
  void Promise.all([
    import("@fontsource/archivo-black/400.css"),
    import("@fontsource/space-mono/400.css"),
    import("@fontsource/space-mono/700.css"),
  ]).catch(() => {
    brutalistFontsLoaded = false;
  });
}

export function editorFontStack(font: string): string {
  // Keep a distinct fallback tail for each bundled family so a missing font
  // asset does not make every editor choice render identically.
  const selected = EDITOR_FONTS.includes(font as EditorFont)
    ? (font as EditorFont)
    : "JetBrains Mono";
  switch (selected) {
    case "JetBrains Mono":
      return `"JetBrains Mono", "Cascadia Code", Consolas, monospace`;
    case "Fira Code":
      return `"Fira Code", Consolas, "Courier New", monospace`;
    case "Source Code Pro":
      return `"Source Code Pro", "Lucida Console", Consolas, monospace`;
    case "IBM Plex Mono":
      return `"IBM Plex Mono", "Courier New", Consolas, monospace`;
    case "Cascadia Code":
      return `"Cascadia Code", Consolas, monospace`;
    case "Consolas":
      return `Consolas, "Cascadia Code", monospace`;
    case "monospace":
      return `ui-monospace, Consolas, monospace`;
  }
}
