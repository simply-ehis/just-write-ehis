/**
 * acl-parity — every Tauri command registered in `generate_handler!` must be
 * granted by at least one permission set.
 *
 * The permissions are maintained by hand in src-tauri/permissions/*.toml, and
 * a command that is registered but not granted fails at *runtime* with
 * "Command X not allowed by ACL" — not at compile time, and not on any
 * existing test. That is how `app_boot_ready` shipped denied: the boot gate
 * silently polled a command it could never call, every boot reported "backend
 * never reported ready", and the file watcher then timed out.
 *
 * Run: node tests/acl-parity.mjs (no build needed)
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(root, p), "utf8");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const lib = await read("src-tauri/src/lib.rs");

// Commands live in the generate_handler! macro invocation.
const handler = lib.match(/generate_handler!\[([\s\S]*?)\]\s*\)/);
check("generate_handler! block found", Boolean(handler));
if (!handler) {
  console.log("\n1 FAILED");
  process.exit(1);
}

const commands = [...handler[1].matchAll(/commands::([a-z0-9_]+)/g)].map((m) => m[1]);
check("commands parsed from handler", commands.length > 100, `${commands.length} commands`);

// The ACL is generated from THREE hand-maintained lists that must agree:
//   1. generate_handler!  in lib.rs   — what is registered
//   2. COMMANDS in build.rs           — what the permission manifest declares
//   3. allow-* in permissions/*.toml  — what each window is granted
// Forgetting (2) fails the *build*; forgetting (3) fails silently at runtime
// with "Command X not allowed by ACL", which is how the boot gate shipped
// broken. Both directions are checked.
const buildRs = await read("src-tauri/build.rs");
const manifest = [...buildRs.matchAll(/^\s*"([a-z0-9_]+)",?\s*$/gm)].map((m) => m[1]);
check("commands parsed from build.rs manifest", manifest.length > 100, `${manifest.length} commands`);

const registered = new Set(commands);
const notInManifest = commands.filter((c) => !manifest.includes(c));
check(
  "every handler command is declared in build.rs",
  notInManifest.length === 0,
  notInManifest.length ? `missing from COMMANDS: ${notInManifest.join(", ")}` : "all present"
);

const notRegistered = manifest.filter((c) => !registered.has(c));
check(
  "build.rs declares nothing that is not registered",
  notRegistered.length === 0,
  notRegistered.length ? `not in handler: ${notRegistered.join(", ")}` : "no orphans"
);

// Tauri derives the permission id from the command name:
// app_boot_ready -> allow-app-boot-ready
const toPermission = (cmd) => `allow-${cmd.replace(/_/g, "-")}`;

const permDir = join(root, "src-tauri/permissions");
const permFiles = (await readdir(permDir)).filter((f) => f.endsWith(".toml"));
const granted = new Map();
for (const f of permFiles) {
  const toml = await read(`src-tauri/permissions/${f}`);
  for (const m of toml.matchAll(/"(allow-[a-z0-9-]+)"/g)) {
    if (!granted.has(m[1])) granted.set(m[1], []);
    granted.get(m[1]).push(f);
  }
}
check("permission files parsed", permFiles.length > 0, permFiles.join(", "));

// Every registered command needs a grant somewhere, or it is dead on arrival.
const missing = commands.filter((c) => !granted.has(toPermission(c)));
check(
  "every registered command has an ACL grant",
  missing.length === 0,
  missing.length ? `missing: ${missing.map(toPermission).join(", ")}` : `${commands.length}/${commands.length} granted`
);

// No grant may point at a command that no longer exists (stale ACL entries).
const registeredPerms = new Set(commands.map(toPermission));
const stale = [...granted.keys()].filter((p) => !registeredPerms.has(p));
check("no stale ACL grants", stale.length === 0, stale.length ? stale.join(", ") : "none");

// The boot gate is on the main window's critical path; assert it explicitly so
// losing it is a named failure rather than a silent boot regression.
const mainToml = await read("src-tauri/permissions/main.toml");
check("main window may call the boot gate", mainToml.includes("allow-app-boot-ready"));

// And the frontend actually calls it, so the two cannot drift apart silently.
const app = await read("src/App.svelte");
check("App.svelte waits on the boot gate", app.includes("waitForBackendReady"));
const api = await read("src/lib/api.ts");
check("api.ts exposes appBootReady", api.includes("app_boot_ready"));

// The api.ts ↔ browserBackend mirror: the FOURTH list. A command missing a
// `case` here is silently absent from the browser preview — `safeInvoke` routes
// to `browserInvoke`, an unmatched name yields `undefined`, and callers treat
// that as data. `app_boot_ready` shipped exactly that way: the Rust command and
// its ACL were correct, but the preview resolved `false`, so the gate burned its
// full 8s budget on every preview load.
const backend = await read("src/lib/browserBackend.ts");
const mirrored = new Set([...backend.matchAll(/case\s+"([a-z0-9_]+)"/g)].map((m) => m[1]));
check(
  "browserBackend cases parsed",
  mirrored.size > 150,
  `${mirrored.size} cases`
);

// Everything the frontend can actually call must be mirrored. api.ts is the
// caller surface, so drive from it rather than from lib.rs: a registered
// command with no api.ts method needs no mirror.
//
// The command name is matched by anchoring on the real call site `>("name")`
// rather than on the generic argument. Two earlier attempts were both wrong in
// the same direction — `safeInvoke<[^>]+>` stops at the first `>` and misses
// every nested generic, and a fixed character window misses the calls whose
// inline object type is longer than the window. Both reported coverage they
// had not earned, while a genuinely unmirrored command would have slipped past.
const apiTs = await read("src/lib/api.ts");
const apiCommands = new Set(
  [...apiTs.matchAll(/safeInvoke(?:<[\s\S]{0,400}?>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1])
);
check(
  "api.ts commands parsed (176 measured: 177 safeInvoke mentions - 1 definition)",
  apiCommands.size >= 170,
  `${apiCommands.size} commands`
);

// Documented, intentional exemptions. Streaming cannot be mirrored into a
// localStorage backend, so aiGenerateStream deliberately routes through raw
// `invoke`. Exemptions are enumerated (never "whatever fails") and each one
// must still be justified by a comment, so the list cannot quietly grow.
const EXEMPT = {
  ai_generate_stream: "streaming falls back to one shot; no preview case",
};
const unmirrored = [...apiCommands].filter((c) => !mirrored.has(c));
const unexpected = unmirrored.filter((c) => !(c in EXEMPT));
check(
  "every api.ts command has a browserBackend case, or a documented exemption",
  unexpected.length === 0,
  unexpected.length ? `unmirrored: ${unexpected.join(", ")}` : `${apiCommands.size} api.ts commands all mirrored`
);
check(
  "documented exemptions are still justified in api.ts",
  Object.keys(EXEMPT).every((c) => apiTs.includes(`"${c}" browser case exists`)),
  Object.entries(EXEMPT).map(([k, v]) => `${k}: ${v}`).join("; ")
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
