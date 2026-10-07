/**
 * save-state guard — the two data-loss bugs this file exists to prevent.
 *
 * Both are regression tests, not smoke tests: each asserts the specific
 * behaviour that was broken, and each FAILED against the pre-fix source.
 *
 *  1. The save indicator was driven by a fixed 500ms timer, so the UI
 *     claimed "Saved" while the write was still queued. It is now driven by
 *     the save promise.
 *  2. `onDestroy` cleared the pending save timers instead of flushing them,
 *     so the last <500ms of typing was discarded on workspace switch /
 *     window close — while the indicator said "Saved".
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

console.log("save-state: indicator is driven by the promise, not a timer");
{
  const store = await readFile(join(root, "src/lib/stores/saveState.ts"), "utf8");

  check(
    "no timer-based transition to 'saved'",
    !/setTimeout\([\s\S]{0,120}saveState\.set\("saved"\)/.test(store),
    "a timer still flips the phase to saved",
  );
  check(
    "phase is set from a settlement function",
    store.includes("export function saveSettled"),
    "no saveSettled() to own the transition",
  );
  check(
    "failed saves are distinguishable",
    store.includes('"error"') && store.includes("export function saveFailed"),
    "a failed write cannot be shown differently from a good one",
  );
  check(
    "epoch guard stops a slow save clobbering a newer one",
    store.includes("savedEpoch !== epoch"),
    "no epoch guard",
  );
  check(
    "error phase does not decay back to idle",
    /failed[\s\S]{0,200}saveState\.set\("error"\);[\s\S]{0,80}return;/.test(store),
    "an error can silently decay to idle",
  );
}

console.log("save-state: pending saves are flushed, not discarded");
{
  const editor = await readFile(
    join(root, "src/lib/components/EditorPane.svelte"),
    "utf8",
  );
  const destroy = editor.slice(
    editor.indexOf("onDestroy("),
    editor.indexOf("onDestroy(") + 400,
  );

  check(
    "onDestroy flushes before clearing",
    /function flushPendingSave\(\)/.test(editor) &&
      destroy.includes("flushPendingSave()"),
    "onDestroy does not call a flush",
  );
  check(
    "flush writes the live content, not just clears timers",
    /function flushPendingSave\(\)[\s\S]{0,900}api\.atomicSave/.test(editor),
    "flush does not call atomicSave",
  );
  check(
    "pagehide is wired (window close / webview teardown)",
    /onpagehide=\{/.test(editor),
    "no pagehide handler — onDestroy alone can miss teardown paths",
  );
  check(
    "timers are nulled after the flush",
    /saveTimeout = null;/.test(editor) && /flushTimeout = null;/.test(editor),
    "timers not cleared, so a queued write could double-fire",
  );
  check(
    "flush reports failure instead of pretending success",
    /function flushPendingSave\(\)[\s\S]{0,1400}saveFailed/.test(editor),
    "a failed final flush is swallowed",
  );
}

console.log("save-state: every indicator surface shows the error phase");
for (const [file, pattern] of [
  ["src/lib/components/StatusBar.svelte", /Save failed/],
  ["src/lib/components/BottomBar.svelte", /Save failed/],
  ["src/WidgetApp.svelte", /Save failed/],
]) {
  const src = await readFile(join(root, file), "utf8");
  check(`${file} surfaces a failed save`, pattern.test(src));
}

console.log("save-state: the indicator is still wired to a real save call");
{
  const editor = await readFile(
    join(root, "src/lib/components/EditorPane.svelte"),
    "utf8",
  );
  check(
    "queueDocSave settles the epoch",
    /queueDocSave\([^)]*saveEpoch[^)]*\)/.test(editor) &&
      /function queueDocSave\([^)]*saveEpoch: number\)/.test(editor),
    "queueDocSave does not carry the epoch",
  );
  check(
    "recordSave() result is used, not discarded",
    /const saveEpoch = recordSave\(\)/.test(editor),
    "recordSave() return value ignored",
  );
}

if (failures) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nALL PASS");