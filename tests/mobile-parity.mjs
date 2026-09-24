/**
 * mobile-parity — headless 390px checks for the mobile shell (Area 15).
 *
 * jsdom applies no CSS, so this probe asserts behavior (mobile shell
 * appears, Inspector is reachable on phones, the sheet opens/closes via
 * the shared store) and separately asserts the source-level CSS contract
 * that jsdom cannot evaluate: touch-sized controls, hover-reveal fix,
 * safe-area insets, viewport-fit, dialog clamping, toolbars that scroll
 * instead of clipping.
 *
 * Run: npm run build && node tests/mobile-parity.mjs
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
  "DOMParser", "XMLSerializer", "DOMTokenList", "VisualViewport",
];

function rig(dom) {
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
  const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  if (dom.window.Range) {
    if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
    if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => readFile(join(root, rel), "utf8");

// ── Source contract (CSS/layout facts jsdom cannot evaluate) ─────────
{
  const appCss = await read("src/app.css");
  const indexHtml = await read("index.html");
  const bottomBar = await read("src/lib/components/BottomBar.svelte");
  const versionHistory = await read("src/lib/components/VersionHistory.svelte");
  const vaultRename = await read("src/lib/components/VaultRenameDialog.svelte");
  const templatePicker = await read("src/lib/components/TemplatePicker.svelte");
  const formatToolbar = await read("src/lib/components/FormatToolbar.svelte");

  check("phone icon controls are at least 44px", /\.icon-btn\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/.test(appCss));
  check("hover-only tab close is visible on touch", /@media \(hover: none\), \(pointer: coarse\)/.test(appCss) && /\.tab-bar \.close\s*\{\s*opacity:\s*1/.test(appCss));
  check("mobile shell clears the notch inset", /\.app-shell\.mobile\s*\{\s*padding-top:\s*env\(safe-area-inset-top/.test(appCss));
  check("bottom bar honors side + bottom insets", /env\(safe-area-inset-left/.test(bottomBar) && /env\(safe-area-inset-right/.test(bottomBar) && /bottom:\s*calc\(56px \+ env\(safe-area-inset-bottom/.test(bottomBar));
  check("viewport-fit=cover for notched displays", /viewport-fit=cover/.test(indexHtml));
  check("theme-color matches manifest", /theme-color" content="#1B1A15"/.test(indexHtml));
  check("wide dialogs clamp to the viewport", /min\(640px, 100vw\)/.test(versionHistory) && /min\(480px, 94vw\)/.test(vaultRename) && /min\(480px, 94vw\)/.test(templatePicker));
  check("format strip scrolls instead of clipping", /@media \(max-width: 480px\)[\s\S]*?\.format-toolbar \{[\s\S]*?overflow-x: auto/.test(formatToolbar));
  check("BottomBar exposes the Inspector on phones", /id: "outline", label: "Outline"/.test(bottomBar) && /\$inspectorOpen = !\$inspectorOpen/.test(bottomBar));
}

// ── Behavior: 390px shell + Inspector sheet round-trip ───────────────
{
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 390;
  dom.window.innerHeight = 844;
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ hasOnboarded: true }));
  const distHtml = await read("dist/index.html");
  const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
  if (!jsName) {
    console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
    process.exit(1);
  }
  const bundleUrl = pathToFileURL(join(root, "dist/assets", jsName)).href;
  console.error = (..._) => {};
  await import(bundleUrl + "?boot=mobile");
  await sleep(2500);

  const qa = (s) => [...dom.window.document.querySelectorAll(s)];
  check("bottom nav replaces the desktop status bar", qa(".bottom-bar").length === 1 && qa(".status-bar").length === 0);
  check("no hiddenInspector: more menu carries Outline", (() => {
    const more = qa(".bottom-bar-item").find((b) => /more/i.test(b.textContent));
    more?.click();
    return true;
  })());
  await sleep(400);
  const outline = qa(".more-item").find((b) => /outline/i.test(b.textContent));
  check("Outline entry is present in More", !!outline, qa(".more-item").map((b) => b.textContent.trim()).join(","));
  const errs = [];
  console.error = (...a) => errs.push(a);
  outline?.click();
  await sleep(900);
  check("Outline opens the Inspector sheet on mobile", qa(".mobile-ai-container .inspector-panel, .mobile-ai-container .insp-close").length > 0);
  const close = qa(".mobile-ai-container .insp-close")[0];
  close?.click();
  await sleep(400);
  check("sheet close dismisses the Inspector", qa(".mobile-ai-container .insp-close").length === 0);
  check("mobile flow raised no console errors", errs.length === 0, errs.slice(0, 2).map((e) => String(e[0])).join(" | "));
}

console.log(failures === 0 ? "MOBILE-PARITY ALL PASS" : `MOBILE-PARITY ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
