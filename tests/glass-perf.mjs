/**
 * glass-perf — guards the glass theme against a compositor cliff that
 * actually froze the window.
 *
 * Incident: an upgrade raised the blur to 24px, added `saturate(180%)` to
 * every frosted layer, and added backdrop-filter to `.breadcrumb-bar` and
 * `.sidebar-footer` — which sit directly beside layers that already had
 * one. Stacked/oversized backdrop layers starved the WebView compositor:
 * the main thread stalled, the Novel Studio chunk's dynamic import never
 * settled, LazyWorkspace timed out at 9s ("Couldn't load this view") and
 * Windows showed "not responding".
 *
 * These are cheap, static invariants — the properties that keep the layer
 * count bounded. Not a benchmark; a ratchet.
 *
 * Run: node tests/glass-perf.mjs (no build needed)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/app.css"), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Every `selector { ... }` block in the file. */
function blocks() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}
const all = blocks();
const hasBlur = (b) => /backdrop-filter\s*:/.test(b.body);

// 1. Inputs must never blur: they need text contrast, not frost, and
//    every blurred control is its own re-composited layer.
const inputBlocks = all.filter((b) => /^(\[data-theme="glass"\]\s+)?(input|textarea|select)\b/.test(b.selector));
check("glass input rules exist to guard", inputBlocks.length > 0, `${inputBlocks.length} found`);
const blurredInputs = inputBlocks.filter(hasBlur);
check("inputs/textareas/selects never blur", blurredInputs.length === 0,
  blurredInputs.map((b) => b.selector).join(" | "));

// 2. No layer may sit flush against another layer over the same pixels.
const stacked = [".breadcrumb-bar", ".sidebar-footer"];
for (const sel of stacked) {
  const b = all.find((x) => x.selector.endsWith(sel) && hasBlur(x));
  check(`${sel} does not stack a backdrop layer`, !b, b ? b.selector : "");
}

// 3. The saturate() colour op doubled per-layer cost; it is gone.
check("no saturate(180%) colour op", !/saturate\(180%\)/.test(css));

// 4. Keep the blur budget modest and the layer count bounded.
//    Chrome surfaces cap at 16px. A modal overlay is allowed 20px: it is
//    transient, at most one at a time, and that is the original design.
const MODAL = /(palette|modal|qc-panel|version-panel)/;
const heavy = all.filter((b) => {
  const m = b.body.match(/backdrop-filter:\s*blur\((\d+)px\)/);
  return m && Number(m[1]) > 16 && !MODAL.test(b.selector);
});
check("only modals may blur past 16px", heavy.length === 0,
  heavy.map((b) => `${b.selector} -> ${b.body.match(/blur\((\d+)px\)/)[1]}px`).join(" | "));

const blurPx = [...css.matchAll(/backdrop-filter:\s*blur\((\d+)px\)/g)].map((m) => Number(m[1]));
const maxBlur = Math.max(0, ...blurPx);
check("blur budget stays modest", maxBlur <= 20, `max=${maxBlur}px`);
const layers = all.filter(hasBlur).length;
check("backdrop layers stay bounded", layers <= 10, `${layers} layers`);

// 5. The glass blur token itself must stay cheap.
const token = css.match(/--glass-blur:\s*(\d+)px/);
check("--glass-blur <= 16px", token && Number(token[1]) <= 16, token ? `${token[1]}px` : "missing");

// 6. Large viewports get proportionally bigger layouts; nothing here may
//    reintroduce a filter on the page background itself.
check("body background is not filtered",
  !/body\s*\{[^}]*backdrop-filter/.test(css));

console.log(failures === 0 ? "\nglass-perf: all checks passed." : `\nglass-perf: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
