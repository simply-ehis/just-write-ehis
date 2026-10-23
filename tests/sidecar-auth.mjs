/**
 * Sidecar auth: prove the private transports enforce their token contract.
 *
 * ARCHITECTURE (post slice-4 redesign) — this file was rewritten when the
 * sidecars stopped binding TCP ports. Loopback HTTP is no longer the threat
 * model, because nothing listens on loopback:
 *
 *   STT / TTS / memory  → newline-delimited JSON frames over the child's
 *                         OWN stdin/stdout pipe (IpcSidecar). The pipe is
 *                         private to the parent process, so a token cannot
 *                         be replayed by another process — it exists purely
 *                         as a BOOT GUARD: the server refuses to start
 *                         without it in its environment.
 *   LLM (llama-server)  → an AF_UNIX .sock at a per-session path, spoken to
 *                         with a small HTTP/1.1 client carrying
 *                         `Authorization: Bearer <token>`.
 *
 * So the assertions changed shape accordingly: Rust is checked statically
 * (token minted, passed as ENV not header, absent from request frames), and
 * the Python servers are executed over a real pipe.
 *
 * Run: node tests/sidecar-auth.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFile(join(root, p), "utf8");
const PY = process.platform === "win32" ? "python" : "python3";
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Boot a python sidecar the way Rust does (token in the ENVIRONMENT, stdin
 * open as a pipe), send one JSON frame, and resolve the response frame.
 * Resolves as soon as a complete stdout line arrives, or on exit/timeout.
 */
async function probe(script, frame, { token = "test-token-abc123" } = {}) {
  const child = spawn(PY, [join(root, "src-tauri/sidecars", script)], {
    env: { ...process.env, JWE_SIDECAR_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let stderr = "";
  let settled = false;
  child.on("error", () => {});

  const res = await new Promise((resolve) => {
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      resolve({ out, stderr, ...patch });
    };
    // stdout carries pure JSON frames, one per line.
    child.stdout.on("data", (d) => {
      out += d.toString();
      const line = out.split("\n").map((s) => s.trim()).find((s) => s.startsWith("{"));
      if (line) {
        try {
          finish({ frame: JSON.parse(line) });
        } catch {
          finish({ frame: null, raw: line });
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => finish({ exited: code }));
    setTimeout(() => finish({ timeout: true }), 25000);
    try {
      child.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      /* stdin already closed: the process refused the token */
    }
  });
  return res;
}

// ── Rust half: static contract ───────────────────────────────────────────────
const rs = await read("src-tauri/src/sidecar.rs");
const ipc = await read("src-tauri/src/ipc.rs");

for (const mgr of ["SttManager", "TtsManager", "LlmManager"]) {
  const hasField = new RegExp(`pub struct ${mgr}\\s*\\{[^}]*auth_token: String`).test(rs);
  check(`${mgr} holds a per-launch token`, hasField);
  check(
    `${mgr} mints it as a UUID`,
    new RegExp(`impl ${mgr}[\\s\\S]{0,400}?auth_token: uuid::Uuid::new_v4\\(\\)`).test(rs)
  );
}

// The token reaches the child through the ENVIRONMENT, not a request header.
for (const mgr of ["SttManager", "TtsManager"]) {
  const start = rs.indexOf(`impl ${mgr}`);
  const end = rs.indexOf("\nimpl ", start + 10);
  const body = rs.slice(start, end === -1 ? undefined : end);
  const envPasses = (body.match(/\(\s*"JWE_SIDECAR_TOKEN",\s*self\.auth_token\.as_str\(\)\s*\)/g) || []).length;
  check(`${mgr} passes JWE_SIDECAR_TOKEN to the child env`, envPasses > 0, `${envPasses} env passes`);
}

// The wire frame is id/method/params only. Anything token-shaped in there
// would mean the secret travels on the pipe and is replayable by a debugger.
const frameLine = ipc.split("\n").find((l) => l.includes('json!({ "id"') && l.includes("params")) || "";
check(
  "stdio frames carry no token (the pipe itself is private)",
  frameLine !== "" &&
    frameLine.includes('"method"') &&
    frameLine.includes('"params"') &&
    !/token|auth/i.test(frameLine),
  frameLine.trim().slice(0, 70)
);
check(
  "llama-server still gets --api-key (llama.cpp defaults to permissive CORS)",
  /"--api-key"/.test(rs) && rs.includes("self.auth_token.clone()")
);
check(
  "AF_UNIX client authorizes with Bearer, not a bespoke header",
  /Authorization: Bearer \{\}/.test(ipc)
);
check(
  "memory sidecar keeps its own JWE_MEMORY_TOKEN env name",
  /"JWE_MEMORY_TOKEN",\s*self\.auth_token\.as_str\(\)/.test(rs)
);

// ── Python half: executed over a real pipe ───────────────────────────────────
// Probe with a method that answers WITHOUT loading a model: `health` builds
// the engine (slow, and it cannot finish in a bare checkout), while these just
// touch in-memory state. The point is to prove the framing works end to end.
const FAST_METHOD = {
  "stt_server.py": { id: 7, method: "stream_start", params: {} },
  "phonon-server.exe": { id: 7, method: "stop", params: {} },
};

for (const script of ["stt_server.py"]) {
  const src = await read(`src-tauri/sidecars/${script}`);
  check(`${script} reads JWE_SIDECAR_TOKEN`, src.includes('os.environ.get("JWE_SIDECAR_TOKEN"'));
  check(
    `${script} refuses to start without a token`,
    src.includes('raise RuntimeError("JWE_SIDECAR_TOKEN is required")')
  );
  check(
    `${script} answers with one JSON frame per request line`,
    /_write\(out,\s*\{\s*"id":\s*rid,\s*"ok":\s*True/.test(src)
  );

  // With a token: it must answer our frame on stdout with the same id.
  const token = "test-token-abc123";
  const ok = await probe(script, FAST_METHOD[script], { token });
  if (ok.timeout) {
    check(`${script} answers a request frame`, false, `no response — ${ok.stderr.slice(-160)}`);
  } else {
    check(
      `${script} answers a request frame`,
      ok.frame && ok.frame.id === 7 && ok.frame.ok === true,
      ok.frame ? `id=${ok.frame.id} ok=${ok.frame.ok}` : `exited=${ok.exited}`
    );
  }
  // The boot-guard token must never be reflected back into the wire frames.
  check(`${script} never echoes the token to stdout`, !ok.out.includes(token));

  // Without a token: it must die rather than sit there serving.
  const bad = await probe(script, FAST_METHOD[script], { token: "" });
  check(
    `${script} exits when the token is missing`,
    bad.exited !== undefined && bad.exited !== null && !bad.timeout,
    bad.timeout ? "still running without a token" : `exit=${bad.exited}`
  );
  check(`${script} says why in the log`, /JWE_SIDECAR_TOKEN/.test(bad.stderr || bad.out));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
