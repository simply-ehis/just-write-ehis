/**
 * Renderer-supplied-path guard.
 *
 * Two commands used to take a filesystem path straight from the renderer, which
 * turned "run JS in the webview" into "read or write anything the user can
 * reach":
 *
 *   - `open_external_file(path)` had no vault confinement at all (unlike every
 *     fs_* command, which canonicalise against the vault root), so a compromised
 *     webview could name any .txt/.md on the machine and get the contents back
 *     as a Doc. It now takes NO path: the backend opens the file it recorded in
 *     `PendingLaunchFile` from argv / the OS file association, which is the only
 *     legitimate flow — `nativeLaunch.ts` always fed it the backend's own file.
 *   - `doc_create` is confined in Rust (`resolve_in_vault`), so the remaining
 *     hazard is the renderer naming a path at all. These assertions keep both
 *     properties true.
 *
 * Run: node tests/renderer-path-guard.mjs (no build needed)
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(root, p), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const commands = await read("src-tauri/src/commands.rs");
const api = await read("src/lib/api.ts");
const nativeLaunch = await read("src/lib/nativeLaunch.ts");
const docStore = await read("src-tauri/src/doc_store.rs");

// --- open_external_file takes no path ---
const openFn = commands.match(/pub fn open_external_file\(([\s\S]*?)\) -> Result/);
check("open_external_file signature found", Boolean(openFn));
if (openFn) {
  const params = openFn[1];
  check("open_external_file takes no renderer path", !/\bpath\s*:\s*String/.test(params), params.replace(/\s+/g, " ").trim());
  check("open_external_file reads PendingLaunchFile", /PendingLaunchFile/.test(params) && /pending\.take\(\)/.test(commands));
}

check(
  "api.openExternalFile sends no path argument",
  /openExternalFile: \(\) =>\s*\n?\s*safeInvoke<Doc \| null>\("open_external_file"\)/.test(api),
  (api.match(/openExternalFile[\s\S]{0,120}?;/)?.[0] || "").replace(/\s+/g, " ")
);
check(
  "no caller passes a path to openExternalFile",
  !/openExternalFile\(\s*[^)\s]/.test(api) && !/api\.openExternalFile\(\s*[^)\s]/.test(nativeLaunch)
);
check("openNativeFile takes no path parameter", /async function openNativeFile\(\): Promise<void>/.test(nativeLaunch));

// --- doc_create is confined ---
const createDoc = docStore.match(/pub fn create_doc\(([\s\S]*?)\n    \}/);
check("create_doc body found", Boolean(createDoc));
check(
  "create_doc routes its path through resolve_in_vault",
  /resolve_in_vault/.test(docStore.slice(docStore.indexOf("pub fn create_doc"), docStore.indexOf("pub fn create_doc") + 1200))
);

// --- and the key-allowlist must stay hardcoded, not settings-derived ---
const probe = commands.slice(commands.indexOf("pub async fn provider_probe"), commands.indexOf("pub async fn provider_probe") + 1400);
check("provider_probe consults may_send_key", /may_send_key/.test(probe));
check("provider_probe only attaches the key when allowed", /if may_send_key\(&parsed\)/.test(probe));
check("provider_probe parses the endpoint as a URL", /reqwest::Url::parse/.test(probe));
check(
  "the key allowlist is a hardcoded constant, not read from settings",
  /const KEY_BEARING_HOSTS: &\[&str\]/.test(commands) && !/settings/.test(commands.slice(commands.indexOf("const KEY_BEARING_HOSTS"), commands.indexOf("const KEY_BEARING_HOSTS") + 400))
);
check("may_send_key does not consult localStorage-backed settings", !/app_settings|settings_store|localStorage/i.test(commands.slice(commands.indexOf("fn may_send_key"), commands.indexOf("fn may_send_key") + 600)));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);