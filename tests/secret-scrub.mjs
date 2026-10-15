/**
 * secret-scrub — proves the local scrubber redacts the credential shapes
 * writers actually paste, and that ordinary prose survives it.
 *
 * This exists because scrubbing used to fail CLOSED on a dead memory
 * sidecar, which took the whole AI panel offline. The sidecar is now an
 * optimisation; this module is the floor. A regression here would mean
 * real API keys leaving the machine.
 *
 * Run: node tests/secret-scrub.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { redactSecrets, containsSecret } = await import(
  pathToFileURL(join(root, "src/lib/secretScrub.ts")).href
);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Provider keys writers actually paste while configuring the app.
const SECRETS = [
  ["OpenAI-style", "my key is sk-abc123XYZ789012345"],
  ["GitHub PAT", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
  ["HuggingFace", "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"],
  ["AWS access id", "AKIAIOSFODNN7EXAMPLE"],
  ["Bearer header", "Authorization: Bearer abcdefghijklmnop"],
  ["key=value", "api_key=supersecretvalue123"],
  ["password=", "password: hunter2correcthorse"],
  ["token colon", "token: abcdef123456XYZ"],
];
for (const [name, raw] of SECRETS) {
  const out = redactSecrets(raw);
  check(`${name} redacted`, !containsSecret(out), out);
  check(`${name} keeps its surroundings`, out.includes("[REDACTED]") || out.includes("my key"), out);
}

// High-entropy runs with no known prefix are still credentials.
const entropyRun = "x7Kp2mQ9wR4tZ6nL8vB1yH3";
const entropyOut = redactSecrets(`here it is ${entropyRun} thanks`);
check(
  "unpatterned high-entropy key redacted",
  entropyOut === "here it is [REDACTED] thanks",
  entropyOut
);

// Prose must NOT be mangled — over-redaction destroys the writer's work.
const PROSE = [
  "I always write in British English and never use American spellings.",
  "The manuscript is due on Friday; the narrator lives in Cork.",
  "My name is Elena and I'm working on the Nightfall audiobook.",
];
for (const line of PROSE) {
  const out = redactSecrets(line);
  check("prose untouched", out === line, `changed to: ${out}`);
}

// Idempotent + safe on the awkward inputs a textarea really produces.
check("idempotent", redactSecrets(redactSecrets("sk-abc123XYZ789")) === redactSecrets("sk-abc123XYZ789"));
check("empty string", redactSecrets("") === "");
check("whitespace only", redactSecrets("   \n\t ") === "   \n\t ");
check("very long input", redactSecrets("a".repeat(50000)).length === 50000);
check("newlines preserved", redactSecrets("line one\nline two") === "line one\nline two");
check("unicode preserved", redactSecrets("café — naïve 日本語 🤍") === "café — naïve 日本語 🤍");
check("containsSecret false for prose", containsSecret("just a normal sentence") === false);

console.log(failures === 0 ? "\nsecret-scrub: all checks passed." : `\nsecret-scrub: ${failures} FAILED`);
process.exit(failures ? 1 : 0);
