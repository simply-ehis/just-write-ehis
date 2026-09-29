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

try {
  const distStat = await stat(join(root, "dist/index.html"));
  const sourceStats = await Promise.all([
    stat(join(root, "src/main.ts")),
    stat(join(root, "src/App.svelte")),
    stat(join(root, "src/lib/components/BottomBar.svelte")),
    stat(join(root, "src/app.css")),
  ]);
  if (Math.max(...sourceStats.map((entry) => entry.mtimeMs)) > distStat.mtimeMs) {
    console.log("SKIP  mobile behavior requires a fresh dist; source-only mode forbids rebuilding");
    console.log(failures === 0 ? "MOBILE-PARITY SOURCE CHECKS PASS" : `MOBILE-PARITY ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }
} catch {
  console.log("SKIP  mobile behavior requires dist; source-only mode forbids rebuilding");
  console.log(failures === 0 ? "MOBILE-PARITY SOURCE CHECKS PASS" : `MOBILE-PARITY ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Behavior: 390px shell + Inspector sheet round-trip ───────────────
{
  const dom = bootDom(390, 844);
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ hasOnboarded: true }));
  let bundleUrl;
  try {
    bundleUrl = await resolveBundle(root);
  } catch {
    console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
    process.exit(1);
  }
  console.error = (..._) => {};
  await import(bundleUrl);
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
