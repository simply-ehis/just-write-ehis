/**
 * harness — AI memory sidecar client (vendored harness memory + redaction).
 * Lazy-starts the python server on first use, mirroring audio.ts.
 * Every call degrades to a clear error outside the desktop shell —
 * privacy gates must fail closed, never pass secrets through silently.
 */
import { api, isBrowserPreview } from "$lib/api";
import { getPythonPath, getSidecarsDir } from "$lib/stores/audio";

/** Start the memory sidecar if needed. False = unavailable, don't proceed. */
export async function ensureHarness(): Promise<boolean> {
  if (isBrowserPreview()) return false;
  try {
    if (await api.memorySidecarRunning()) return true;
    await api.memorySidecarStart(getPythonPath(), await getSidecarsDir());
    await new Promise((r) => setTimeout(r, 400));
    await api.memorySidecarHealth();
    return true;
  } catch {
    return false;
  }
}

/** Stop the memory sidecar (e.g. when AI memory is toggled off). Best-effort. */
export async function stopHarness(): Promise<void> {
  try {
    await api.memorySidecarStop();
  } catch {
    /* already down */
  }
}
