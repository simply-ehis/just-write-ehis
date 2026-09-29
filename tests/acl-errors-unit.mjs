/**
 * acl-errors-unit — the ACL-denial vocabulary actually matches denials.
 *
 * Bundles src/lib/errors.ts (esbuild ships with vite) and asserts:
 * 1. isAclDenied matches Tauri's "not allowed" rejections, ignores ordinary errors.
 * 2. aclDeniedMessage names the command and points at the window ACL.
 * 3. api.ts routes Tauri denials through aclDeniedMessage (source check —
 *    safeInvoke is the single choke point, so every command benefits).
 * 4. App.svelte probes one cheap command at startup and banners loudly.
 *
 * Run: npm run test:aclerrors (part of npm run test:source)
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Backend stores touch localStorage at import: stub it before anything loads.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  };
}

const esbuild = await import("esbuild");
const outdir = join(root, "tests", ".tmp-acl");
await mkdir(outdir, { recursive: true });
async function bundle(entry, out) {
  const outfile = join(outdir, out);
  await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "error",
    alias: { $lib: join(root, "src/lib") },
  });
  return import(pathToFileURL(outfile).href);
}
const errors = await bundle("src/lib/errors.ts", "errors.mjs");
const { mapInvokeError } = await bundle("src/lib/api.ts", "api.mjs");

check("matches Tauri denial", errors.isAclDenied(new Error('Cannot invoke "doc_save": not allowed by ACL')));
check("matches bare string denial", errors.isAclDenied("not permitted"));
check(
  "ignores ordinary errors",
  !errors.isAclDenied(new Error("vault missing")) && !errors.isAclDenied("timeout") && !errors.isAclDenied("tackle box")
);
const msg = errors.aclDeniedMessage("doc_save", new Error("not allowed"));
check("denial message names command + fix", msg.includes('"doc_save"') && msg.includes("window ACL"), msg);

// Behavioral: the safeInvoke mapping names the blocked command…
const mapped = mapInvokeError("doc_save", new Error("not allowed"));
check(
  "denial maps to named readable error",
  mapped instanceof Error && mapped.message.includes('"doc_save"') && mapped.message.includes("window ACL")
);
// …and passes anything else through untouched.
const other = new Error("boom");
check("non-denials pass through", mapInvokeError("doc_save", other) === other);

const app = await readFile(join(root, "src/App.svelte"), "utf8");
check(
  "startup probes then banners then bails, in order",
  /getVaultPath\(\)[\s\S]*?isAclDenied[\s\S]*?App permissions are misconfigured[\s\S]*?return/.test(app)
);

// Remove the esbuild scratch bundle — never leave build trash behind.
await rm(join(root, "tests", ".tmp-acl"), { recursive: true, force: true });
console.log(failures === 0 ? "\nacl-errors-unit: all checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
