/**
 * secretScrub — local, dependency-free secret redaction.
 *
 * Why this exists: secret scrubbing used to be gated on the memory
 * sidecar, and the gate FAILED CLOSED — a sidecar that was down (or that
 * had never once stored a fact) took the whole AI panel offline with
 * "Secret scrubbing is on but the memory sidecar isn't running". Privacy
 * protection must not have a single point of failure.
 *
 * The sidecar is still preferred (it is the fuller implementation), but it
 * is now an optimisation: if it is unavailable we fall back to these
 * patterns rather than blocking the writer or, worse, letting a pasted
 * API key go out unredacted.
 *
 * Patterns mirror `harness/memory.py::redact_secrets` so both layers
 * agree. Pure and synchronous — safe to call on every prompt.
 */

const PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{8,}/g,                              // OpenAI-style
  /ghp_[A-Za-z0-9]{20,}/g,                           // GitHub PAT
  /hf_[A-Za-z0-9]{20,}/g,                            // HuggingFace
  /AKIA[0-9A-Z]{16}/g,                               // AWS access key id
  /\bBearer\s+\S{10,}/gi,                            // bearer tokens
  /\b(?:api[_-]?key|apikey|token|password|passwd|secret)\s*[:=]\s*\S{6,}/gi,
];

/** Shannon entropy in bits per character. */
function entropy(run: string): number {
  const freq = new Map<string, number>();
  for (const ch of run) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  const n = run.length;
  let h = 0;
  for (const c of freq.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Redact unpatterned credentials too: a 20+ char mixed-case+digits run with
 * high Shannon entropy is a key far more often than it is prose.
 */
function redactHighEntropy(text: string, replacement: string): string {
  let out = "";
  let run = "";
  let hasUpper = false;
  let hasLower = false;
  let hasDigit = false;

  const flush = () => {
    if (!run) return;
    const redact =
      run.length >= 20 && hasUpper && hasLower && hasDigit && entropy(run) >= 3.5;
    out += redact ? replacement : run;
    run = "";
    hasUpper = hasLower = hasDigit = false;
  };

  for (const ch of text) {
    if (/[A-Za-z0-9_-]/.test(ch)) {
      run += ch;
      if (/[A-Z]/.test(ch)) hasUpper = true;
      else if (/[a-z]/.test(ch)) hasLower = true;
      else if (/[0-9]/.test(ch)) hasDigit = true;
    } else {
      flush();
      out += ch;
    }
  }
  flush();
  return out;
}

/** Replace obvious credentials with `replacement` (default `[REDACTED]`). */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, replacement);
  return redactHighEntropy(out, replacement);
}

/** True when `text` still contains something that looks like a credential. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
