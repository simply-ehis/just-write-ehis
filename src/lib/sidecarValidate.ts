/**
 * sidecarValidate — pure input validation for sidecar settings.
 *
 * Runs in the Settings voice section on blur (inline errors) AND mirrors
 * the fail-closed rules the python servers enforce at startup:
 *  - `..` escapes outside models/ are rejected everywhere;
 *  - stt/llm want a .gguf (bare name, models/-relative, or absolute);
 *  - tts wants a bundle dir (absolute or models/-relative), never a file.
 * Null = valid. Server-side existence/shape checks still apply at start
 * (fail closed with a clear error, never silent fallback). Python accepts
 * only PATH command names; reachability is proven by the probe.
 */

const LEGACY_STT_IDS = new Set(["moonshine-v2-q6", "moonshine-v2-q4", "moonshine/tiny"]);
const LEGACY_TTS_IDS = new Set(["hexgrad/Kokoro-82M", "hexgrad/kokoro-82m"]);

/**
 * True when a `..` segment climbs out of models/. Absolute paths are NOT
 * traversal here: an absolute, existing .gguf is an explicitly-picked
 * file and the server verifies existence fail-closed at start.
 */
export function hasTraversal(value: string): boolean {
  if (!value) return false;
  return value.split(/[\\/]/).some((p) => p === "..");
}

function checkTraversal(value: string, what: string): string | null {
  return hasTraversal(value)
    ? `${what} must stay inside models/ — ".." escapes are rejected.`
    : null;
}

/** Empty = bundled default (always valid). */
export function validateSttModel(value: string): string | null {
  const v = (value || "").trim();
  if (!v) return null;
  if (LEGACY_STT_IDS.has(v)) return null; // server maps loudly to bundled
  const bad = checkTraversal(v, "STT model");
  if (bad) return bad;
  if (!v.toLowerCase().endsWith(".gguf") && v.includes(".")) {
    return "STT model should be a .gguf file (bare name, models/ file, or absolute .gguf path).";
  }
  return null;
}

/** Empty = vendored default (always valid). */
export function validateTtsModel(value: string): string | null {
  const v = (value || "").trim();
  if (!v) return null;
  if (LEGACY_TTS_IDS.has(v)) return null; // server maps loudly to vendored
  const bad = checkTraversal(v, "TTS model");
  if (bad) return bad;
  const lower = v.toLowerCase();
  if (lower.endsWith(".onnx") || lower.endsWith(".bin") || lower.endsWith(".gguf")) {
    return "TTS model should be a bundle directory (model.onnx + voices.bin + tokens.txt), not a file.";
  }
  return null;
}

/** Same rules as STT (llama-server takes a .gguf). */
export function validateLlmModel(value: string): string | null {
  const v = (value || "").trim();
  if (!v) return null;
  const bad = checkTraversal(v, "LLM model");
  if (bad) return bad;
  if (!v.toLowerCase().endsWith(".gguf") && v.includes(".")) {
    return "LLM model should be a .gguf file.";
  }
  return null;
}

export function validatePythonPath(value: string): string | null {
  const v = (value || "").trim().toLowerCase();
  if (!v) return "Python path is empty — STT/TTS/memory sidecars need it; other features still work.";
  if (!/^(python|python3|py)(\.exe)?$/.test(v)) {
    return "Use python, python3, or py from PATH.";
  }
  return null;
}
