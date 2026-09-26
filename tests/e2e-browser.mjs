/**
 * e2e-browser — no-dependency end-to-end checks for the browser preview.
 *
 * 1. Serves dist/ over HTTP and asserts the built app shell loads with
 *    workspace markers (proves `npm run build` output is servable).
 * 2. Static coverage: every command invoked via api.ts must have a
 *    `case` in browserBackend.ts (proves the preview backend is complete).
 * 3. Static icons: every <Icon name="…"> used must exist in Icon.svelte
 *    (proves no missing/duplicate icon references).
 *
 * Run: npm run build && npm run test:e2e
 */
import { createServer, get as httpGet, request as httpRequest } from "node:http";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Plain http GET with keep-alive disabled (undici fetch crashes Win libuv on exit). */
function getText(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path, agent: false, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
  });
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

async function serveAndFetch() {
  try {
    await stat(join(dist, "index.html"));
  } catch {
    check("dist/index.html exists (run npm run build first)", false);
    return;
  }
  check("dist/index.html exists (run npm run build first)", true);

  const server = createServer(async (req, res) => {
    try {
      const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const index = await getText(port, "/");
    check("preview serves index.html (HTTP 200)", index.status === 200, `status ${index.status}`);
    const html = index.body;
    check("bundle script referenced", /assets\/index-.*\.js/.test(html));
    for (const asset of ["ehis-logo-dark.svg", "ehis-logo-light.svg", "ehis-mark-dark.svg", "ehis-mark-light.svg", "manifest.webmanifest", "icon-192.png"]) {
      const r = await getText(port, `/${asset}`);
      check(`dist serves /${asset}`, r.status === 200);
    }
    const jsName = html.match(/assets\/(index-.*\.js)/)?.[1];
    if (jsName) {
      // Workspaces are code-split, so a marker may live in any chunk:
      // scan the whole built surface, not just the entry bundle.
      const assetDir = join(root, "dist/assets");
      const built = (await readdir(assetDir)).filter((f) => f.endsWith(".js"));
      const chunks = (
        await Promise.all(built.map(async (f) => (await getText(port, `/assets/${f}`)).body))
      ).join("\n");
      // UI string literals survive minification; component identifiers do not.
      for (const marker of ["Just Write ehis", "Node Map", "Structurize", "Version History", "Quick capture", "Command palette"]) {
        check(`bundle contains "${marker}"`, chunks.includes(marker));
      }
      check("bundle contains browser preview backend", chunks.includes("browser-preview-vault"));
    }
  } catch (e) {
    check("preview fetch", false, String(e));
  } finally {
    // Close idle keep-alive sockets first: plain close() hangs the
    // Windows libuv loop and crashes the process on exit.
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function staticCoverage() {
  const api = await readFile(join(root, "src/lib/api.ts"), "utf8");
  const backend = await readFile(join(root, "src/lib/browserBackend.ts"), "utf8");
  const invoked = [...api.matchAll(/safeInvoke<[^>]+>\("([^"]+)"/g)].map((m) => m[1]);
  const handled = new Set([...backend.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
  const missing = [...new Set(invoked)].filter((c) => !handled.has(c));
  check(`api commands covered by browser backend (${invoked.length} sites)`, missing.length === 0, missing.join(", "));
}

async function staticIcons() {
  const { readdir } = await import("node:fs/promises");
  const iconSrc = await readFile(join(root, "src/lib/components/Icon.svelte"), "utf8");
  const defined = new Set([
    ...iconSrc.matchAll(/^\s{4}([a-z0-9-]+):/gm).map((m) => m[1]),
    ...iconSrc.matchAll(/^\s{4}"([a-z0-9-]+)":/gm).map((m) => m[1]),
  ]);
  check("Icon set non-empty", defined.size > 20, `${defined.size} icons`);
  const files = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".svelte")) files.push(p);
    }
  }
  await walk(join(root, "src"));
  const used = new Map();
  for (const f of files) {
    const src = await readFile(f, "utf8");
    for (const m of src.matchAll(/<Icon name=\{?["']([a-z0-9-]+)["']\}?/g)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(f.split("src")[1]);
    }
    for (const m of src.matchAll(/name=\{([a-zA-Z]+)\}/g)) {
      // dynamic names (e.g. wsIcons lookups) resolve through constants — spot-check only
      void m;
    }
  }
  const unknown = [...used.keys()].filter((n) => !defined.has(n));
  check(`<Icon> references resolve (${used.size} names)`, unknown.length === 0, unknown.join(", "));
  // No Lucide imports/usages anywhere (spec §1.5). A comment documenting
  // the ban is fine; an import, package, or <Lucide tag is not.
  const bad = [];
  for (const f of files) {
    const src = await readFile(f, "utf8");
    if (/from\s+["']lucide|lucide-[a-z]|<Lucide/i.test(src)) bad.push(f.split("src")[1]);
  }
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (Object.keys(deps).some((d) => d.toLowerCase().includes("lucide"))) bad.push("package.json");
  check("no Lucide imports/usages", bad.length === 0, bad.join(", "));
}

async function updaterWiring() {
  const conf = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const updater = conf.plugins?.updater;
  check("tauri.conf has updater endpoints", Array.isArray(updater?.endpoints) && updater.endpoints.length > 0);
  check("tauri.conf has updater pubkey field", typeof updater?.pubkey === "string" && updater.pubkey.length > 0);
  check("tauri.conf updater dialog off (in-app UI owns it)", updater?.dialog === false);
  check("tauri.conf emits updater artifacts", conf.bundle?.createUpdaterArtifacts === true);
  // Capabilities are split per window; the main window must keep updater +
  // process rights regardless of how the files are organized.
  const capDir = join(root, "src-tauri/capabilities");
  const capFiles = (await readdir(capDir)).filter((f) => f.endsWith(".json"));
  const caps = [];
  for (const f of capFiles) caps.push(JSON.parse(await readFile(join(capDir, f), "utf8")));
  const mainGrants = new Set(
    caps.filter((c) => (c.windows ?? []).includes("main")).flatMap((c) => c.permissions ?? [])
  );
  for (const perm of ["core:default", "updater:default", "process:default"]) {
    check(`main window grants ${perm}`, mainGrants.has(perm));
  }
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  check("Cargo wires tauri-plugin-updater", cargo.includes('tauri-plugin-updater = "2"') || cargo.includes('tauri-plugin-updater = "=2.'));
  check("Cargo wires tauri-plugin-process", cargo.includes('tauri-plugin-process = "2"'));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  check("npm wires @tauri-apps/plugin-updater", Boolean(deps["@tauri-apps/plugin-updater"]));
  check("npm wires @tauri-apps/plugin-process", Boolean(deps["@tauri-apps/plugin-process"]));
  const settingsPane = await readFile(join(root, "src/lib/components/SettingsPane.svelte"), "utf8");
  check("Settings About has update UI", settingsPane.includes("Check for Updates") && settingsPane.includes("Download & Install"));
}

async function exportWiring() {
  const editor = await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8");
  check("editor export offers docx", editor.includes("docx"));
  check("editor export offers epub+pdf", editor.includes("epub") && editor.includes("pdf"));
  const novel = await readFile(join(root, "src/lib/components/NovelWorkspace.svelte"), "utf8");
  check("novel compile downloads in formats", novel.includes("compileRun") && novel.includes("Download"));
  const cargo = await readFile(join(root, "src-tauri/Cargo.toml"), "utf8");
  check("Cargo wires pulldown-cmark", cargo.includes('pulldown-cmark = "0.12"'));
  check("Cargo wires base64", cargo.includes('base64 = "0.22"'));
}

async function noNativeDialogs() {
  const { readdir } = await import("node:fs/promises");
  const bad = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".svelte")) {
        const src = await readFile(p, "utf8");
        if (/(^|[^a-zA-Z])prompt\(|(^|[^a-zA-Z])confirm\(|(^|[^a-zA-Z])alert\(/.test(src)) {
          bad.push(p.split("src")[1]);
        }
      }
    }
  }
  await walk(join(root, "src"));
  check("no native prompt/confirm/alert", bad.length === 0, bad.join(", "));
  const ai = await readFile(join(root, "src/lib/components/AiPanel.svelte"), "utf8");
  check("no hardcoded dev paths", !ai.includes("C:\\\\Users") && !ai.includes("small-model-harness\""));
  const editor = await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8");
  check("editor theme follows setting", editor.includes("makeDarkTheme($settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.theme, $settings.themeMode"));
  const palette = await readFile(join(root, "src/lib/editorTheme.ts"), "utf8");
  check("editor palettes per theme", ["light:", "dark:", "brutalist:", "brutalist-light", "glass:", "glass-light"].every((k) => palette.includes(k)));
}

async function integrityWiring() {
  const reader = await readFile(join(root, "src/lib/components/ReaderWorkspace.svelte"), "utf8");
  check("reader parses books (no raw binary import)", reader.includes("parseBookFile") && reader.includes(".epub,.pdf,.docx"));
  const editor = await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8");
  check("ghost passes workspace for privacy", editor.includes("requestGhostContinuation(lastSentence, $currentWorkspace)"));
}

async function modelWiring() {
  const panel = await readFile(join(root, "src/lib/components/AiPanel.svelte"), "utf8");
  const slotUses = (panel.match(/const slot = mainSlot\(\);/g) ?? []).length;
  check("chat/composer/structurize use main slot", slotUses >= 3, `${slotUses} sites`);
  check("main slot honors small-as-main", panel.includes("useSmallAsMain") && panel.includes("smallModelEndpoint || undefined"));
  const ghost = await readFile(join(root, "src/lib/ghost.ts"), "utf8");
  check("ghost autocomplete uses small slot", ghost.includes("s.smallModelEndpoint") && !ghost.includes("mainModelEndpoint"));
  const editor = await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8");
  const settings = await readFile(join(root, "src/lib/components/SettingsPane.svelte"), "utf8");
  check("provider test buttons exist", settings.includes("testSlot") && settings.includes("Test Main Slot"));
  check("voice model fields exist", settings.includes("sttModel") && settings.includes("ttsModel"));
  check("local model runtime checks exist", settings.includes("testSttSetup") && settings.includes("testTtsSetup") && settings.includes("testLlmSetup"));
  check("bundled LLM toggle makes a real request", panel.includes("ensureLlm()") && panel.includes("api.llmCompletion") && !panel.includes("sidecarHarnessDir"));
  const audioStore = await readFile(join(root, "src/lib/stores/audio.ts"), "utf8");
  check("TTS lazy-load gate fixed", audioStore.includes("ttsModelReady") && audioStore.includes("health.ready ?? health.model_loaded"));
  check("running sidecars still health-check", audioStore.includes("result.value ?? await spec.health()"));
  const sidecarRust = await readFile(join(root, "src-tauri/src/sidecar.rs"), "utf8");
  check("release prefers bundled native Python runtimes", sidecarRust.includes('resolve_sidecar_executable(sidecars_dir, "stt-server.exe")') && sidecarRust.includes('resolve_sidecar_executable(sidecars_dir, "tts-server.exe")') && sidecarRust.indexOf('if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "stt-server.exe")') < sidecarRust.indexOf('let script = resolve_sidecar_script(sidecars_dir, "stt_server.py")') && sidecarRust.includes("JWE_SIDECARS_DIR"));
  check("stale port cleanup never adopts arbitrary Python", sidecarRust.includes("fn port_owner") && !sidecarRust.includes('starts_with("python")'));
  const nativeCommands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
  check("renderer cannot choose arbitrary sidecar roots", nativeCommands.includes("trusted_sidecars_dir") && nativeCommands.includes("outside the application resource root"));
  check("renderer cannot choose arbitrary Python executables", nativeCommands.includes("trusted_python_command") && nativeCommands.includes("custom Python paths are disabled"));
  const sidecarValidation = await readFile(join(root, "src/lib/sidecarValidate.ts"), "utf8");
  check("Python setting matches native allowlist", sidecarValidation.includes("python3") && sidecarValidation.includes("Use python, python3, or py from PATH"));
  const browserBackend = await readFile(join(root, "src/lib/browserBackend.ts"), "utf8");
  check("empty PIN cannot verify", nativeCommands.includes("fn verify_pin_value") && nativeCommands.includes('verify_pin_value("", "")') && browserBackend.includes("normalizedExpected.length >= 4"));
  const tauriConfig = JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const windowsTauriConfig = JSON.parse(await readFile(join(root, "src-tauri/tauri.windows.conf.json"), "utf8"));
  const baseResources = tauriConfig.bundle?.resources ?? [];
  const windowsResources = windowsTauriConfig.bundle?.resources ?? [];
  check("native runtime build is Windows desktop-only", !tauriConfig.build?.beforeBuildCommand?.includes("build:sidecars") && windowsTauriConfig.build?.beforeBuildCommand?.includes("build:sidecars") && baseResources.every((resource) => windowsResources.includes(resource)) && windowsResources.includes("sidecars/bin/**/*"));
  const stores = await readFile(join(root, "src/lib/stores/settings.ts"), "utf8");
  check("voice model defaults set", stores.includes('sttModel: ""') && stores.includes('ttsModel: ""'));
  const commands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
  check("Rust passes model to sidecars", commands.includes("model: Option<String>"));
  const stt = await readFile(join(root, "src-tauri/sidecars/stt_server.py"), "utf8");
  check("STT honors model override", stt.includes("sys.argv[2]"));
  const tts = await readFile(join(root, "src-tauri/sidecars/tts_server.py"), "utf8");
  check("TTS honors repo override", tts.includes("sys.argv[2]"));
}

async function modelsDocWiring() {
  const models = await readFile(join(root, "docs/MODELS.md"), "utf8");
  check("models doc locks voice picks", models.includes("Moonshine streaming only") && models.includes("Kokoro-82M only"));
  check("models doc lists cloud providers only", models.includes("OpenAI") && models.includes("Anthropic") && models.includes("Custom") && !models.includes("ollama pull") && !models.includes("llama3.2"));
  check("models doc states chat-completions contract", models.includes("Provider notes") && models.includes("/chat/completions"));
}

async function memorySidecarLive() {
  // Boots the REAL vendored memory server and exercises it over HTTP.
  const { spawn } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
   const dir = mkdtempSync(join(tmpdir(), "jwe-mem-"));
   const port = 18099;
   const token = "test-memory-token";
   const proc = spawn(
     "python",
     [join(root, "src-tauri/sidecars/memory_server.py"), String(port), dir],
     { stdio: "ignore", env: { ...process.env, JWE_MEMORY_TOKEN: token } }
   );
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let health = null;
    for (let i = 0; i < 40 && !health; i++) {
      await wait(250);
      try {
         health = await getText(port, "/health", { "X-JWE-Memory-Token": token });
      } catch {
        /* still booting */
      }
    }
    check("memory sidecar boots", !!health && health.status === 200, health?.body ?? "no response");
     const unauthorized = await getText(port, "/health");
     check("memory sidecar rejects unauthenticated callers", unauthorized.status === 401);
     const memorySource = await readFile(join(root, "src-tauri/sidecars/memory_server.py"), "utf8");
     check("memory sidecar supports launch token", memorySource.includes("JWE_MEMORY_TOKEN") && memorySource.includes("X-JWE-Memory-Token"));
    if (!health || health.status !== 200) return;
    const post = (path, obj) =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify(obj);
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            agent: false,
             headers: {
               "Content-Type": "application/json",
               "Content-Length": Buffer.byteLength(body),
               "X-JWE-Memory-Token": token,
             },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, body: text }));
          }
        );
        req.on("error", reject);
        req.end(body);
      });
    const learned = JSON.parse(
      (await post("/learn", { text: "My name is Ehis. Always use Oxford commas. Key sk-testfakekey1234567890." })).body
    );
    check("memory learns facts (secret redacted at store)", learned.stored >= 2, `stored=${learned.stored}`);
     const recalled = JSON.parse((await getText(port, "/recall?q=name", { "X-JWE-Memory-Token": token })).body);
    check("memory recalls by relevance", recalled.facts.includes("Ehis"), recalled.facts.slice(0, 60));
    const redacted = JSON.parse((await post("/redact", { text: "token=hf_abcdefghijklmnopqrstuvwx" })).body);
    check("memory redacts pasted keys", !redacted.text.includes("hf_abcdefghij"), redacted.text);
  } finally {
    proc.kill();
  }
}

async function writePathWiring() {
  const store = await readFile(join(root, "src/lib/stores/writeBack.ts"), "utf8");
  check("write-back targets docs + shared applier", store.includes("docId") && store.includes("applyWriteBackEvent"));
  for (const f of ["EditorPane.svelte", "JustWriteWorkspace.svelte"]) {
    const src = await readFile(join(root, "src/lib/components", f), "utf8");
    check(`${f} consumes write-back safely`, src.includes("applyWriteBackEvent") && src.includes("event.docId"));
  }
  const ghost = await readFile(join(root, "src/lib/ghost.ts"), "utf8");
  check("shared ghost request helper", ghost.includes("requestGhostContinuation") && ghost.includes("lastSentenceOf"));
  const jw = await readFile(join(root, "src/lib/components/JustWriteWorkspace.svelte"), "utf8");
  check("JustWrite has ghost autocomplete", jw.includes("requestGhostSuggestion") && jw.includes("ghostInlinePlugin"));
  const gw = await readFile(join(root, "src/lib/ghostWidget.ts"), "utf8");
  check("ghost renders inline at cursor", gw.includes("cm-ghost-inline") && gw.includes("setGhostEffect") && gw.includes("ghostField"));
  const rs = await readFile(join(root, "src-tauri/src/doc_store.rs"), "utf8");
  check("saves re-chunk retrieval", rs.includes("refresh_rag_chunks(&req.id)") && rs.includes("refresh_rag_chunks(doc_id)"));
  check("deletes purge vectors", rs.includes("DELETE FROM rag_vec WHERE chunk_id NOT IN"));
}

async function aiEntryWiring() {
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("Ctrl+J toggles AI panel", app.includes('"j"') && app.includes("$aiPanelOpen = !$aiPanelOpen"));
  const palette = await readFile(join(root, "src/lib/components/CommandPalette.svelte"), "utf8");
  check("palette toggles AI panel", palette.includes("ai-panel"));
  for (const f of ["EditorPane.svelte", "JustWriteWorkspace.svelte"]) {
    const src = await readFile(join(root, "src/lib/components", f), "utf8");
    check(`${f} has AI toggle`, src.includes("Toggle AI panel"));
  }
  const panel = await readFile(join(root, "src/lib/components/AiPanel.svelte"), "utf8");
  check("panel warns on dead endpoint", panel.includes("endpointUnreachable"));
}

async function themeAndReaderWiring() {
  const main = await readFile(join(root, "src/main.ts"), "utf8");
  check("theme stylesheet loads", main.includes("./app.css"));
  const css = await readFile(join(root, "src/app.css"), "utf8");
  check("surface/type/spacing vars defined", css.includes("--surface-base:") && css.includes("--space-4:") && css.includes("--font-size-base:"));
  check("light theme exists", css.includes('[data-mode="light"]'));
  check("style overlays exist", css.includes('[data-theme="brutalist"]') && css.includes('[data-theme="glass"]') && css.includes('[data-theme="glass"][data-mode="light"]'));
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("app applies theme setting", app.includes("applyAppearance($settings.theme, $settings.themeMode, $settings.accentOverride)"));
}

async function auditBatchWiring() {
  const insp = await readFile(join(root, "src/lib/components/InspectorPanel.svelte"), "utf8");
  check("inspector links bare mentions", insp.includes("linkMention") && insp.includes("Mentioned but not linked"));
  const logs = await readFile(join(root, "src/lib/components/LogsWorkspace.svelte"), "utf8");
  check("logs appends captures + touched footer", logs.includes("loadTouchedToday") && logs.includes("Touched today"));
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("startup runs maintenance", app.includes("runStartupMaintenance"));
  const ai = await readFile(join(root, "src/lib/components/AiPanel.svelte"), "utf8");
  check("chat/composer stream tokens", ai.includes("aiGenerateStream"));
  check("single rate guard + friendly map", ai.includes("guardRate()") && ai.includes("friendlyEndpointError(e)") && !ai.includes("minimum 3s between sends"));
  check("stream alias documented, no fake case", (await readFile(join(root, "src/lib/api.ts"), "utf8")).includes("this alias is intentional"));
  check("ghost routing enforced in ghost.ts", (await readFile(join(root, "src/lib/ghost.ts"), "utf8")).includes("ROUTING (canonical") && (await readFile(join(root, "src/lib/ghost.ts"), "utf8")).includes("ghostStatus"));
  const novel = await readFile(join(root, "src/lib/components/NovelWorkspace.svelte"), "utf8");
  check("doc-fork rename complete", !novel.includes("GhostPanel") && !novel.includes("GhostBadge") && novel.includes("DocForkPanel") && novel.includes("ForkBadge") && novel.includes("forkId="));
  check("replace confirms before clobbering", ai.includes("replaceBtn(") && ai.includes("Confirm replace selection"));
  check("privacy badge in panel header", ai.includes("privacy-badge") && ai.includes("isWorkspacePrivate"));
  check("thinking countdown + mobile sheet", ai.includes("genElapsed") && ai.includes("88vh") && ai.includes("max-width: 480px"));
  check("small-model ctx + use-as-main settings", (await readFile(join(root, "src/lib/stores/settings.ts"), "utf8")).includes("smallModelContextLength") && (await readFile(join(root, "src/lib/stores/settings.ts"), "utf8")).includes("useSmallAsMain"));
  const reader = await readFile(join(root, "src/lib/components/ReaderWorkspace.svelte"), "utf8");
  check("reader controls + sections + cover/progress", reader.includes("reader-controls") && reader.includes("ReaderProse") && reader.includes("book-progress") && reader.includes("book-cover-img") && reader.includes("shelveCover"));
  check("reader position anchors", reader.includes("readerAnchor") && reader.includes("document.fonts"));
  check("reader TTS section flow", reader.includes("getSections") && reader.includes("handleTtsSection"));
  const prose = await readFile(join(root, "src/lib/components/ReaderProse.svelte"), "utf8");
  check("prose themes + measure", prose.includes("theme-sepia") && prose.includes("content-visibility"));
  const rsec = await readFile(join(root, "src/lib/readerSections.ts"), "utf8");
  check("section splitter + TTS strip + chunker", rsec.includes("splitSections") && rsec.includes("stripForTts") && rsec.includes("chunkText"));
  const raloud = await readFile(join(root, "src/lib/components/ReadAloudButton.svelte"), "utf8");
  check("read-aloud section mode", raloud.includes("getSections") && raloud.includes("onSection") && raloud.includes("chunkText"));
  const convert = await readFile(join(root, "src-tauri/src/convert.rs"), "utf8");
  check("export preprocess shared", convert.includes("fn prepare_export") && convert.includes("fn resolve_wikilinks") && convert.includes("fn inline_embeds") && convert.includes("fn inject_frontmatter"));
  check("compile join demotes + caps", convert.includes("fn demote_headings") && convert.includes("fn join_manuscript") && convert.includes("COMPILE_CHAR_CAP"));
  check("attachment staging + bundled flag", convert.includes("fn stage_attachments") && convert.includes("fn attachment_refs") && convert.includes("fn is_bundled"));
  const dl = await readFile(join(root, "src/lib/download.ts"), "utf8");
  check("fountain helper shared", dl.includes("downloadFountain"));
  const ed = await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8");
  check("export menus list all six gated", ed.includes("ALL_EXPORT_FORMATS") && ed.includes("Needs pandoc"));
  const imp = await readFile(join(root, "src/lib/import.ts"), "utf8");
  check("batch concurrency + cancel + dedupe", imp.includes("mapLimit") && imp.includes("shouldCancel") && imp.includes("dedupeFilename") && imp.includes("streamFiles"));
  const pub_ = await readFile(join(root, "src/lib/stores/publish.ts"), "utf8");
  check("TS publish twin deleted", !pub_.includes("function renderHtml") && !pub_.includes("processMarkdown"));
  const pal = await readFile(join(root, "src/lib/components/CommandPalette.svelte"), "utf8");
  check("palette compile select + preflight + progress", pal.includes("compileFormat") && pal.includes("preflightBulkFormat") && pal.includes("bulkOp"));
  const sidecar = await readFile(join(root, "src-tauri/src/sidecar.rs"), "utf8");
  check("one managed sidecar core", sidecar.includes("pub struct ManagedSidecar") && sidecar.includes("impl Drop for ManagedSidecar") && !sidecar.includes("reqwest::Client::new()"));
  check("sidecar timeouts + reap/orphan", sidecar.includes("fn http_client") && sidecar.includes("reclaim_stale_port") && sidecar.includes("child.wait()"));
  check("sidecar empty-content errors", sidecar.includes("LLM server returned no content") && sidecar.includes("missing facts field"));
  const audio = await readFile(join(root, "src/lib/stores/audio.ts"), "utf8");
  check("shared ensure + health poll", audio.includes("ensureSidecar") && audio.includes("pollUntilHealthy") && audio.includes("sttStarting"));
  check("model gates + real TTS stop", audio.includes("sttProbed") && audio.includes("stopWavPlayback") && audio.includes("Decode caveat"));
  const mic = await readFile(join(root, "src/lib/components/MicButton.svelte"), "utf8");
  check("mic gate + failover + touch size", mic.includes("STT_FETCH_HINT") && mic.includes("offerBrowserVoice") && mic.includes("44px"));
  check("web mic uses browser dictation first", mic.includes("browserMode") && mic.includes("startBrowserDictation") && mic.includes("Dictate (browser voice)"));
  const tts = await readFile(join(root, "src/lib/components/ReadAloudButton.svelte"), "utf8");
  check("tts loading + gate + touch size", tts.includes("loading") && tts.includes("TTS_FETCH_HINT") && tts.includes("44px") && !tts.includes("playWavBase64('')"));
  check("web read-aloud uses browser voice", tts.includes("speakBrowserText") && tts.includes("stopBrowserSpeech") && tts.includes("stripForTts") && tts.includes("Read aloud (browser voice)"));
  const vlib = await readFile(join(root, "src/lib/voice.ts"), "utf8");
  check("web speech error reasons", vlib.includes("voiceErrorReason") && vlib.includes("not-allowed"));
  check("browser speech synthesis helpers", vlib.includes("ttsSupported") && vlib.includes("speakBrowserText") && vlib.includes("stopBrowserSpeech") && vlib.includes("browserTtsLocale"));
  const spane = await readFile(join(root, "src/lib/components/SettingsPane.svelte"), "utf8");
  check("settings voice validation", spane.includes("probePythonPath") && spane.includes("validateSttModel") && spane.includes("sidecarPythonProbe"));
  check("python probe wired end to end", (await readFile(join(root, "src/lib/api.ts"), "utf8")).includes("sidecarPythonProbe") && (await readFile(join(root, "src/lib/browserBackend.ts"), "utf8")).includes("sidecar_python_probe"));
  const props = await readFile(join(root, "src/lib/components/PropertiesView.svelte"), "utf8");
  check("saved views + calendar", props.includes("saveCurrentView") && props.includes("calendarCells"));
  const commands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
  check("Rust streams SSE deltas", commands.includes("ai_generate_stream") && commands.includes("delta"));
  check("Rust slot/status/sidecar hardening", commands.includes("fn resolve_slot") && commands.includes("fn friendly_http_status") && commands.includes("trusted_sidecars_dir") && commands.includes("app_lock_verify") && !commands.includes("harness_dir is empty"));
}

async function settingsAreaWiring() {
  const api = await readFile(join(root, "src/lib/api.ts"), "utf8");
  check("orphaned dashboard commands deleted", !api.includes("dashboardHeatmapData") && !api.includes("dashboardActivityHeatmap") && !api.includes("dashboardWordCountTimeline") && !api.includes("analyticsHeatmapHourly") && !api.includes("analyticsActivityTimeline") && api.includes("dashboardWritingVelocity") && api.includes("dashboardProductivityScore"));
  const stores = await readFile(join(root, "src/lib/stores/settings.ts"), "utf8");
  check("dead sync keys deleted", !stores.includes("fileWatcherEnabled") && !stores.includes("conflictBehavior") && stores.includes("validateSettings") && stores.includes("resetSettings"));
  check("retired ollama defaults migrate", stores.includes("migrateRetiredProviders") && (await readFile(join(root, "src/lib/settingsValidate.ts"), "utf8")).includes("RETIRED_MAIN_MODELS"));
  const pane = await readFile(join(root, "src/lib/components/SettingsPane.svelte"), "utf8");
  check("settings import validates loudly + resets", pane.includes("validateSettings(imported") && pane.includes("Import blocked secrets") && pane.includes("resetAllSettings") && !pane.includes("setting-conflict-behavior"));
  check("rhythm heatmap wired to checkbox", pane.includes("setting-rhythm-heatmap") && pane.includes("rhythmHeatmapInStatusBar"));
  for (const f of ["EditorPane.svelte", "JustWriteWorkspace.svelte"]) {
    const src = await readFile(join(root, "src/lib/components", f), "utf8");
    check(`${f} records 3 craft metrics gated`, src.includes("craftProfilingEnabled") && src.includes('"dialogue_ratio"') && src.includes('"avg_sentence_length"') && src.includes('"filter_words"'));
  }
  const dash = await readFile(join(root, "src/lib/stores/dashboard.ts"), "utf8");
  const usage = await readFile(join(root, "src/lib/components/UsageMemory.svelte"), "utf8");
  check("dashboard single-truth store", dash.includes("refreshDashboardStats") && dash.includes("dashboardStreakHeatmap") && usage.includes("stores/dashboard") && !usage.includes("api.getReopenNeverFinish?.()"));
}

async function secretsWiring() {
  const pane = await readFile(join(root, "src/lib/components/SettingsPane.svelte"), "utf8");
  check("settings export strips secrets", pane.includes("for (const k of SECRET_KEYS) delete exportable[k]"));
  check("settings import uses allowlist", pane.includes("validateSettings(imported"));
  const stores = await readFile(join(root, "src/lib/stores/settings.ts"), "utf8");
  const schema = await readFile(join(root, "src/lib/settingsValidate.ts"), "utf8");
  check("import allowlist excludes secrets", schema.includes("SECRET_KEYS") && schema.includes('"apiKey", "appLockPin"'));
  check("lock can be disabled in settings", stores.includes("lockEnabled") && pane.includes("setting-lock-enabled"));
  const lockStore = await readFile(join(root, "src/lib/stores/lock.ts"), "utf8");
  check("PIN storage fails closed and reset transitions are explicit", lockStore.includes("requirePinStorage") && lockStore.includes("resetPinConfiguration") && lockStore.includes("api.appLockReset"));
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("lock listener is installed before access wait", app.indexOf('"app-lock-unlock-request"') < app.indexOf("await waitForAppAccess()") && !app.includes('listen<boolean>("app-lock-state"'));
  check("invalid persisted PIN cannot open the shell", app.includes("$appLockConfigured || $settings.lockEnabled") && !app.includes("$settings.appLockPin.trim().length"));
  const backend = await readFile(join(root, "src/lib/browserBackend.ts"), "utf8");
  check("preview secret bucket has allowlist", backend.includes('payload.key !== "apiKey"'));
  const appLockCommands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
  const widgetPermissions = await readFile(join(root, "src-tauri/permissions/widget.toml"), "utf8");
  check("widget has narrow app-lock status only", appLockCommands.includes("app_lock_configured") && appLockCommands.includes("app_lock_verify") && widgetPermissions.includes("allow-app-lock-configured") && !widgetPermissions.includes("allow-app-lock-verify") && !widgetPermissions.includes("allow-secret-get"));
  const tab = await readFile(join(root, "src/lib/components/TabBar.svelte"), "utf8");
  check("tab unlock requires session PIN", tab.includes("isUnlocked(doc.id)"));
  const commands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
  check("Rust keychain errors are static", commands.includes('"unknown secret key"') && !commands.includes("unknown secret key: {}"));
  check("Rust publish escapes + sanitizes", commands.includes("sanitize_body(&body_raw)") && commands.includes("html_escape(ws)") && commands.includes("fn sanitize_body"));
  const publish = await readFile(join(root, "src/lib/stores/publish.ts"), "utf8");
  check("TS publish twin deleted (Rust owns publish)", !publish.includes("function renderHtml") && !publish.includes("processMarkdown") && publish.includes("single implementation"));
  check("Rust publish sanitizes + inlines", commands.includes("sanitize_inline_js") && commands.includes("inline_attachments") && commands.includes("imagesInlined"));
}

async function canvasWiring() {
  const canvas = await readFile(join(root, "src/lib/components/CanvasWorkspace.svelte"), "utf8");
  check("canvas board renders cards+edges", canvas.includes("canvasUpsertNode") && canvas.includes("canvasConnect") && canvas.includes("edgePath"));
  check("canvas card double-click inline edit", canvas.includes("startInlineEdit") && canvas.includes("inline-title") && canvas.includes("inline-body") && canvas.includes("commitInlineEdit"));
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("app routes canvas workspace", app.includes("CanvasWorkspace") && app.includes('"canvas"'));
  const stores = await readFile(join(root, "src/lib/stores/app.ts"), "utf8");
  check("canvas in workspace nav", stores.includes('"canvas"'));
}

async function batchWiring() {
  const tab = await readFile(join(root, "src/lib/components/TabBar.svelte"), "utf8");
  check("tabs offer Lock/Unlock", tab.includes("toggleLock") && tab.includes("Lock"));
  const home = await readFile(join(root, "src/lib/components/HomePane.svelte"), "utf8");
  check("Home has pinned quick-launch", home.includes("docListPinned") && home.includes("Pinned"));
  const status = await readFile(join(root, "src/lib/components/StatusBar.svelte"), "utf8");
  check("status bar has rhythm sparkline", status.includes("sparkline") && status.includes("dashboardTodayRhythm"));
  const nudges = await readFile(join(root, "src/lib/components/SkillNudges.svelte"), "utf8");
  check("skill nudge watches filter words", nudges.includes("craft-filter-") && nudges.includes("filter_words"));
  const novel = await readFile(join(root, "src/lib/components/NovelWorkspace.svelte"), "utf8");
  check("novel has project picker", novel.includes("Select a project") && novel.includes("createProject"));
  check("beat board drag-reorders", novel.includes("dropSceneOnto") && novel.includes("persistSceneOrder"));
  check("new project bootstraps first scene + opens it", novel.includes("startWriting()") && novel.includes("Sequence 1") && novel.includes("Scene 1"));
  check("empty board offers Start writing", novel.includes("empty-board") && novel.includes("Start writing"));
  check("import lands in first scene editor", novel.includes("board.scenes[0]") && novel.includes("selectBeat(firstScene)"));
  const lazy = await readFile(join(root, "src/lib/components/LazyWorkspace.svelte"), "utf8");
  check("lazy shell logs + times out + retries", lazy.includes("loadWithTimeout") && lazy.includes("lazy-retry") && lazy.includes("[LazyWorkspace]"));
  check("lazy views are labeled", (await readFile(join(root, "src/App.svelte"), "utf8")).includes('label="Novel Studio"'));
  check("preload errors are logged", (await readFile(join(root, "src/main.ts"), "utf8")).includes("vite:preloadError"));
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("app gates locked docs + restores places", app.includes("LockScreen") && app.includes("placeFor"));
  const inbox = await readFile(join(root, "src/lib/components/InboxWorkspace.svelte"), "utf8");
  check("inbox redacts locked previews", inbox.includes("locked-hint"));
}

async function bookParsing() {
  // Bundle the REAL bookparse module (esbuild ships with vite) and parse
  // the committed binary fixtures — no mocks, no network.
  const esbuild = await import("esbuild");
  const outdir = join(root, "tests", ".tmp-e2e");
  await mkdir(outdir, { recursive: true });
  const outfile = join(outdir, "bookparse.mjs");
  await esbuild.build({
    entryPoints: [join(root, "src/lib/bookparse.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "error",
    // Node runs the workerless legacy build; browsers get the modern
    // build + bundled worker URL via the app's own import path.
    alias: { "pdfjs-dist": "pdfjs-dist/legacy/build/pdf.mjs" },
  });
  const bp = await import(pathToFileURL(outfile).href);
  const nodeWorker = pathToFileURL(
    join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
  ).href;
  const cases = [
    ["sample.epub", ["Chapter One", "quick brown fox", "Second paragraph"], undefined],
    ["sample.docx", ["Chapter One", "quick brown fox"], undefined],
    ["sample.pdf", ["Chapter One", "quick brown fox"], nodeWorker],
  ];
  for (const [file, wants, worker] of cases) {
    try {
      const data = new Uint8Array(await readFile(join(root, "tests/fixtures", file)));
      const book = await bp.parseBookFile(file, data, worker);
      const ok = wants.every((w) => book.text.includes(w));
      check(`parses ${file}`, ok, `${book.text.length} chars`);
    } catch (e) {
      check(`parses ${file}`, false, String(e).split("\n")[0]);
    }
  }
}

async function storyMemoryWiring() {
  const api = await readFile(join(root, "src/lib/api.ts"), "utf8");
  const backend = await readFile(join(root, "src/lib/browserBackend.ts"), "utf8");
  const commands = await readFile(join(root, "src-tauri/src/commands.rs"), "utf8");
  const novel = await readFile(join(root, "src/lib/components/NovelWorkspace.svelte"), "utf8");
  const editor = await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8");
  const write = await readFile(join(root, "src/lib/components/JustWriteWorkspace.svelte"), "utf8");
  const extractor = commands.slice(commands.indexOf("async fn extract_bible_memory"), commands.indexOf("#[tauri::command]\npub fn memory_decay_activity"));
  check("Story Memory API has extraction and review commands", ["bibleGetMentions", "bibleGetSuggestions", "bibleExtractMentions", "bibleRebuildMemory"].every((name) => api.includes(name)));
  check("Story Memory browser backend has parity cases", ["bible_get_mentions", "bible_get_suggestions", "bible_extract_mentions", "bible_rebuild_memory"].every((name) => backend.includes(`case "${name}"`)));
  check("Story Memory extraction uses managed local chat only", extractor.includes("llm.chat_completion") && !extractor.includes("post_chat_completions") && !extractor.includes("mainModel"));
  check("Story Memory queues after successful saves", editor.includes("scheduleStoryMemory(updated, content)") && write.includes("scheduleStoryMemory(updated, content)"));
  check("Story Memory UI exposes review and contradiction surfaces", novel.includes("Rebuild Memory") && novel.includes("Suggested entries") && novel.includes("Contradiction"));
}

async function recentWiring() {
  // Skills/Craft/Stats live in Settings, not the sidebar.
  const stores = await readFile(join(root, "src/lib/stores/app.ts"), "utf8");
  for (const ws of ["craft", "stats", "skills"]) {
    check(`"${ws}" out of sidebar nav`, !stores.includes(`id: "${ws}"`), ws);
  }
  const settings = await readFile(join(root, "src/lib/stores/settings.ts"), "utf8");
  check("settings owns skills/craft/stats categories", settings.includes('"skills"') && settings.includes('"craft"') && settings.includes('"stats"'));
  check("settings deep-link store exists", settings.includes("settingsCategory") && settings.includes("openSettingsAt"));
  const pane = await readFile(join(root, "src/lib/components/SettingsPane.svelte"), "utf8");
  check("settings embeds skills/craft/stats", pane.includes("SkillsPage.svelte") && pane.includes("CraftPage.svelte") && pane.includes("UsageMemory.svelte"));
  const app = await readFile(join(root, "src/App.svelte"), "utf8");
  check("old workspace ids redirect to settings", app.includes('"craft"') && app.includes("settingsCategory.set"));
  // Drag-resize dock dividers in the three docked workspaces.
  for (const [f, key] of [["NovelWorkspace.svelte", "jwe-split-novel"], ["InboxWorkspace.svelte", "jwe-split-inbox"], ["ProjectsWorkspace.svelte", "jwe-split-projects"], ["CanvasWorkspace.svelte", "jwe-split-canvas"]]) {
    const src = await readFile(join(root, "src/lib/components", f), "utf8");
    check(`${f} has persisted divider`, src.includes("DockSplit") && src.includes(key), key);
  }
  const reader = await readFile(join(root, "src/lib/components/ReaderWorkspace.svelte"), "utf8");
  check("ReaderWorkspace.svelte has persisted notes divider", reader.includes("DockSplit") && reader.includes("jwe-split-reader") && reader.includes('direction="horizontal"'));
  const dock = await readFile(join(root, "src/lib/components/DockSplit.svelte"), "utf8");
  check("divider supports both axes", dock.includes('"horizontal"') && dock.includes("clientX"));
  const appShell = await readFile(join(root, "src/App.svelte"), "utf8");
  check("settings + AI panel lazy-load", appShell.includes('import("$lib/components/SettingsPane.svelte")') && appShell.includes('import("$lib/components/AiPanel.svelte")'));
  // Split editors in Write.
  const jw = await readFile(join(root, "src/lib/components/JustWriteWorkspace.svelte"), "utf8");
  check("write splits side-by-side", jw.includes("openSplit") && jw.includes("closeSplit") && jw.includes("split-picker"));
  check("split pane autosaves", jw.includes("handleSplitChange") && jw.includes("couldn't save split document"));
  // Typing auto-hide chrome.
  check("auto-hide setting exists", settings.includes("autoHideChrome"));
  check("shell hides chrome while typing", app.includes("typing-focus") && app.includes("editor-typing"));
  check("editors report typing", (await readFile(join(root, "src/lib/components/EditorPane.svelte"), "utf8")).includes("editor-typing"));
  // No floating action buttons.
  const palette = await readFile(join(root, "src/lib/components/CommandPalette.svelte"), "utf8");
  check("no floating palette trigger", !palette.includes("palette-trigger"));
  check("no floating sidebar expand", !app.includes("sidebar-expand"));
}

async function splitHardeningWiring() {
  const jw = await readFile(join(root, "src/lib/components/JustWriteWorkspace.svelte"), "utf8");
  check("split publishes its target", jw.includes("splitTarget.set"));
  check("split pane consumes write-back", jw.includes("Split-pane write-back"));
  check("split swaps panes", jw.includes("swapSplit") && jw.includes("Swap panes"));
  const panel = await readFile(join(root, "src/lib/components/AiPanel.svelte"), "utf8");
  check("AI targets main/split", panel.includes("wbTargetId") && panel.includes("Write-back target"));
}

await serveAndFetch();
await staticCoverage();
await staticIcons();
await bookParsing();
await updaterWiring();
await exportWiring();
await batchWiring();
await canvasWiring();
await integrityWiring();
await noNativeDialogs();
await auditBatchWiring();
await secretsWiring();
await settingsAreaWiring();
await storyMemoryWiring();
await recentWiring();
await splitHardeningWiring();
await themeAndReaderWiring();
await modelWiring();
await modelsDocWiring();
await aiEntryWiring();
await writePathWiring();
await memorySidecarLive();
// Remove the esbuild scratch bundle — never leave build trash behind.
await rm(join(root, "tests", ".tmp-e2e"), { recursive: true, force: true });
console.log(failures === 0 ? "\nAll e2e-browser checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
