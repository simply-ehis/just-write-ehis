/**
 * onboard-flow — headless checks for the Area 5 onboarding rebuild:
 * versioned first-run flag, 5-step flow with Novelist preset pins,
 * atomic settings write, sidebar pins without duplicates, replay event,
 * and silent veteran migration.
 *
 * Boots the built app once per process (fresh kbd `--only=fresh`, veteran
 * via `--only=veteran`): one boot per realm, since a second bundle
 * evaluation in the same process creates a duplicate Svelte runtime
 * (spurious effect_orphan — see tests/helpers/jsdom-boot.mjs).
 *
 * Run: npm run build && node tests/onboard-flow.mjs
 */
import { readFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootDom, resolveBundle, sleep } from "./helpers/jsdom-boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sourceFiles = [
  "src/main.ts",
  "src/App.svelte",
  "src/lib/components/OnboardingOverlay.svelte",
  "src/lib/stores/settings.ts",
  "src/lib/stores/app.ts",
];
try {
  const distStat = await stat(join(root, "dist/index.html"));
  const sourceStats = await Promise.all(sourceFiles.map((file) => stat(join(root, file))));
  const newestSource = Math.max(...sourceStats.map((entry) => entry.mtimeMs));
  if (newestSource > distStat.mtimeMs) {
    console.log("SKIP  onboarding flow requires a fresh dist; source-only mode forbids rebuilding");
    process.exit(0);
  }
} catch {
  console.log("SKIP  onboarding flow requires dist; source-only mode forbids rebuilding");
  process.exit(0);
}

let bundleUrl;
try {
  bundleUrl = await resolveBundle(root);
} catch {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
const btnByText = (dom, text) =>
  [...dom.window.document.querySelectorAll(".onboarding-card button")]
    .find((b) => (b.textContent || "").trim() === text);

// One boot per process: a ?-suffixed second import evaluates a duplicate
// entry runtime while the App chunk still binds the first, producing a
// spurious dual-runtime effect_orphan (see shell-nav.mjs). CI runs
// --only=fresh and --only=veteran as separate processes.
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];
if (!only || (only !== "fresh" && only !== "veteran")) {
  console.log("FAIL  run via npm run test:onboard (one boot per process: --only=fresh / --only=veteran)");
  process.exit(1);
}

// ── Boot 1: fresh user, full Novelist flow ──────────────────────────
if (!only || only === "fresh") {
  const dom = bootDom();
  console.error = (..._) => {};
  await import(bundleUrl);
  await sleep(2500);

  check("fresh boot shows onboarding", !!dom.window.document.querySelector(".onboarding-overlay"));
  check("5-step progress label", (dom.window.document.querySelector(".step-count")?.textContent || "").includes("Step 1 of 5"));

  btnByText(dom, "Get Started")?.click();
  await sleep(400);
  const novelist = [...dom.window.document.querySelectorAll(".pick-card")]
    .find((b) => (b.textContent || "").includes("Novelist"));
  check("use-case step offers Novelist", !!novelist);
  novelist?.click();
  await sleep(200);
  btnByText(dom, "Continue")?.click();
  await sleep(400);

  // Top-bar step: Novelist preset pins prechecked (write/novel/map/reader).
  const topSection = [...dom.window.document.querySelectorAll(".onboarding-card .check-grid")][0];
  const checkedCount = topSection ? topSection.querySelectorAll("input:checked").length : -1;
  check("novelist preset pins 4 top-bar boxes", checkedCount === 4, `checked=${checkedCount}`);
  btnByText(dom, "Continue")?.click();
  await sleep(400);

  check("theme step reached", (dom.window.document.querySelector(".step-count")?.textContent || "").includes("Step 4 of 5"));
  btnByText(dom, "Continue")?.click();
  await sleep(400);
  check("vault/AI step reached", (dom.window.document.querySelector(".step-count")?.textContent || "").includes("Step 5 of 5"));

  // Small vs main stay separate (alias bug must not return). The small
  // field is desktop-only by design (bundled local model), so the
  // preview DOM can only show the main field — assert the anti-alias
  // property at the source (distinct bindings) plus main-field presence.
  const overlaySrc = await readFile(join(root, "src/lib/components/OnboardingOverlay.svelte"), "utf8");
  check("small and main endpoint fields are separate",
    !!dom.window.document.querySelector("#onboard-endpoint") &&
    overlaySrc.includes("bind:value={smallEndpoint}") &&
    overlaySrc.includes("bind:value={mainEndpoint}"));

  // Uncheck the seed so this probe tests settings only (seed is try/catch'd anyway).
  const seed = [...dom.window.document.querySelectorAll(".seed-row input")][0];
  if (seed?.checked) seed.click();
  btnByText(dom, "Start Writing")?.click();
  await sleep(800);

  check("overlay dismisses on finish", !dom.window.document.querySelector(".onboarding-overlay"));
  const saved = JSON.parse(dom.window.localStorage.getItem("writing-app-settings") || "{}");
  check("finish persists hasOnboarded", saved.hasOnboarded === true);
  check("finish persists novelist topBarIds", JSON.stringify(saved.topBarIds) === JSON.stringify(["write", "novel", "map", "reader"]), (saved.topBarIds || []).join(","));
  check("finish persists default hiddenIds", JSON.stringify(saved.hiddenIds) === JSON.stringify(["inbox", "canvas"]));

  // Sidebar pins without duplicates.
  const pins = [...dom.window.document.querySelectorAll(".nav-pins .nav-item")].map((b) => b.getAttribute("aria-label"));
  check("sidebar renders 4 pins", pins.length === 4, pins.join(","));
  const novelCount = [...dom.window.document.querySelectorAll(".workspace-nav .nav-item")]
    .filter((b) => (b.getAttribute("aria-label") || "") === "Novel").length;
  check("no duplicate Novel entry", novelCount === 1, `count=${novelCount}`);

  // Replay re-opens the flow.
  dom.window.dispatchEvent(new dom.window.CustomEvent("replay-onboarding"));
  await sleep(400);
  check("replay-onboarding reopens overlay", !!dom.window.document.querySelector(".onboarding-overlay"));
}

// ── Boot 2: veteran migrates silently ───────────────────────────────
if (!only || only === "veteran") {
  const dom = bootDom();
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ featuresUsed: ["write"] }));
  console.error = (..._) => {};
  await import(bundleUrl);
  await sleep(2500);
  check("veteran is not re-prompted", !dom.window.document.querySelector(".onboarding-overlay"));
  const saved = JSON.parse(dom.window.localStorage.getItem("writing-app-settings") || "{}");
  check("veteran migrates to hasOnboarded", saved.hasOnboarded === true);
}

console.log(failures === 0 ? "ONBOARD-FLOW ALL PASS" : `ONBOARD-FLOW ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
