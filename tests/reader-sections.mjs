/**
 * reader-sections — unit checks for the Reader's structured flow
 * (src/lib/readerSections.ts + markdown image rule in markdown.ts):
 * section splitting (headings/prologue/islands), TTS stripping,
 * chunking, anchor math, and markdown structure survival.
 *
 * Run: node tests/reader-sections.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rs = await import(pathToFileURL(join(root, "src/lib/readerSections.ts")).href);
const md = await import(pathToFileURL(join(root, "src/lib/markdown.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Splitting: prologue + two chapters, islands ride along.
const mixed = [
  "Opening line here.",
  "",
  "# Chapter One",
  "",
  "First words.",
  "",
  "\n\n::transclude::note::\n\n<div class=\"transclude\">X</div>\n\n::transclude::note::\n\n",
  "## Deep Dive",
  "",
  "- item a",
  "- item b",
].join("\n");
const secs = rs.splitSections(mixed);
check("prologue + 2 sections", secs.length === 3, `${secs.length} sections`);
check("prologue id is top", secs[0].id === "top");
check("chapter title kept", secs[1].title === "Chapter One");
check("subheading starts own section", secs[2].title === "Deep Dive");
check("island attached whole", secs[1].parts.some((p) => p.type === "html" && p.text.includes("transclude")));
const solo = rs.splitSections("# Solo\n\nBody.\n");
check("doc starting with heading has no empty top", solo.length === 1 && solo[0].title === "Solo");

// TTS stripping: no markdown read aloud.
const stripped = rs.stripForTts("# Chapter One\n\n- item *a* and `b`\n\n> quote");
check("tts strips markers", !stripped.includes("#") && !stripped.includes("`") && !stripped.includes("*") && !stripped.includes(">"));
check("tts keeps words", stripped.includes("Chapter One") && stripped.includes("item") && stripped.includes("quote"), JSON.stringify(stripped));

// Chunking: paragraph-respecting + hard cap.
check("short text unchunked", rs.chunkText("hello", 6000).length === 1);
const long = Array.from({ length: 30 }, (_, i) => `Para ${i} ` + "word ".repeat(60)).join("\n\n");
const chunks = rs.chunkText(long, 1000);
check("long text chunked", chunks.length > 3, `${chunks.length} chunks`);
check("chunks bounded", chunks.every((c) => c.length <= 1000));
check("monster paragraph hard-capped", rs.chunkText("x".repeat(2500), 1000).every((c) => c.length <= 1000));

// Anchor math: section attach + ratio + restore + fallback.
const tops = [
  { id: "top", top: 0, height: 400 },
  { id: "chapter-one", top: 400, height: 1200 },
  { id: "deep-dive", top: 1600, height: 800 },
];
const a1 = rs.anchorFor(tops, 700);
check("anchor attaches to section", a1.section === "chapter-one");
check("anchor ratio in range", Math.abs(a1.ratio - 300 / 1200) < 1e-9, String(a1.ratio));
check("restore round-trips", rs.scrollTopFor(a1, tops, 2400) === 700);
const aTop = rs.anchorFor(tops, 0);
check("top anchors", aTop.section === "top" && aTop.ratio === 0);
check("missing section falls back null", rs.scrollTopFor({ section: "gone", ratio: 0.5 }, tops, 2400) === null);

// Resize/reflow survival: save mid-Chapter-One, then reflow (font swap
// doubles every section height). The same anchor must resolve to the
// same section at the same intra-section ratio — the absolute scrollTop
// moves, the reading position does not.
const saved = rs.anchorFor(tops, 1000); // mid chapter-one
check("pre-reflow anchor in chapter", saved.section === "chapter-one");
const reflowed = tops.map((s) => ({ ...s, top: s.top * 2, height: s.height * 2 }));
const restored = rs.scrollTopFor(saved, reflowed, 4800);
check("reflow keeps section", restored !== null);
const reanchored = rs.anchorFor(reflowed, restored);
check("reflow keeps ratio", reanchored.section === "chapter-one" && Math.abs(reanchored.ratio - saved.ratio) < 1e-9);
check("scrollTop adapted to reflow", restored === 2000, `${restored}px`);

// Markdown structure survival (headings/lists/quotes render, not literal).
const html = md.markdownToHtmlFragment("# Title\n\n- a\n- b\n\n> q\n\nplain");
check("heading renders", html.includes("<h1>Title</h1>"));
check("list renders", html.includes("<ul>") && html.includes("<li>a</li>"));
check("quote renders", html.includes("<blockquote>q</blockquote>"));
check("no literal markers", !html.includes("# Title") || html.includes("<h1>"));
// Dropped-image placeholder, and ONLY for that target.
const img = md.markdownToHtmlFragment("![cover art](dropped-image)");
check("dropped image captioned", img.includes("img-missing") && img.includes("cover art"));
const real = md.markdownToHtmlFragment("![alt](https://x/y.png)");
check("real image target untouched", !real.includes("img-missing") && real.includes("https://x/y.png"));

console.log(failures === 0 ? "READER-SECTIONS ALL PASS" : `READER-SECTIONS ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
