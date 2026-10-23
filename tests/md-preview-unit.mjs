/**
 * md-preview-unit — checks for src/lib/mdPreview.ts, the rendered-markdown
 * preview behind the Files viewer (tables, task lists, inert links/images,
 * sanitising). Uses the repo's existing jsdom devDependency.
 *
 * Run: node tests/md-preview-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const { JSDOM } = require("jsdom");
const createDOMPurify = require("dompurify");
const { window } = new JSDOM("");
const { createMarkdownPreview } = await import(pathToFileURL(join(root, "src/lib/mdPreview.ts")).href);
const render = createMarkdownPreview(createDOMPurify(window));

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const table = render("| a | b |\n|---|---|\n| 1 | 2 |\n");
check("tables render as <table>", table.includes("<table>") && table.includes("<th>a</th>") && table.includes("<td>2</td>"));
check("tables scroll inside their own wrapper", table.includes('<div class="md-table-wrap"><table>') && table.includes("</table></div>"));

const tasks = render("- [x] done\n- [ ] todo\n");
check("task lists keep (disabled) checkboxes", (tasks.match(/type="checkbox"/g) ?? []).length === 2 && tasks.includes("disabled"));

const basics = render("# T\n\n~~old~~ **bold** *it*\n\n```js\nlet a = 1;\n```\n\n> quote\n");
check("headings, strike, bold, code fence, quote", basics.includes("<h1>T</h1>") && basics.includes("<del>old</del>") && basics.includes("<strong>bold</strong>") && basics.includes('class="language-js"') && basics.includes("<blockquote>"));

const link = render("[site](https://example.com) [jump](#x)");
check("external links cannot navigate the app webview", !link.includes('href="https://') && link.includes('title="https://example.com"') && link.includes("md-link-inert"));
check("in-page anchors still work", link.includes('href="#x"'));

const img = render("![pic](C:\\x.png) ![ok](data:image/png;base64,AAAA)");
check("non-data images fall back to alt text", img.includes("[image: pic]") && !img.includes("C:\\x.png"));
check("data: images are kept", img.includes("data:image/png;base64,AAAA"));

const hostile = render('<script>alert(1)</script><img src=x onerror="alert(1)"><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">x</a>[y](javascript:alert(2))');
// Live markup is what matters: a literal "javascript:" inside plain text is inert.
check("scripts, handlers, iframes and javascript: links are stripped", !/<script|onerror\s*=|<iframe|href\s*=\s*"?javascript:/i.test(hostile), hostile.slice(0, 120));

check("empty input renders empty", render("").trim() === "");

if (failures) {
  console.error(`${failures} md-preview failure(s)`);
  process.exit(1);
}
console.log("md-preview-unit: all checks passed");
