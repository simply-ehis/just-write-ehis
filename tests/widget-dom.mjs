/**
 * widget-dom: boots the BUILT widget route (?widget=1) in jsdom and drives
 * each mini widget end to end over the real browser backend (no mocks).
 *
 *   --only=quicknote  type a note, Ctrl+Enter, assert it lands in today's log
 *                     in the Logs format and the box clears; assert a draft
 *                     survives; assert an empty box cannot save.
 *   --only=reader     seed a three-section book, assert the widget shows it,
 *                     steps sections, keeps its own place, and never touches
 *                     the main Reader's reading position.
 *
 * One boot per process (the jsdom harness rule), so run via:
 *   npm run build && npm run test:widgetdom
 */
import { JSDOM } from "jsdom";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rig, resolveBundle } from "./helpers/jsdom-boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").split("=")[1];
if (only !== "quicknote" && only !== "reader") {
  console.log("FAIL  run with --only=quicknote or --only=reader (or: npm run test:widgetdom)");
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  [${only}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bundleUrl = await resolveBundle(root).catch(() => null);
if (!bundleUrl) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}

const dom = new JSDOM(`<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`, {
  url: "http://localhost/?widget=1",
  pretendToBeVisual: true,
});
rig(dom);
dom.window.innerWidth = 360;
dom.window.innerHeight = 420;
const ls = dom.window.localStorage;
const stamp = "2026-10-20T10:00:00.000Z";
const book = (id, title, content) => ({
  id, workspace: "reader", kind: "md", title, path: `reader/${id}.md`, parent_id: null,
  created_at: stamp, updated_at: stamp, content, word_count: 20, reading_position: 0.5,
  status: "draft", frontmatter_json: null, activity_score: 1, embedding_ref: null, shelf_status: "reading",
});

if (only === "quicknote") {
  ls.setItem("writing-app-settings", JSON.stringify({ widgetKind: "quicknote" }));
  ls.setItem("jwe-widget-quicknote-draft", "unsent draft from last session");
} else {
  ls.setItem("writing-app-settings", JSON.stringify({ widgetKind: "reader" }));
  ls.setItem("jwe-browser-docs-v1", JSON.stringify([
    book("bk1", "Tide Book", "Prologue words here.\n\n# One\n\nFirst chapter text.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n# Two\n\nSecond chapter text.\n"),
  ]));
}

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ").slice(0, 200)); };
try {
  await import(bundleUrl);
} catch (e) {
  errors.push(`MOUNT THREW: ${String(e).split("\n")[0]}`);
}
await sleep(1500);

const doc = dom.window.document;
const $ = (sel) => doc.querySelector(sel);
const widget = $(".widget");
check("widget frame renders", !!widget, widget?.getAttribute("data-kind") ?? "missing");
check("widget hosts no workspace shell", !$(".app-shell") && !$(".sidebar") && !$(".workspace-nav"));
check("bar offers open-in-app and hide", !!$('button[aria-label="Hide widget"]') && !!$('button[aria-label^="Open "]'));

if (only === "quicknote") {
  check("one widget kind is shown", widget?.getAttribute("data-kind") === "quicknote");
  const box = $("textarea");
  check("note box exists", !!box);
  check("unsent draft from last session is restored", box?.value === "unsent draft from last session");
  const saveBtn = [...doc.querySelectorAll("button")].find((b) => /add to today/i.test(b.textContent || ""));
  box.value = "";
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(100);
  check("empty box cannot be saved", saveBtn?.disabled === true);

  box.value = "Buy ink\nand a new nib";
  box.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(100);
  box.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await sleep(800);

  const docs = JSON.parse(ls.getItem("jwe-browser-docs-v1") || "[]");
  const log = docs.find((d) => d.workspace === "logs");
  check("today's log was created", !!log, log?.title ?? "none");
  check("note is in the Logs format (## HH:MM, blank line, text)", /\n## \d{2}:\d{2}\n\nBuy ink\nand a new nib\n/.test(log?.content ?? ""), JSON.stringify(log?.content));
  check("box clears after a save", $("textarea")?.value === "");
  check("draft is cleared from storage after a save", ls.getItem("jwe-widget-quicknote-draft") === null);
  check("save confirmation shows", /Saved \d{2}:\d{2}/.test($(".status")?.textContent ?? ""), $(".status")?.textContent?.trim());

  // A second note appends, never overwrites.
  const box2 = $("textarea");
  box2.value = "second thought";
  box2.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(100);
  box2.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  await sleep(800);
  const log2 = JSON.parse(ls.getItem("jwe-browser-docs-v1") || "[]").find((d) => d.workspace === "logs");
  check("second note appends and keeps the first", (log2?.content ?? "").includes("Buy ink") && (log2?.content ?? "").includes("second thought"));
} else {
  check("one widget kind is shown", widget?.getAttribute("data-kind") === "reader");
  const select = $(".reader select");
  check("book picker lists the book", select?.options?.length === 1 && select.options[0].textContent === "Tide Book");
  const count = () => $(".count")?.textContent?.replace(/\s+/g, " ").trim();
  check("opens at the first section", count() === "1 / 3", count());
  check("section text is shown", ($(".reader-prose")?.textContent ?? "").includes("Prologue words here"));
  const next = $('button[aria-label="Next section"]');
  next.click();
  await sleep(400);
  check("next section steps forward", count() === "2 / 3", count());
  check("tables render as a real table", !!$(".reader-prose table"));
  next.click();
  await sleep(400);
  check("last section reached, next disabled", count() === "3 / 3" && $('button[aria-label="Next section"]').disabled === true);
  const saved = JSON.parse(ls.getItem("writing-app-settings") || "{}");
  check("widget remembers its own place", saved.widgetReaderDocId === "bk1" && typeof saved.widgetReaderSection === "string" && saved.widgetReaderSection.length > 0, saved.widgetReaderSection);
  const after = JSON.parse(ls.getItem("jwe-browser-docs-v1") || "[]").find((d) => d.id === "bk1");
  check("main Reader's position is untouched", after?.reading_position === 0.5, String(after?.reading_position));
}

console.error = origError;
const real = errors.filter((e) => !/not implemented|Could not parse CSS|Failed to fetch/i.test(e));
check("no unexpected console errors", real.length === 0, real.slice(0, 2).join(" | "));
if (failures) {
  console.error(`${failures} widget-dom failure(s)`);
  process.exit(1);
}
console.log(`widget-dom [${only}]: all checks passed`);
process.exit(0);
