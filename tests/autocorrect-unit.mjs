/**
 * autocorrect-unit — pure-function checks for the non-AI autocorrect
 * rule table (src/lib/autocorrect.ts). The live firing path (plugin →
 * editor → debounce → store) is covered by tests/write-probe.mjs Phase 5;
 * this guards the table itself against regressions.
 *
 * Run: node tests/autocorrect-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ac = await import(pathToFileURL(join(root, "src/lib/autocorrect.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Representative typo/expansion cases from the shipped table.
const cases = [
  ["teh", "the"], ["adn", "and"], ["recieve", "receive"],
  ["seperate", "separate"], ["definately", "definitely"],
  ["tommorow", "tomorrow"], ["writting", "writing"],
  ["occured", "occurred"], ["untill", "until"],
];
for (const [typo, fixed] of cases) {
  check(`table fixes '${typo}' -> '${fixed}'`, ac.getAutocorrectSuggestions(typo, new Set(), true) === fixed);
}
check("unknown words untouched", ac.getAutocorrectSuggestions("zxqv", new Set(), true) === null);
check("correct words untouched", ac.getAutocorrectSuggestions("the", new Set(), true) === null);
check("isKnownTypo agrees with table", ac.isKnownTypo("teh") && !ac.isKnownTypo("the"));
check("em-dash normalization", ac.normalizeCharacters("a---b") === "a—b");
check("ellipsis normalization", ac.normalizeCharacters("wait...") === "wait…");

// Custom dictionary veto at the helper level: an invented Story Bible
// name at edit-distance-1 from a real word must not be "corrected".
// (The plugin additionally vetoes exact-table hits via custom.has().)
check(
  "custom dict suppresses fuzzy correction",
  ac.getAutocorrectSuggestions("Elena", new Set(["elena"]), true) === null
);

console.log(failures === 0 ? "AUTOCORRECT-UNIT ALL PASS" : `AUTOCORRECT-UNIT ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
