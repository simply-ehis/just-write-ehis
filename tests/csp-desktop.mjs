/**
 * csp-desktop — the desktop CSP must allow what the built bundle actually
 * uses, and must not have been loosened by accident.
 *
 * The browser build has no CSP, so `npm run test:smoke`'s zero-console-error
 * bar never exercised this. The Tauri shell did: Vite inlines any woff2 under
 * 8 KB as a `data:` URI (the small `latin-ext`/`cyrillic` subsets), while
 * `font-src 'self'` blocked them — 12 inlined font faces in the current
 * bundle. The result was a console error per face on every boot and silent
 * fallback to a system font for those glyphs, in an app whose whole point is
 * typography. `img-src` and `media-src` already listed `data:`/`blob:`;
 * `font-src` had simply been missed.
 *
 * Run: node tests/csp-desktop.mjs (no build needed; reads dist/ if present)
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

const conf = JSON.parse(await read("src-tauri/tauri.conf.json"));
const csp = conf.app?.security?.csp;
check("tauri.conf.json parses and declares a CSP", typeof csp === "string" && csp.length > 0);

const directives = new Map(
  csp
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const [name, ...values] = d.split(/\s+/);
      return [name, values];
    })
);
check("CSP directives parsed", directives.size >= 8, `${directives.size} directives`);

const allows = (directive, source) => (directives.get(directive) ?? []).includes(source);

// --- The regression: inlined data: fonts must be permitted. ---
check("font-src allows data: (Vite inlines small woff2)", allows("font-src", "data:"));
check("font-src still allows 'self'", allows("font-src", "'self'"));

// --- Other bundled asset shapes. ---
check("img-src allows data: (reader/publish inline images)", allows("img-src", "data:"));
check("img-src allows blob:", allows("img-src", "blob:"));
check("media-src allows blob: (TTS playback)", allows("media-src", "blob:"));

// --- Tauri IPC and the loopback sidecars must stay reachable. ---
check("connect-src allows ipc:", allows("connect-src", "ipc:"));
check("connect-src allows http://ipc.localhost", allows("connect-src", "http://ipc.localhost"));

// The four sidecar ports, named explicitly. Every sidecar call is proxied
// through Rust, so the webview needs no loopback access at all — what a
// wildcard (`http://127.0.0.1:*`) actually granted was reachability to every
// other listener on the machine: an unauthenticated Ollama, a Docker daemon, a
// stray dev server. Narrowing it is only meaningful if it stays narrow.
const SIDECAR_PORTS = ["8090", "8091", "8092", "8093"];
const missingPorts = SIDECAR_PORTS.filter((p) => !allows("connect-src", `http://127.0.0.1:${p}`));
check(
  "connect-src allows each sidecar port explicitly",
  missingPorts.length === 0,
  missingPorts.length ? `missing ${missingPorts.join(", ")}` : SIDECAR_PORTS.join(", ")
);
const wildcardLoopback = (directives.get("connect-src") ?? []).filter(
  (v) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\*)?$/.test(v) || /^https?:\/\/(127\.0\.0\.1|localhost):\d+-\d+$/.test(v)
);
check(
  "connect-src grants no wildcard loopback range",
  wildcardLoopback.length === 0,
  wildcardLoopback.join(", ") || "none"
);

// A retired endpoint must not linger in the allowlist.
check(
  "retired Ollama endpoint is not re-allowed",
  !(directives.get("connect-src") ?? []).some((v) => v.includes("11434")),
  (directives.get("connect-src") ?? []).filter((v) => v.includes("11434")).join(", ") || "absent"
);

// The cloud providers the app actually talks to must remain reachable — an
// over-eager narrowing here would silently break AI, which is the regression
// this test exists to prevent in both directions.
for (const host of [
  "https://api.anthropic.com",
  "https://api.openai.com",
  "https://api.groq.com",
  "https://api.deepseek.com",
  "https://openrouter.ai",
  "https://nominatim.openstreetmap.org",
  "https://api.open-meteo.com",
]) {
  check(`connect-src still allows ${host.replace("https://", "")}`, allows("connect-src", host));
}

// --- Must not have been loosened while fixing the above. ---
check("script-src has no unsafe-inline", !(directives.get("script-src") ?? []).includes("'unsafe-inline'"));
check("script-src has no unsafe-eval", !(directives.get("script-src") ?? []).includes("'unsafe-eval'"));
check("object-src is 'none'", (directives.get("object-src") ?? []).join(" ") === "'none'");
check("base-uri is 'self'", (directives.get("base-uri") ?? []).join(" ") === "'self'");
check(
  "no remote script/frame sources",
  !(directives.get("script-src") ?? []).some((v) => /^https?:/.test(v)) &&
    !(directives.get("default-src") ?? []).some((v) => /^https?:/.test(v))
);

// --- Grounded in the real bundle when one is available. ---
let blocked = 0;
let scanned = 0;
try {
  const files = await readdir(join(root, "dist/assets"));
  for (const f of files.filter((f) => f.endsWith(".css"))) {
    const css = await read(`dist/assets/${f}`);
    scanned++;
    const usesDataFont = /data:font/.test(css);
    if (usesDataFont && !allows("font-src", "data:")) blocked += usesDataFont ? 1 : 0;
  }
  check("dist/assets present to cross-check", scanned > 0, `${scanned} css files`);
  check("no built stylesheet uses a font source the CSP blocks", blocked === 0, blocked ? `${blocked} blocked` : "clean");
} catch {
  console.log("SKIP  dist/assets unavailable — static assertions only");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);