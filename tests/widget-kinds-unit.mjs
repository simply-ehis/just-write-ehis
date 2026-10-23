/**
 * widget-kinds-unit: pure checks for the widget registry and the Quick note
 * helpers (src/lib/widgets/*). Headless; no build needed.
 * Run: node tests/widget-kinds-unit.mjs
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const reg = await load("src/lib/widgets/registry.ts");
const qn = await load("src/lib/widgets/quickNote.ts");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

// registry
check("only the supported kinds exist", JSON.stringify(reg.WIDGET_KINDS.map((k) => k.id)) === JSON.stringify(["quicknote", "reader"]));
check("every kind has a label, a one-line job and a tab it opens", reg.WIDGET_KINDS.every((k) => k.label && k.job && (k.opens === "logs" || k.opens === "reader")));
check("every initial size respects the real-widget floor", reg.WIDGET_KINDS.every((k) => k.initial.w >= reg.WIDGET_MIN.w && k.initial.h >= reg.WIDGET_MIN.h));
check("unknown or retired kinds fall back to the default", reg.widgetSpec("write").id === reg.DEFAULT_WIDGET_KIND && reg.widgetSpec(undefined).id === "quicknote");
check("isWidgetKind accepts only registered ids", reg.isWidgetKind("reader") && !reg.isWidgetKind("calendar") && !reg.isWidgetKind(7));
const tiny = reg.clampWidgetSize(10, 10);
const huge = reg.clampWidgetSize(99999, 99999);
check("size is clamped up to the floor", tiny.w === reg.WIDGET_MIN.w && tiny.h === reg.WIDGET_MIN.h);
check("size is clamped down to the ceiling", huge.w === reg.WIDGET_MAX.w && huge.h === reg.WIDGET_MAX.h);
check("junk sizes never produce NaN", Number.isFinite(reg.clampWidgetSize(NaN, undefined).w));

// quick note
check("dayKey is local YYYY-MM-DD", qn.dayKey(new Date(2026, 9, 5)) === "2026-10-05");
check("clock is zero-padded 24h", qn.clock(new Date(2026, 9, 5, 7, 3)) === "07:03" && qn.clock(new Date(2026, 9, 5, 0, 5)) === "00:05");
check("note block matches the Logs tab format", qn.noteBlock("14:32", "  hello  ") === "\n\n## 14:32\n\nhello\n");
check("blank notes are never written", qn.noteBlock("14:32", "  \n ") === "" && qn.appendNote("body", "14:32", "") === "body");
const log = qn.appendNote(qn.appendNote("# 2026-10-20\n", "09:05", "first"), "14:32", "second\nline two");
check("notes append in order and keep earlier text", log.indexOf("first") < log.indexOf("second") && log.startsWith("# 2026-10-20"));
const recent = qn.recentNotes(log, 5);
check("recentNotes parses timestamped notes", recent.length === 2 && recent[1].time === "14:32" && recent[1].text === "second\nline two");
check("recentNotes honours the limit and keeps the newest", qn.recentNotes(log, 1)[0].time === "14:32" && qn.recentNotes(log, 0).length === 0);
check("recentNotes tolerates empty or note-free bodies", qn.recentNotes("", 3).length === 0 && qn.recentNotes(null, 3).length === 0 && qn.recentNotes("# just a heading\n", 3).length === 0);

if (failures) {
  console.error(`${failures} widget-kinds failure(s)`);
  process.exit(1);
}
console.log("widget-kinds-unit: all checks passed");
