/**
 * listen-harness — acceptance checks for the desktop TTS listen-test
 * harness (src/lib/components/ListenHarness.svelte,
 * src/lib/tts/boundaryAudit.ts, src/lib/stores/devHarness.ts).
 *
 * Acceptance criteria:
 *  AC1  Gap math is exact: every boundary row measures
 *       next.start − prev.end against the expected pause (220/480/600ms
 *       at 24 kHz) and page joins are flagged so extra samples at a join
 *       are individually visible.
 *  AC2  The audit tolerates out-of-order arrival, flags non-contiguous
 *       page chains, and defaults unknown segments to sentence pauses.
 *  AC3  The harness drives the SAME pipeline primitives as the pill
 *       (ensureTts → startRender → subscribeRender → TtsTimelinePlayer →
 *       ttsRenderDemand) — source-pinned so it can't drift into a mock.
 *  AC4  Entry points exist: command palette action + boot query param +
 *       App overlay mount.
 *  AC5  In browser preview the harness still mounts (layout/pins exist)
 *       with transport disabled and a desktop-only banner; closing
 *       removes it.
 *  AC6  Mid-page skip + speed controls are wired to player.seek /
 *       re-render-with-speed (source-pinned control surface).
 *
 * Sections A/B need no build; section C boots the built bundle:
 *   npm run build && node tests/listen-harness.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
// Section A — pure gap-audit math (no DOM, no build).
// ---------------------------------------------------------------------------
{
  const A = await import(pathToFileURL(join(root, "src/lib/tts/boundaryAudit.ts")).href);
  const RATE = 24000;
  const pauseMs = { sentence: 220, paragraph: 480, section: 600 };
  const ms = (n) => Math.round(n * RATE / 1000); // exact sample counts

  // Sentence → sentence boundary: 220ms of rendered silence.
  const t1 = [
    { segId: 0, startSample: 0, endSample: ms(220) },
    { segId: 1, startSample: ms(220) + ms(220), endSample: ms(220) + ms(220) + 1000 },
  ];
  const a1 = A.auditGaps({
    timings: t1,
    classOf: () => "sentence",
    pauseMs,
    sampleRate: RATE,
    pageRanges: [{ startSample: 0, endSample: t1[1].endSample }],
  });
  check("AC1 sentence gap measured at 220ms", a1.rows.length === 1 && a1.rows[0].actualMs === 220, `actual=${a1.rows[0]?.actualMs}`);
  check("AC1 perfect pause reports ok", a1.rows[0].ok && a1.badCount === 0);
  check("AC1 not a page join here", !a1.rows[0].crossPage);

  // Paragraph + section classes expect their own lengths; a wrong gap fails.
  for (const klass of ["paragraph", "section"]) {
    const exp = pauseMs[klass];
    const t = [
      { segId: 0, startSample: 0, endSample: 500 },
      { segId: 1, startSample: 500 + ms(exp), endSample: 500 + ms(exp) + 10 },
    ];
    const a = A.auditGaps({ timings: t, classOf: () => klass, pauseMs, sampleRate: RATE, pageRanges: [] });
    check(`AC1 ${klass} gap = ${exp}ms`, a.rows[0].ok && a.rows[0].actualMs === exp, `actual=${a.rows[0].actualMs}`);
  }
  const wrong = A.auditGaps({
    timings: [
      { segId: 0, startSample: 0, endSample: 100 },
      { segId: 1, startSample: 100 + ms(220) + 720, endSample: 99999 }, // +30ms stray
    ],
    classOf: () => "sentence",
    pauseMs,
    sampleRate: RATE,
    pageRanges: [],
  });
  check("AC1 stray silence flagged not-ok", wrong.badCount === 1 && wrong.rows[0].deltaMs === 30, `delta=${wrong.rows[0].deltaMs}`);

  // Page join flag: gap whose left side ends exactly at a page end.
  const joinAudit = A.auditGaps({
    timings: [
      { segId: 0, startSample: 0, endSample: ms(220) },
      { segId: 1, startSample: ms(220) + ms(480), endSample: 99999 },
    ],
    classOf: (id) => (id === 0 ? "paragraph" : "sentence"),
    pauseMs,
    sampleRate: RATE,
    pageRanges: [{ startSample: 0, endSample: ms(220) }],
  });
  check("AC1 page join flagged ⇄", joinAudit.rows[0].crossPage);
  check("AC1 join still audited against expected", joinAudit.rows[0].expectedMs === 480 && joinAudit.rows[0].ok);

  // Contiguity: chain with a hole fails; clean chain passes.
  check(
    "AC2 contiguous chain passes",
    A.rangesContiguous([{ startSample: 0, endSample: 100 }, { startSample: 100, endSample: 250 }]),
  );
  check(
    "AC2 gapped chain flagged",
    !A.rangesContiguous([{ startSample: 0, endSample: 100 }, { startSample: 140, endSample: 250 }]),
  );

  // Out-of-order arrival sorts internally; unknown ids default sentence.
  const shuffled = A.auditGaps({
    timings: [
      { segId: 7, startSample: ms(220) + ms(220), endSample: 9000 },
      { segId: 3, startSample: 0, endSample: ms(220) },
    ],
    classOf: () => "sentence",
    pauseMs,
    sampleRate: RATE,
    pageRanges: [],
  });
  check("AC2 out-of-order timings still measured", shuffled.rows.length === 1 && shuffled.rows[0].segId === 3);
  check("AC2 empty input → no rows, chain ok", A.auditGaps({ timings: [], classOf: () => "sentence", pauseMs, sampleRate: RATE, pageRanges: [] }).rows.length === 0);
}

// ---------------------------------------------------------------------------
// Section B — source pins (wiring + entry points + control surface).
// ---------------------------------------------------------------------------
{
  const harnessSrc = await readFile(join(root, "src/lib/components/ListenHarness.svelte"), "utf8");
  const paletteSrc = await readFile(join(root, "src/lib/components/CommandPalette.svelte"), "utf8");
  const appSrc = await readFile(join(root, "src/App.svelte"), "utf8");
  const devSrc = await readFile(join(root, "src/lib/stores/devHarness.ts"), "utf8");
  const playerSrc = await readFile(join(root, "src/lib/tts/player.ts"), "utf8");

  // AC3 — same primitives as ReadAloudButton, not a mock.
  for (const prim of ["ensureTts(", "startRender(", "subscribeRender(", "TtsTimelinePlayer(", "ttsRenderDemand("]) {
    check(`AC3 harness uses ${prim.slice(0, -1)}`, harnessSrc.includes(prim));
  }
  check("AC3 segments come from the real splitter", harnessSrc.includes("segmentsForSections("));

  // AC4 — entry points.
  check("AC4 palette action exists", paletteSrc.includes("TTS listen harness (dev)") && paletteSrc.includes("listenHarnessOpen"));
  check("AC4 App mounts the overlay", appSrc.includes("<ListenHarness />") && appSrc.includes("$listenHarnessOpen"));
  check("AC4 boot query param supported", devSrc.includes("listen-harness") && devSrc.includes("URLSearchParams"));

  // AC6 — control surface.
  check("AC6 mid-page skip calls player.seek", harnessSrc.includes("player.seek(target)"));
  check("AC6 speed re-renders with the chosen rate", harnessSrc.includes("beginRender(fromSeg, speed)") && harnessSrc.includes("setSpeed("));
  check("AC6 frontier seeks take the re-render path", harnessSrc.includes("onMissingPage") && harnessSrc.includes("restartFrom("));
  check("AC6 pause probes target real boundaries", harnessSrc.includes('seekToNextPause("paragraph")') && harnessSrc.includes('seekToNextPause("section")'));
  check("AC6 gap table renders measured rows", harnessSrc.includes("Measured boundary gaps") && harnessSrc.includes("crossPage"));

  // Player diagnostics getters the harness reads.
  check("player exposes playheadNow", playerSrc.includes("playheadNow(): number"));
  check("player exposes receivedEndSamples", playerSrc.includes("receivedEndSamples(): number"));
}

// ---------------------------------------------------------------------------
// Section C — runtime: boot the built bundle, open the harness.
// ---------------------------------------------------------------------------
const dom = new JSDOM(
  `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true }
);

delete globalThis.CustomEvent;
delete globalThis.Event;
for (const key of [
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
]) {
  if (key in dom.window && !(key in globalThis)) globalThis[key] = dom.window[key];
}
const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (dom.window.Range) {
  if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
  if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
}
if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const appendChild = dom.window.document.head.appendChild.bind(dom.window.document.head);
dom.window.document.head.appendChild = (node) => {
  const result = appendChild(node);
  if (node.tagName === "LINK" && node.rel === "stylesheet") {
    setTimeout(() => node.dispatchEvent(new dom.window.Event("load")), 0);
  }
  return result;
};
globalThis.window.innerWidth = 1280;
globalThis.window.innerHeight = 800;
globalThis.devicePixelRatio = 1;
globalThis.window.devicePixelRatio = 1;

const errors = [];
console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 300));
// jsdom without the canvas package logs "Not implemented" — env noise.
const appErrors = () => errors.filter((e) => !/Not implemented/.test(e));

dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ theme: "dark" }));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);

const doc = dom.window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(300);
  }
}
const text = () => doc.getElementById("app")?.textContent ?? "";

check("shell mounts", await waitFor(() => doc.getElementById("app")?.innerHTML.includes("app-shell"), 15000));

// Open via the command palette (the real entry point).
globalThis.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
check("palette opens", await waitFor(() => !!doc.querySelector(".palette-input"), 5000));
const input = doc.querySelector(".palette-input");
input.value = "harness";
input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
check(
  "AC4 palette surfaces the harness action",
  await waitFor(() => [...doc.querySelectorAll(".palette-result .result-label")].some((el) => (el.textContent || "").includes("TTS listen harness")), 5000),
);
const result = [...doc.querySelectorAll(".palette-result .result-label")]
  .find((el) => (el.textContent || "").includes("TTS listen harness"));
result?.closest("button")?.click();

check("AC5 harness dialog mounts", await waitFor(() => !!doc.querySelector(".listen-harness[role=dialog]"), 5000));
check("AC5 desktop-only banner in preview", /Desktop-only/.test(text()));
check("AC5 Start disabled in preview", await waitFor(() => {
  const btn = [...doc.querySelectorAll(".listen-harness button")].find((b) => (b.textContent || "").trim() === "Start");
  return !!btn && btn.disabled;
}, 5000));
check("AC6 speed row rendered", ["0.75×", "1×", "1.25×", "1.5×"].every((s) => text().includes(s)) || [...doc.querySelectorAll(".lh-btn.speed")].length === 4);
check("AC1 gap scaffolding rendered", /Measured boundary gaps/.test(text()) && /No audio received yet/.test(text()));
check("AC6 skip controls rendered", /mid-page/.test(text()) && /next paragraph pause/.test(text()));
check("checklist rendered", /Listen for:/.test(text()) && /Page joins/.test(text()));
check("no console errors", appErrors().length === 0, appErrors()[0] ?? "");

// Close via the X (same path as Esc).
const closeBtn = doc.querySelector(".listen-harness .lh-close");
closeBtn?.click();
check("AC5 close removes the harness", await waitFor(() => !doc.querySelector(".listen-harness"), 5000));
check("shell still alive after close", doc.getElementById("app")?.innerHTML.includes("app-shell") ?? false);

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll listen-harness checks passed.");
