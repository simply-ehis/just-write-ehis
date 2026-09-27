/**
 * support-unit — checks for src/lib/support.ts, the pure data + issue
 * composer behind Settings → Support (public tracker path, never
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

// Basic issue composition.
const issue = v.buildIssueUrl(
  { subject: "Crash on save", message: "Steps: open, type, save.", severity: "bug" },
  snap
);
check("issue targets repo tracker", issue.url.startsWith("https://github.com/simply-ehis/just-write-ehis/issues/new?"));
check("issue title carries severity", issue.url.includes(encodeURIComponent("[Bug report] Crash on save")));
check("issue body carries message + snapshot", issue.url.includes(encodeURIComponent("Steps: open, type, save.")) && issue.url.includes(encodeURIComponent("app version: 0.2.1")));
check("issue short draft not truncated", issue.truncated === false);

// Empty subject/message degrade loudly, never blank.
const issueEmpty = v.buildIssueUrl({ subject: "  ", message: "   ", severity: "idea" }, snap);
check("empty subject falls back", issueEmpty.url.includes(encodeURIComponent("[Feature idea] Untitled feedback")));
check("empty message marked", issueEmpty.url.includes(encodeURIComponent("(no details written)")));

// Long messages truncate with a visible marker (link length limits).
const long = "x".repeat(3000);
const issueLong = v.buildIssueUrl({ subject: "t", message: long, severity: "question" }, snap);
check("long draft truncates loudly", issueLong.truncated === true && issueLong.url.includes(encodeURIComponent("truncated")));
const issueOther = v.buildIssueUrl({ subject: "  ", message: "   ", severity: "other" }, snap);
check("other severity falls back", issueOther.url.includes(encodeURIComponent("[Other] Untitled feedback")));

// Plain-text fallback mirrors the issue content (no email headers).
const text = v.buildFeedbackText({ subject: "Hi", message: "hello", severity: "other" }, snap);
check("text fallback has subject + body", text.includes("[Other] Hi") && text.includes("hello"));
check("text fallback has no mail headers", !text.includes("To:") && !text.includes("mailto:"));

// Tracker constants point at the public repo.
check("tracker constants set", v.GITHUB_OWNER === "simply-ehis" && v.GITHUB_REPO === "just-write-ehis");
check("issues URL built from constants", v.GITHUB_ISSUES_URL === `https://github.com/${v.GITHUB_OWNER}/${v.GITHUB_REPO}/issues`);

// Contact surface is never empty (placeholders are explicit, not blank).
check("company name set", typeof v.COMPANY_NAME === "string" && v.COMPANY_NAME.length > 0);
check("maker identity is simply-ehis", v.COMPANY_NAME === "simply-ehis", v.COMPANY_NAME);
check("placeholder flag is boolean", typeof v.SUPPORT_PLACEHOLDER === "boolean");

if (failures > 0) {
  console.error(`support-unit: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("support-unit: all checks passed");
