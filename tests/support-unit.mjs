/**
 * support-unit — checks for src/lib/support.ts, the pure data + mailto
 * composer behind Settings → Support (private repo: email channel, never
 * auto-send).
 *
 * Run: node tests/support-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = await import(pathToFileURL(join(root, "src/lib/support.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const snap = v.buildDiagnosticsSnapshot({ version: "0.2.1", desktop: true, theme: "default", themeMode: "dark" });
check("snapshot names version + platform", snap.includes("0.2.1") && snap.includes("desktop app"));
check("snapshot names theme", snap.includes("default") && snap.includes("dark"));
check("snapshot carries no doc content", !snap.includes("hello") && snap.split("\n").length <= 8);

const preview = v.buildDiagnosticsSnapshot({ version: "0.2.1", desktop: false, theme: "glass", themeMode: "light" });
check("preview platform labeled", preview.includes("browser preview"));

// Basic mailto composition.
let r = v.buildFeedbackMailto(
  { subject: "Crash on save", message: "Steps: open, type, save.", severity: "bug" },
  snap
);
check("mailto targets support inbox", r.url.startsWith(`mailto:${v.SUPPORT_EMAIL}?`));
check("mailto subject carries severity", r.url.includes(encodeURIComponent("[Bug report] Crash on save")));
check("mailto body carries message + snapshot", r.url.includes(encodeURIComponent("Steps: open, type, save.")) && r.url.includes(encodeURIComponent("app version: 0.2.1")));
check("short draft not truncated", r.truncated === false);

// Empty subject/message degrade loudly, never blank.
r = v.buildFeedbackMailto({ subject: "  ", message: "   ", severity: "idea" }, snap);
check("empty subject falls back", r.url.includes(encodeURIComponent("[Feature idea] Untitled feedback")));
check("empty message marked", r.url.includes(encodeURIComponent("(no details written)")));

// Long messages truncate with a visible marker (mailto length limits).
const long = "x".repeat(3000);
r = v.buildFeedbackMailto({ subject: "t", message: long, severity: "question" }, snap);
check("long draft truncates loudly", r.truncated === true && r.url.includes(encodeURIComponent("truncated")));

// Plain-text fallback mirrors the mailto content.
const text = v.buildFeedbackText({ subject: "Hi", message: "hello", severity: "other" }, snap);
check("text fallback has headers + body", text.includes(`To: ${v.SUPPORT_EMAIL}`) && text.includes("[Other] Hi") && text.includes("hello"));

// Contact surface is never empty (placeholders are explicit, not blank).
check("support email set", typeof v.SUPPORT_EMAIL === "string" && v.SUPPORT_EMAIL.includes("@"));
check("company name set", typeof v.COMPANY_NAME === "string" && v.COMPANY_NAME.length > 0);
check("maker identity is simply-ehis", v.COMPANY_NAME === "simply-ehis", v.COMPANY_NAME);
check("placeholder flag is boolean", typeof v.SUPPORT_PLACEHOLDER === "boolean");
check(
  "live inbox is real (no example.com)",
  v.SUPPORT_PLACEHOLDER === true || !v.SUPPORT_EMAIL.endsWith("@example.com")
);

if (failures > 0) {
  console.error(`support-unit: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("support-unit: all checks passed");
