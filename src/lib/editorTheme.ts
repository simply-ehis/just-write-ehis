/**
 * editorTheme — per-theme CodeMirror palettes, mirroring app.css.
 *
 * Canvas (CodeMirror) can't read CSS vars through its theme objects
 * reliably across all surfaces, so each app theme gets an explicit
 * palette here: paper (light), ink-well (dark), hazard (brutalist),
 * abyssal-glow (glass). EditorPane and JustWriteWorkspace both build
 * their makeDarkTheme() from editorPalette(), which keeps the two
 * editors identical per theme. Unknown themes fall back to dark.
 */
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
    bg: "#1B1A15", fg: "#ECE7D8", muted: "#9C9686", overlay: "#2A2721",
    accent: "#8FC7A9",
    sel: "#8FC7A930", selFocus: "#8FC7A940",
    match: "#8FC7A940", matchSel: "#8FC7A980",
    radius: "6px",
  },
  brutalist: {
    bg: "#100F0D", fg: "#F4F1E6", muted: "#A8A294", overlay: "#1E1C19",
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
};

export function editorPalette(theme: string): EditorPalette {
  return PALETTES[theme] ?? PALETTES.dark;
}

/** Autocorrect suggestion underline — theme warning via CSS var. */
export const AUTOCORRECT_WAVY = "underline wavy var(--warning) 1px";
