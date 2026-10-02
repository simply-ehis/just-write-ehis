/**
 * Sidecar auth: prove the loopback servers refuse unauthenticated callers.
 *
 * Loopback is not a trust boundary — any local process, and any website via a
 * CORS-simple POST, can reach 127.0.0.1. Only the memory sidecar enforced a
 * per-launch token; STT and TTS accepted anything. These tests boot the real
 * servers and check the contract end to end.
 *
 * The Rust half is asserted statically (sidecar.rs must mint a token, pass it
 * to every manager, and send it on every request); the Python half is executed.
 *
 * Run: node tests/sidecar-auth.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(root, p), "utf8");
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${condition(ok) ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const condition = (v) => v;

async function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/** Boot a python sidecar with a token, return a stop() and the base url. */
async function boot(script, port, token) {
  const child = spawn("python", [join(root, "src-tauri/sidecars", script), String(port)], {
    env: { ...process.env, JWE_SIDECAR_TOKEN: token, JWE_SIDECARS_DIR: join(root, "src-tauri/sidecars") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const err = [];
  child.stderr.on("data", (d) => err.push(d.toString()));
  child.stdout.on("data", () => {});
  // Wait for the port to accept connections (the model loads lazily).
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      return { child, err };
    } catch {}
  }
  child.kill();
  return { child, err, failed: true };
}

// ── Rust half: static contract ───────────────────────────────────────────────
const rs = await read("src-tauri/src/sidecar.rs");

for (const mgr of ["SttManager", "TtsManager", "LlmManager"]) {
  const hasField = new RegExp(`pub struct ${mgr}\\s*\\{[^}]*auth_token: String`).test(rs);
  check(`${mgr} holds a per-launch token`, hasField);
  check(
    `${mgr} mints it as a UUID`,
    new RegExp(`impl ${mgr}[\\s\\S]{0,400}?auth_token: uuid::Uuid::new_v4\\(\\)`).test(rs)
  );
  check(`${mgr} passes JWE_SIDECAR_TOKEN to the child`, /JWE_SIDECAR_TOKEN/.test(rs));
}

// Every request to a sidecar must carry the header. Count the request builders
// in each manager and require the header on each.
for (const mgr of ["SttManager", "TtsManager", "LlmManager"]) {
  const start = rs.indexOf(`impl ${mgr}`);
  const end = rs.indexOf("\nimpl ", start + 10);
  const body = rs.slice(start, end === -1 ? undefined : end);
  const requests = (body.match(/client\.(get|post)\(/g) || []).length;
  const headers = (body.match(/\.header\(TOKEN_HEADER, &self\.auth_token\)/g) || []).length;
  check(
    `${mgr}: every request carries the token header`,
    requests > 0 && requests === headers,
    `${headers} headers / ${requests} requests`
  );
}

check(
  "llama-server is started with --api-key (llama.cpp defaults to permissive CORS)",
  /"--api-key"/.test(rs) && rs.includes("self.auth_token.clone()")
);
check("shared header name is declared once", /const TOKEN_HEADER: &str = "X-JWE-Sidecar-Token"/.test(rs));
check("memory sidecar's own token is untouched", /X-JWE-Memory-Token/.test(rs));

// ── Python half: executed ───────────────────────────────────────────────────
for (const [script, port] of [["stt_server.py", 8090], ["tts_server.py", 8091]]) {
  const src = await read(`src-tauri/sidecars/${script}`);
  check(`${script} reads JWE_SIDECAR_TOKEN`, src.includes('JWE_SIDECAR_TOKEN'));
  check(`${script} enforces it with hmac.compare_digest`, src.includes("hmac.compare_digest"));
  check(`${script} refuses to start without a token`, src.includes('raise RuntimeError("JWE_SIDECAR_TOKEN is required")'));
  check(`${script} gates do_GET`, /def do_GET\(self\):\s*\n\s*if not self\._authorized\(\):/.test(src));
  check(`${script} gates do_POST`, /def do_POST\(self\):\s*\n\s*if not self\._authorized\(\):/.test(src));

  // Run it for real.
  const p = await freePort();
  const token = "test-token-" + p;
  const { child, failed } = await boot(script, p, token);
  if (failed) {
    check(`${script} boots with a token`, false, "never accepted a connection");
  } else {
    const base = `http://127.0.0.1:${p}`;
    let anon, wrong, okTok;
    try {
      anon = await fetch(`${base}/health`);
    } catch (e) {
      anon = { status: `ERR ${e.message}` };
    }
    try {
      wrong = await fetch(`${base}/health`, { headers: { "X-JWE-Sidecar-Token": "not-the-token" } });
    } catch (e) {
      wrong = { status: `ERR ${e.message}` };
    }
    try {
      okTok = await fetch(`${base}/health`, { headers: { "X-JWE-Sidecar-Token": token } });
    } catch (e) {
      okTok = { status: `ERR ${e.message}` };
    }
    check(`${script} rejects an unauthenticated GET with 401`, anon.status === 401, `got ${anon.status}`);
    check(`${script} rejects a wrong token with 401`, wrong.status === 401, `got ${wrong.status}`);
    check(`${script} accepts the correct token`, okTok.status === 200, `got ${okTok.status}`);

    // A bodyless POST is the CORS-simple request a website can send blind.
    let anonPost;
    try {
      anonPost = await fetch(`${base}/stop`, { method: "POST" });
    } catch (e) {
      anonPost = { status: `ERR ${e.message}` };
    }
    check(`${script} rejects an unauthenticated POST with 401`, anonPost.status === 401, `got ${anonPost.status}`);
  }
  child.kill();
}

// A server started without the env var must refuse to run, not serve openly.
for (const script of ["stt_server.py", "tts_server.py"]) {
  const p = await freePort();
  const child = spawn("python", [join(root, "src-tauri/sidecars", script), String(p)], {
    env: { ...process.env, JWE_SIDECAR_TOKEN: "", JWE_SIDECARS_DIR: join(root, "src-tauri/sidecars") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = await Promise.race([
    sleep(6000).then(() => null),
    new Promise((r) => child.on("exit", (code) => r(code))),
  ]);
  check(`${script} exits rather than serving without a token`, exited !== null && !out.includes("on http://"), `exit=${exited}`);
  child.kill();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);