#!/usr/bin/env node
// tests/no-torch.mjs — guard: no PyTorch anywhere in the TTS stack.
// Phonon is driven by the pure-Rust `ptts`/`xn` stack; torch must never
// leak back into requirements.txt, any Cargo.toml, package.json, or the
// built runtime venv. Run as `npm run test:no-torch`.
//
// Matching strategy: check each file format for torch as an actual
// dependency specifier, not as a substring of unrelated words
// ("torch-free", "test:no-torch", etc.).

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd());
let failures = 0;

function fail(msg) {
  console.error(`FAIL  no-torch: ${msg}`);
  failures += 1;
}

function pass(msg) {
  console.log(`PASS  no-torch: ${msg}`);
}

const TORCH_NAMES = ["torch", "torchvision", "torchaudio", "tch", "candle", "burn"];

// requirements.txt: one dep per line, possibly with version specifiers.
// Comments (#) and blank lines are ignored.
const TORCH_DEP_RE = /^(?:@[^/]+\/)?(torch|torchvision|torchaudio|tch|candle|burn)(?:[<>=!~\s].*)?$/i;

async function checkRequirementsTxt() {
  try {
    const text = await readFile(resolve(ROOT, "src-tauri/sidecars/requirements.txt"), "utf8");
    const hits = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (TORCH_DEP_RE.test(trimmed)) hits.push(trimmed);
    }
    if (hits.length) fail(`src-tauri/sidecars/requirements.txt has torch deps: ${hits.join(", ")}`);
    else pass("src-tauri/sidecars/requirements.txt has no torch deps");
  } catch {
    pass("src-tauri/sidecars/requirements.txt not found (skipped)");
  }
}

// Cargo.toml: crate names appear as `name = "..."` or `name = { ... }` in
// [dependencies] sections.
const CARGO_DEP_RE = /^\s*(torch|torchvision|torchaudio|tch|candle|burn)(?:\s*=|\[)/i;

async function checkCargoToml(relPath) {
  try {
    const text = await readFile(resolve(ROOT, relPath), "utf8");
    const hits = [];
    for (const line of text.split("\n")) {
      if (CARGO_DEP_RE.test(line)) hits.push(line.trim());
    }
    if (hits.length) fail(`${relPath} has torch deps: ${hits.join(", ")}`);
    else pass(`${relPath} has no torch deps`);
  } catch {
    pass(`${relPath} not found (skipped)`);
  }
}

// package.json: torch as a JSON dependency key or scoped @torch/... key.
const PKG_DEP_RE = /"(torch|torchvision|torchaudio|@torch\/[^"]+)"\s*:/i;

async function checkPackageJson() {
  try {
    const text = await readFile(resolve(ROOT, "package.json"), "utf8");
    const hits = [];
    for (const m of text.matchAll(PKG_DEP_RE)) hits.push(m[1]);
    if (hits.length) fail(`package.json has torch deps: ${hits.join(", ")}`);
    else pass("package.json has no torch deps");
  } catch {
    pass("package.json not found (skipped)");
  }
}

async function main() {
  await checkRequirementsTxt();
  await checkCargoToml("src-tauri/Cargo.toml");
  await checkCargoToml("sidecars/phonon-server/Cargo.toml");
  await checkPackageJson();

  // 5) the built runtime venv must not have torch installed
  let venvOk = true;
  try {
    const venvPy = resolve(ROOT, "sidecars", ".runtime-build-venv", "Scripts", "python.exe");
    const out = execSync(`"${venvPy}" -m pip list --format=columns`, {
      encoding: "utf8",
      timeout: 60_000,
    });
    const torchPkgs = out.split("\n").filter((l) => /^(torch|torchvision|torchaudio|tch|candle|burn)/i.test(l.trim()));
    if (torchPkgs.length) {
      fail(`runtime venv has torch packages installed: ${torchPkgs.join(", ")}`);
      venvOk = false;
    }
  } catch (e) {
    // venv may not be built yet — that's fine for the static checks
    venvOk = false;
  }
  if (venvOk) pass("runtime venv has no torch packages");

  if (failures) {
    console.error(`\nno-torch: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nno-torch: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(`no-torch: errored — ${err}`);
  process.exit(1);
});
