/**
 * theme-sweep — theme correctness across dark, light, brutalist, glass
 * (the full data-theme set Ehis signed off: keep all 4).
 *
 * Phase A (mount): boot the built app once per theme and assert the
 *   shell mounts with zero console errors (per-theme JS robustness).
 * Phase B (tokens): parse src/app.css and assert every theme block
 *   defines the full token contract (surfaces, text, accents, semantics,
 *   all 12 workspace hues) with no empty values.
 * Phase C (distinctness): brutalist and glass must differ from dark in
 *   bg AND accent — no more byte-identical personalities.
 * Phase D (contrast): WCAG contrast of text-primary on bg and
 *   accent-ink on accent must be >= 4.5:1 in every theme, computed
 *   from the tokens — fails loudly (this is what catches white-on-mint
 *   style bypasses without needing eyes on a screen).
 * Phase E (editor parity): the CodeMirror palettes in
 *   src/lib/editorTheme.ts are per-theme distinct and match app.css.
 *
 * Visual polish (glow, blur, rhythm) still needs eyes on a real
 * webview — this proves tokens, contrast, and crash-freedom.
 *
 * Run: npm run build && node tests/theme-sweep.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = [
  "window", "Window", "document", "navigator", "localStorage", "sessionStorage",
  "HTMLElement", "Element", "Node", "Text", "Comment", "Document",
  "DocumentFragment", "DocumentType", "NodeList", "HTMLCollection",
  "Range", "Selection", "NodeFilter", "HTMLMediaElement", "HTMLAudioElement",
  "HTMLVideoElement", "HTMLImageElement", "Image", "Audio", "SVGElement",
  "SVGSVGElement", "SVGGraphicsElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLDivElement",
  "HTMLSpanElement", "HTMLCanvasElement", "Event", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "WheelEvent", "DragEvent", "ClipboardEvent",
  "FocusEvent", "InputEvent", "MutationObserver", "MutationRecord",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "DOMParser", "XMLSerializer", "DOMTokenList",
];

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── CSS parsing ─────────────────────────────────────────────────────
const css = await readFile(join(root, "src/app.css"), "utf8");

/** Extract flat `selector { --a: b; }` declarations for a block opener. */
function blockAfter(opener) {
  const start = css.indexOf(opener);
  if (start === -1) return null;
  const brace = css.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(brace + 1, i);
    }
  }
  return null;
}

function parseVars(block) {
  const vars = {};
  if (!block) return vars;
  for (const m of block.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

const THEMES = ["dark", "light", "brutalist", "glass"];
const themeVars = {};
for (const t of THEMES) {
  const opener = t === "light" ? ':root, :root[data-theme="light"]' : `:root[data-theme="${t}"]`;
  themeVars[t] = parseVars(blockAfter(opener));
  check(`[${t}] token block parsed`, Object.keys(themeVars[t]).length > 20, `${Object.keys(themeVars[t]).length} vars`);
}

/** Resolve var(--x) chains within one theme's map. */
function resolve(vars, value, depth = 0) {
  if (depth > 6 || !value) return value;
  const m = value.match(/^var\((--[a-zA-Z0-9-]+)\)$/);
  if (!m) return value;
  return resolve(vars, vars[m[1]], depth + 1);
}

// ── Phase B: token contract ─────────────────────────────────────────
const WS_IDS = ["logs", "write", "map", "canvas", "novel", "script", "projects", "reader", "home", "inbox", "files", "properties"];
const REQUIRED = [
  "--bg", "--surface", "--surface-2", "--surface-elevated",
  "--ink", "--ink-muted", "--border",
  "--accent", "--accent-soft", "--accent-ink", "--accent-on",
  "--text-primary", "--text-on-accent",
  "--accent-semantic-green", "--accent-semantic-purple",
  "--accent-semantic-red", "--accent-semantic-yellow",
  "--success", "--warning", "--error",
  ...WS_IDS.map((id) => `--ws-${id}`),
];
for (const t of THEMES) {
  const missing = REQUIRED.filter((k) => {
    const v = resolve(themeVars[t], themeVars[t][k]);
    return !v || v === "";
  });
  check(`[${t}] full token contract`, missing.length === 0, missing.join(", "));
}

// System fallback (pre-settings paint) carries the once-missing hues too.
const fallbackVars = parseVars(blockAfter(":root:not("));
for (const k of ["--ws-inbox", "--ws-files", "--ws-properties", "--surface-elevated", "--accent-on"]) {
  check(`[fallback] defines ${k}`, !!resolve(fallbackVars, fallbackVars[k]));
}

// ── Phase C: distinct personalities ─────────────────────────────────
check("brutalist bg differs from dark", themeVars.brutalist["--bg"] !== themeVars.dark["--bg"], `${themeVars.brutalist["--bg"]} vs ${themeVars.dark["--bg"]}`);
check("brutalist accent differs from dark", themeVars.brutalist["--accent"] !== themeVars.dark["--accent"], `${themeVars.brutalist["--accent"]} vs ${themeVars.dark["--accent"]}`);
check("glass accent differs from dark", themeVars.glass["--accent"] !== themeVars.dark["--accent"], `${themeVars.glass["--accent"]} vs ${themeVars.dark["--accent"]}`);
check("glass surfaces translucent", (themeVars.glass["--surface"] || "").includes("rgba"), themeVars.glass["--surface"]);
check("brutalist radius collapses", themeVars.brutalist["--radius-md"] === "0", themeVars.brutalist["--radius-md"]);

// ── Phase D: contrast (WCAG, fails loudly) ──────────────────────────
function lum(hex) {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const isHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v || "");
for (const t of THEMES) {
  const v = themeVars[t];
  const text = resolve(v, v["--text-primary"]);
  const bg = resolve(v, v["--bg"]);
  const onAccent = resolve(v, v["--text-on-accent"]);
  const accent = resolve(v, v["--accent"]);
  if (![text, bg, onAccent, accent].every(isHex)) {
    check(`[${t}] contrast pairs are hex-computable`, false, [text, bg, onAccent, accent].join(" "));
    continue;
  }
  const r1 = ratio(text, bg);
  const r2 = ratio(onAccent, accent);
  check(`[${t}] text on bg >= 4.5:1`, r1 >= 4.5, `${r1.toFixed(2)}:1`);
  check(`[${t}] on-accent on accent >= 4.5:1`, r2 >= 4.5, `${r2.toFixed(2)}:1`);
}

// ── Phase E: editor palette parity ──────────────────────────────────
const { editorPalette } = await import(pathToFileURL(join(root, "src/lib/editorTheme.ts")).href);
for (const t of THEMES) {
  const p = editorPalette(t);
  const cssBg = resolve(themeVars[t], themeVars[t]["--bg"]);
  const cssAccent = resolve(themeVars[t], themeVars[t]["--accent"]);
  // Glass editor is intentionally translucent over the same base hue.
  const bgOk = t === "glass" ? p.bg.includes("10,10,10") : p.bg.toLowerCase() === cssBg.toLowerCase();
  check(`[${t}] editor bg tracks theme`, bgOk, p.bg);
  check(`[${t}] editor accent tracks theme`, p.accent.toLowerCase() === cssAccent.toLowerCase(), p.accent);
}
check("unknown theme falls back to dark", editorPalette("nope").bg === editorPalette("dark").bg);

// ── Phase A: mount per theme ────────────────────────────────────────
const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
const bundleUrl = pathToFileURL(join(root, "dist/assets", jsName)).href;

for (const theme of THEMES) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  delete globalThis.CustomEvent;
  delete globalThis.Event;
  for (const key of KEYS) {
    if (!(key in dom.window)) continue;
    try {
      globalThis[key] = dom.window[key];
    } catch {
      try {
        Object.defineProperty(globalThis, key, {
          value: dom.window[key], writable: true, configurable: true,
        });
      } catch { /* keep Node's */ }
    }
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  if (dom.window.Range) {
    if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
    if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  }
  if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;

  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ theme }));
  const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 200));

  await import(`${bundleUrl}?theme=${theme}`);
  await new Promise((r) => setTimeout(r, 2500));

  const html = dom.window.document.getElementById("app")?.innerHTML ?? "";
  check(`[${theme}] shell mounts`, html.includes("app-shell"));
  check(`[${theme}] nav renders`, html.includes("workspace-nav"));
  check(`[${theme}] no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  console.error = (..._) => {};
}

// ── Phase F: per-workspace boot loop (dark theme) ─────────────────────
// Eager workspaces (Write, Home, Logs) must render real content under every
// theme's tokens. Lazy ones (Novel, Script, Map, Reader, Projects, Library,
// Settings) can't resolve their chunks under jsdom (injected stylesheet
// <link> never fires load — see tests/lazy-load-probe.mjs), so each must
// reach either real content or the retryable lazy-failed state within the
// 9s loadWithTimeout — never bare "Loading…" forever.
{
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  delete globalThis.CustomEvent;
  delete globalThis.Event;
  for (const key of KEYS) {
    if (!(key in dom.window)) continue;
    try {
      globalThis[key] = dom.window[key];
    } catch {
      try {
        Object.defineProperty(globalThis, key, {
          value: dom.window[key], writable: true, configurable: true,
        });
      } catch { /* keep Node's */ }
    }
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  if (dom.window.Range) {
    if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
    if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  }
  if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ theme: "dark" }));
  const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 200));

  await import(`${bundleUrl}?boot=workspace-loop`);
  await new Promise((r) => setTimeout(r, 2500));

  const qa = (s) => [...dom.window.document.querySelectorAll(s)];
  const appHtml = () => dom.window.document.getElementById("app")?.innerHTML ?? "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const label of ["Write", "Home", "Logs"]) {
    const btn = qa(".workspace-nav .nav-item").find((b) => (b.getAttribute("aria-label") || "").trim() === label);
    check(`[workspaces] nav has "${label}"`, !!btn);
    btn?.click();
    await sleep(800);
    check(`[workspaces] "${label}" renders content (no lazy shell)`, !appHtml().includes("lazy-state"));
  }
  for (const label of ["Novel", "Script", "Map", "Reader", "Projects", "Library", "Settings"]) {
    const btn = qa(".workspace-nav .nav-item").find((b) => (b.getAttribute("aria-label") || "").trim() === label);
    check(`[workspaces] nav has "${label}"`, !!btn);
    btn?.click();
    await sleep(11000);
    const html = appHtml();
    const settled = !html.includes("lazy-state") || html.includes("lazy-failed");
    check(`[workspaces] "${label}" settles (content or retryable failure)`, settled);
    if (html.includes("lazy-failed")) {
      check(`[workspaces] "${label}" failure offers retry`, html.includes("lazy-retry"));
    }
  }
  console.error = (..._) => {};
}

console.log(failures === 0 ? "THEME-SWEEP ALL PASS" : `THEME-SWEEP ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
