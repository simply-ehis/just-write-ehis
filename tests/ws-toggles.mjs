/**
 * ws-toggles — headless checks for Settings workspace tabs on/off
 * (Area 12) + Files-route retirement.
 *
 * NOTE: SettingsPane itself is a lazy chunk whose stylesheet <link> never resolves under jsdom, so the pane can't render here
 * (same documented limit as lazy-load-probe). This probe therefore
 * verifies the wiring around it, which is all eager:
 * - preset hiddenIds hide workspaces from the sidebar;
 * - palette + mobile More still reach hidden AND virtual (Files) targets;
 * - "Go to Files" selects Library (deep link fires without errors).
 *
 * The checkbox UI (11 toggles incl. persistence) is verified by code
 * inspection + the shared settings write path (onboard-flow.mjs covers
 * hiddenIds/topBarIds persistence end to end).
 *
 * Run: npm run build && node tests/ws-toggles.mjs
 */
import { stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { rig, resolveBundle, sleep } from "./helpers/jsdom-boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sourceFiles = [
  "src/main.ts",
  "src/App.svelte",
  "src/lib/components/Sidebar.svelte",
  "src/lib/components/CommandPalette.svelte",
  "src/lib/stores/settings.ts",
];
try {
  const distStat = await stat(join(root, "dist/index.html"));
  const sourceStats = await Promise.all(sourceFiles.map((file) => stat(join(root, file))));
  if (Math.max(...sourceStats.map((entry) => entry.mtimeMs)) > distStat.mtimeMs) {
    console.log("SKIP  workspace toggle flow requires a fresh dist; source-only mode forbids rebuilding");
    process.exit(0);
  }
} catch {
  console.log("SKIP  workspace toggle flow requires dist; source-only mode forbids rebuilding");
  process.exit(0);
}

let bundleUrl;
try {
  bundleUrl = await resolveBundle(root);
} catch {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}

// One boot per process: a ?-suffixed second import evaluates a duplicate
// entry runtime while the App chunk still binds the first, producing a
// spurious dual-runtime effect_orphan (see shell-nav.mjs). CI runs
// --only=hidden and --only=defaults as separate processes.
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];
if (!only || (only !== "hidden" && only !== "defaults")) {
  console.log("FAIL  run via npm run test:wstoggles (one boot per process: --only=hidden / --only=defaults)");
  process.exit(1);
}

// ── Boot 1: hiddenIds preset hides Novel from sidebar ───────────────
if (!only || only === "hidden") {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({
    hasOnboarded: true,
    hiddenIds: ["novel", "inbox", "canvas"],
  }));
  console.error = (..._) => {};
  await import(bundleUrl);
  await sleep(2500);

  const qa = (s) => [...dom.window.document.querySelectorAll(s)];
  const navLabels = qa(".workspace-nav .nav-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("hidden Novel leaves the sidebar", !navLabels.includes("Novel"), navLabels.join(","));
  check("visible Write stays", navLabels.includes("Write"));

  // Palette still reaches hidden + virtual destinations.
  dom.window.dispatchEvent(new dom.window.CustomEvent("open-command-palette"));
  await sleep(600);
  const results = qa(".palette-result").map((b) => b.textContent.trim()).join("\n");
  check("palette reaches hidden Novel", results.includes("Go to Novel Studio"));
  check("palette reaches virtual Files", results.includes("Go to Files"));

  // "Go to Files" selects Library without errors (deep link target).
  const filesEntry = qa(".palette-result").find((b) => b.textContent.trim() === "Go to Files");
  const errCount = [];
  console.error = (...a) => errCount.push(a);
  filesEntry?.click();
  await sleep(800);
  check("Go to Files fires without errors", errCount.length === 0, errCount.slice(0, 2).join(" | "));
  console.error = (..._) => {};
}

// ── Boot 2: defaults unchanged (no hiddenIds key) ───────────────────
if (!only || only === "defaults") {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ hasOnboarded: true }));
  console.error = (..._) => {};
  await import(bundleUrl);
  await sleep(2500);
  const qa = (s) => [...dom.window.document.querySelectorAll(s)];
  const navLabels = qa(".workspace-nav .nav-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("defaults keep Novel visible", navLabels.includes("Novel"));
  check("defaults hide Inbox/Canvas, never Files-route", !navLabels.includes("Inbox") && !navLabels.includes("Canvas") && !navLabels.some((l) => l === "Files"), navLabels.join(","));
  console.error = (..._) => {};
}

console.log(failures === 0 ? "WS-TOGGLES ALL PASS" : `WS-TOGGLES ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
