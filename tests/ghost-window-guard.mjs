/**
 * Ghost-window guard.
 *
 * The desktop frontend is embedded in the Tauri binary, so a service worker
 * has nothing to make resilient — but it can brick the shell. A cache-first
 * worker survives upgrades (its cache name never changed), so after an app
 * update it kept serving a cached index.html that pointed at content-hashed
 * chunks the new build no longer shipped. The entry module then loaded as
 * text/html and never executed: #app stayed empty, showMainWindow() never ran,
 * and the hidden main window was never revealed. A ghost window with a dead
 * frontend — which also took every IPC command with it (AI, STT/TTS/LLM,
 * memory, the Typst binary, the widget).
 *
 * These assertions are static so they run in CI without a build or a display.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(root, path), "utf8");
let failures = 0;

function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

const html = await read("index.html");
const sw = await read("public/sw.js");

// The Tauri check must gate registration. `window.__TAURI_INTERNALS__` is
// injected synchronously; `window.isTauri` is the API-level equivalent.
check(
  "index.html detects the Tauri shell",
  html.includes("__TAURI_INTERNALS__") && html.includes("isTauri")
);

// Registration must be reachable only from the non-Tauri branch: a guarded
// call inside an early-return, not a bare top-level register().
const registerCalls = html.match(/navigator\.serviceWorker\.register/g) ?? [];
check("index.html registers the worker exactly once, for web/PWA", registerCalls.length === 1);

const registerIndex = html.indexOf("navigator.serviceWorker.register");
check("index.html still registers the worker for web/PWA", registerIndex !== -1);

// A service worker script must not register itself; the page owns registration.
check("sw.js does not self-register", !/serviceWorker\.register/.test(sw));

if (registerIndex !== -1) {
  // Everything between the guard and the register call must be the Tauri
  // early-return, so the desktop branch can never fall through to register.
  const guardIndex = html.indexOf("var inTauri");
  const returnIndex = html.indexOf("return;", guardIndex);
  check("registration is guarded by a Tauri early return", guardIndex !== -1 && returnIndex !== -1 && returnIndex < registerIndex);
  // A poisoned install keeps being controlled by the old worker until it is
  // unregistered, so the desktop branch must actively unregister.
  check(
    "desktop branch unregisters any pre-existing worker (heals old installs)",
    html.indexOf("getRegistrations") !== -1 && html.indexOf("unregister") !== -1
  );
  check("desktop branch clears stale caches", html.includes("caches.keys") && html.includes("caches.delete"));
}

// Documents must never be served cache-first. A cached document outliving its
// hashed chunks is the exact mechanism that produced the ghost window, so the
// worker must have a dedicated document branch that hits the network first and
// only treats the cache as the offline fallback.
check("sw.js has a dedicated document-request branch", sw.includes("isDocumentRequest"));
const docBranchStart = sw.indexOf("if (isDocumentRequest(request))");
const hashedBranchStart = sw.indexOf("if (isHashedAsset(url))");
const genericBranchStart = sw.indexOf("event.respondWith(\n    caches.match(request)");
check(
  "document branch runs before any cache-first branch",
  docBranchStart !== -1 && hashedBranchStart !== -1 && genericBranchStart !== -1 &&
    docBranchStart < hashedBranchStart &&
    hashedBranchStart < genericBranchStart
);
const docBranch = sw.slice(docBranchStart, hashedBranchStart);
check(
  "document branch fetches from network first and only falls back to cache",
  docBranch.indexOf("fetch(request)") !== -1 &&
    docBranch.indexOf("fetch(request)") < docBranch.indexOf("caches.match(request)")
);

// Cache names must be versioned so an upgrade retires the previous cache.
const cacheName = sw.match(/CACHE_VERSION\s*=\s*'([^']+)'/);
check("sw.js cache name is versioned", Boolean(cacheName), cacheName?.[1]);
check(
  "activate drops caches from previous versions",
  /filter\(\(name\) => name !== CACHE_NAME\)/.test(sw)
);

// A leftover unversioned cache name is the bug itself; make it unrepeatable.
check("no unversioned 'just-write-ehis-v2' cache name", !/just-write-ehis-v2/.test(sw));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
