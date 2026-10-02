/**
 * browserBackend <-> Rust parity fixture.
 *
 * `browserBackend.ts` re-implements parts of the Rust backend in TypeScript so
 * the browser preview behaves like the desktop app. Nothing kept the two in
 * step, and they had already drifted in ways a user can see: exporting the same
 * manuscript from the preview and from the desktop produced different files.
 *
 * The expectations below are the RUST behaviour (convert.rs), not whatever the
 * TypeScript happened to do — the point is that the mirror matches the backend,
 * since Rust owns publishing/export. Each case was derived by reading
 * convert.rs and is pinned here so a future edit to either side has to agree.
 *
 * Run: node tests/backend-parity.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = await readFile(join(root, "src/lib/browserBackend.ts"), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Strip just enough TypeScript to evaluate a function body in plain node. */
function stripTypes(code) {
  // Split the signature from the body first: annotations only ever appear in
  // the head for these small pure helpers, so confining the rewrite there
  // avoids mangling object literals and ternaries inside the body.
  const brace = code.indexOf("{");
  let head = code.slice(0, brace);
  const body = code.slice(brace);
  head = head
    .replace(/([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>\[\]|\s.,]*\s*([,)])/g, "$1 $2") // param types
    .replace(/\)\s*:\s*[A-Za-z_$][\w$<>\[\]|\s.,]*\s*$/, ")"); // return type
  return (
    head +
    body
      .replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=]+=/g, "$1 $2 =")
      .replace(/\bas\s+[A-Za-z_$][\w$<>\[\]|.]*/g, "")
      .replace(/([A-Za-z_$][\w$.]*)<[A-Za-z_$][\w$<>,[\]\s.]*>\(/g, "$1(")
  );
}

// Pull the functions out of the module so they can be exercised directly.
// They are module-private, so this mirrors the source text into a callable
// form rather than importing the bundle.
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return stripTypes(src.slice(start, i + 1));
}

const names = ["slugify", "markdownToText", "previewInlineEmbeds", "previewResolveWikilinks"];
const parts = names.map(extract);
const missing = names.filter((_, i) => !parts[i]);
if (missing.length) {
  // Against the pre-fix source this is the expected failure: the embed step
  // did not exist at all. Name it rather than bailing with a bare exit code.
  check(
    "every mirrored function is present in browserBackend.ts",
    false,
    `absent: ${missing.join(", ")}`
  );
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(1);
}
const [slugifySrc, markdownToTextSrc] = parts;
let slugify, markdownToText;
try {
  slugify = new Function(`${slugifySrc}; return slugify;`)();
  markdownToText = new Function(`${markdownToTextSrc}; return markdownToText;`)();
} catch (e) {
  console.log(`could not evaluate the extracted functions: ${e.message}`);
  console.log(slugifySrc);
  process.exit(1);
}

// --- slugify: Rust maps non-alphanumeric -> '-', collapses, "untitled" if empty ---
const SLUG_CASES = [
  ["Hello World", "hello-world"],
  ["Café", "café"],                    // Rust is_alphanumeric() is Unicode-aware
  ["日本語", "日本語"],
  ["  spaced  out  ", "spaced-out"],
  ["---", "untitled"],
  ["", "untitled"],
  ["A/B: C", "a-b-c"],
];
for (const [input, expected] of SLUG_CASES) {
  const got = slugify(input);
  check(`slugify(${JSON.stringify(input)})`, got === expected, `got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
}

// --- markdownToText: trim ALL leading #/>/space, then strip one list marker ---
const MD_CASES = [
  // Rust `trim_start_matches(['#','>',' ','\t'])` strips every leading hash,
  // so "## Chapter" becomes "Chapter" — not "# Chapter".
  ["## Chapter", "Chapter"],
  ["# Title", "Title"],
  ["> quoted", "quoted"],
  ["- [ ] task", "task"],
  ["- [x] done", "done"],
  ["- bullet", "bullet"],
  ["1. numbered", "numbered"],
  ["**bold**", "bold"],
  ["[label](http://x)", "label"],
];
for (const [input, expected] of MD_CASES) {
  const got = markdownToText(input);
  check(`markdownToText(${JSON.stringify(input)})`, got === expected, `got ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
}

// --- structural invariants the earlier drift broke ---
check(
  "embed inlining exists in the preview (it was missing entirely)",
  parts[2] !== null && /function previewInlineEmbeds/.test(src)
);
check(
  "export runs inline_embeds BEFORE resolve_wikilinks",
  /previewResolveWikilinks\(previewInlineEmbeds\(/.test(src),
  "convert.rs::prepare_export_body does inline_embeds then resolve_wikilinks"
);
check(
  "resolve_wikilinks leaves embed markers alone, like Rust",
  /if \(m\.startsWith\("!"\)\) return m;/.test(src),
  "Rust: 'An embed - inline_embeds handles it; leave the marker'"
);
check(
  "resolve_wikilinks takes the LAST pipe segment as display text",
  /parts\[parts\.length - 1\]/.test(src),
  "Rust uses inner.split('|').next_back()"
);
check(
  "embed-missing marker matches Rust wording",
  /\[embed missing: /.test(src)
);

// --- PIN backoff: the audit claimed these diverged; verify rather than assume ---
const commands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
const pinConstants = {};
for (const m of commands.matchAll(/const (PIN_[A-Z_]+): u\d+ = ([\d_]+);/g)) {
  pinConstants[m[1]] = Number(m[2].replace(/_/g, ""));
}
for (const [rustName, tsName] of [
  ["PIN_BASE_BACKOFF_MS", "browserPinBaseBackoffMs"],
  ["PIN_MAX_BACKOFF_MS", "browserPinMaxBackoffMs"],
  ["PIN_MAX_FAILED_ATTEMPTS", "browserPinMaxFailedAttempts"],
]) {
  const m = src.match(new RegExp(`const ${tsName} = (\\d+);`));
  check(
    `${tsName} matches ${rustName}`,
    Boolean(m) && Number(m[1]) === pinConstants[rustName],
    `ts=${m?.[1]} rust=${pinConstants[rustName]}`
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);