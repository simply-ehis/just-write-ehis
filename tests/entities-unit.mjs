/**
 * entities-unit — pure-function checks for Area 9's deterministic
 * extraction + shared markdown fragment renderer + import helpers.
 * Covers src/lib/entities.ts and src/lib/markdown.ts.
 * (importFile.ts's pure helpers need the $lib alias + pdf.js, so they
 * ride the headless import matrix instead — see tests/novel-surface.mjs.)
 *
 * Run: node tests/entities-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ent = await import(pathToFileURL(join(root, "src/lib/entities.ts")).href);
const md = await import(pathToFileURL(join(root, "src/lib/markdown.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── Gazetteer ──────────────────────────────────────────────────────
{
  const rows = ent.extractEntities("Elena met the harbor master at Grey Harbor.", [
    { kind: "world_characters", key: "Elena" },
    { kind: "world_settings", key: "Grey Harbor" },
  ]);
  const byNorm = new Map(rows.map((r) => [r.norm, r]));
  check("gazetteer person kind", byNorm.get("elena")?.kind === "person", byNorm.get("elena")?.kind);
  check("gazetteer place kind", byNorm.get("grey harbor")?.kind === "place", byNorm.get("grey harbor")?.kind);
  // "harbor master" is lowercase prose — must NOT extract as a name.
  check("lowercase prose ignored", !byNorm.has("harbor master"));
  // Gazetteer occurrence inside "Grey Harbor" must not double-count.
  check("no overlapping double count", rows.filter((r) => r.norm === "grey harbor").length === 1);
}

// ── Capitalized runs + stoplist ────────────────────────────────────
{
  const rows = ent.extractEntities("Jon Snow walked with Arya Stark. The King watched.", []);
  const norms = rows.map((r) => r.norm);
  check("multiword names found", norms.includes("jon snow") && norms.includes("arya stark"), norms.join("|"));
  check("stoplist head skipped", !norms.some((n) => n.startsWith("the king")), norms.join("|"));
  check("run kind is name", rows.find((r) => r.norm === "jon snow")?.kind === "name");
}

// ── Snippets ───────────────────────────────────────────────────────
{
  const text = "x".repeat(200) + "Elena" + "y".repeat(200);
  const s = ent.entitySnippet(text, 200, 205, 60);
  check("snippet ellipsizes both ends", s.startsWith("…") && s.endsWith("…") && s.includes("Elena"));
  check("short text has no ellipses", !ent.entitySnippet("hi Elena bye", 3, 8).includes("…"));
}

// ── Markdown fragment ──────────────────────────────────────────────
{
  const html = md.markdownToHtmlFragment("# Title\n\nHello **bold** and *em*\n\n- one\n- two\n\n1. first\n\n> quote");
  check("h1 renders", html.includes("<h1>Title</h1>"));
  check("bold/em render", html.includes("<strong>bold</strong>") && html.includes("<em>em</em>"));
  check("ul renders", html.includes("<ul>") && html.includes("<li>one</li>"));
  check("ol renders", html.includes("<ol>"));
  check("blockquote renders", html.includes("<blockquote>quote</blockquote>"));
  const evil = md.markdownToHtmlFragment('<script>alert(1)</script>');
  check("raw html escaped", !evil.includes("<script>") && evil.includes("&lt;script&gt;"));
}

// ── mapEntityKind ────────────────────────────────────────────────
{
  check("characters -> person", ent.mapEntityKind("world_characters") === "person");
  check("settings -> place", ent.mapEntityKind("world_settings") === "place");
  check("other -> term", ent.mapEntityKind("world_rules") === "term");
}

console.log(failures === 0 ? "ENTITIES-UNIT ALL PASS" : `ENTITIES-UNIT ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
