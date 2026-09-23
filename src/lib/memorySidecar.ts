/**
 * memorySidecar — AI memory sidecar client (vendored harness memory +
 * redaction, port 8092 — not the legacy 8080 harness). Lazy-starts the
 * python server on first use, mirroring audio.ts. Every call degrades to
 * a clear error outside the desktop shell — privacy gates must fail
 * closed, never pass secrets through silently.
 */
import { api, isBrowserPreview } from "$lib/api";
import { getPythonPath, getSidecarsDir } from "$lib/stores/audio";

/** Start the memory sidecar if needed. False = unavailable, don't proceed. */
export async function ensureHarness(onProgress?: (elapsedSec: number) => void): Promise<boolean> {
  if (isBrowserPreview()) return false;
  try {
    if (await api.memorySidecarRunning()) return true;
    await api.memorySidecarStart(getPythonPath(), await getSidecarsDir());
    // Poll until healthy (cold python boot is 1–5s; a single 400ms sleep
    // used to report failure while the server was still starting).
    const started = Date.now();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      onProgress?.(Math.round((Date.now() - started) / 1000));
      try {
        await api.memorySidecarHealth();
        return true;
      } catch {
        /* not up yet — keep polling */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Stop the memory sidecar (e.g. when AI memory is toggled off). Best-effort. */
export async function stopHarness(): Promise<void> {
  try {
    await api.memorySidecarStop();
  } catch (e) {
    console.warn("memory sidecar stop failed (already down?):", e instanceof Error ? e.message : e);
  }
}
