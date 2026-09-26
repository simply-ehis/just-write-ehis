/**
 * appearance — style × mode × accent applicator (single source of truth).
 *
 * - `theme`: visual style — "default" room, "brutalist" concrete, "glass" frost.
 * - `themeMode`: light or dark base under ANY style.
 * - `accentOverride`: custom #rrggbb accent, or "" for the style default.
 *
 * Called from the App/WidgetApp theme effects and the index.html first-paint
 * path. Accent math (luminance + shading) lives here so every surface agrees
 * on text-on-accent.
 */

import { editorFontStack } from "./editorTheme";

export type ThemeStyle = "default" | "brutalist" | "glass";
export type ThemeMode = "dark" | "light";

export function applyEditorTypography(font: string, size: number, lineHeight: number): void {
  const safeSize = Number.isFinite(size) ? Math.min(32, Math.max(10, size)) : 15;
  const safeLineHeight = Number.isFinite(lineHeight)
    ? Math.min(3, Math.max(1, lineHeight))
    : 1.7;
  const style = document.documentElement.style;
  style.setProperty("--editor-font-family", editorFontStack(font));
  style.setProperty("--editor-font-size", `${safeSize}px`);
  style.setProperty("--editor-line-height", String(safeLineHeight));
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Black or white text over the accent — whichever reads (WCAG-ish). */
export function bestOnAccent(hex: string): "#000000" | "#FFFFFF" {
  return luminance(hex) > 0.35 ? "#000000" : "#FFFFFF";
}

/** Darken a #rrggbb hex by mixing toward black. */
export function shade(hex: string, amount: number): string {
  const n = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount));
  const h = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${h(n(1))}${h(n(3))}${h(n(5))}`;
}

export function isAccentHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** The style's built-in accent per mode (color input fallback + reset target). */
const STYLE_ACCENTS: Record<string, { dark: string; light: string }> = {
  default: { dark: "#8FC7A9", light: "#3F6656" },
  brutalist: { dark: "#FFB000", light: "#FFB000" },
  glass: { dark: "#A9E8C6", light: "#1F7A52" },
};

export function defaultAccentFor(style: string, mode: string): string {
  const entry = STYLE_ACCENTS[style] ?? STYLE_ACCENTS.default;
  return mode === "light" ? entry.light : entry.dark;
}

export interface AccentPreset {
  name: string;
  hex: string;
}

/** Built-in accent shelf: pine green, cobalt blue, slate grey, rose pink,
 * plus amber, violet, teal, and rust. Every preset is safe in both modes —
 * text-on-accent is computed per pick, not per preset. */
export const ACCENT_PRESETS: AccentPreset[] = [
  { name: "Pine", hex: "#3F9E63" },
  { name: "Cobalt", hex: "#2F6FED" },
  { name: "Slate", hex: "#6B7280" },
  { name: "Rose", hex: "#E35A8A" },
  { name: "Amber", hex: "#E69E00" },
  { name: "Violet", hex: "#8A63D2" },
  { name: "Teal", hex: "#1F9E8E" },
  { name: "Rust", hex: "#C4502E" },
];

/** Apply style + mode datasets and the accent override to <html>. */
export function applyAppearance(style: string, mode: string, accentOverride: string): void {
  const root = document.documentElement;
  const safeStyle: ThemeStyle =
    style === "brutalist" || style === "glass" ? style : "default";
  const safeMode: ThemeMode = mode === "light" ? "light" : "dark";
  root.dataset.theme = safeStyle;
  root.dataset.mode = safeMode;
  const el = root.style;
  if (isAccentHex(accentOverride)) {
    const hex = accentOverride.toLowerCase();
    el.setProperty("--accent", hex);
    el.setProperty("--accent-primary", hex);
    el.setProperty("--accent-write", hex);
    el.setProperty("--accent-green", hex);
    el.setProperty("--accent-hover", shade(hex, 0.15));
    el.setProperty("--accent-soft", `color-mix(in srgb, ${hex} 14%, transparent)`);
    el.setProperty("--accent-active", `color-mix(in srgb, ${hex} 20%, transparent)`);
    el.setProperty("--text-on-accent", bestOnAccent(hex));
    el.setProperty("--accent-on", bestOnAccent(hex));
    el.setProperty("--accent-ink", bestOnAccent(hex));
  } else {
    for (const k of [
      "--accent", "--accent-primary", "--accent-write", "--accent-green",
      "--accent-hover", "--accent-soft", "--accent-active",
      "--text-on-accent", "--accent-on", "--accent-ink",
    ]) {
      el.removeProperty(k);
    }
  }
}
