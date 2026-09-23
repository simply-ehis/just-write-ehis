/**
 * memorySidecar — AI memory sidecar client (vendored harness memory +
 * redaction, port 8092 — not the legacy 8080 harness). Lazy-starts the
 * python server on first use, mirroring audio.ts. Every call degrades to
 * a clear error outside the desktop shell — privacy gates must fail
 * closed, never pass secrets through silently.
 */
import { api, isBrowserPreview } from "$lib/api";
import { ensureSidecar, getPythonPath, getSidecarsDir } from "$lib/stores/audio";

/** Start the memory sidecar if needed. False = unavailable, don't proceed. */
export async function ensureHarness(onProgress?: (elapsedSec: number) => void): Promise<boolean> {
  if (isBrowserPreview()) return false;
  const noopBool = (_: boolean) => {};
  const noopStr = (_: string | null) => {};
  return ensureSidecar({
    kind: "memory",
    isRunning: () => api.memorySidecarRunning(),
    start: async () => {
      await api.memorySidecarStart(getPythonPath(), await getSidecarsDir());
    },
    health: () => api.memorySidecarHealth(),
    modelReady: () => true,
    setRunning: noopBool,
    setLoaded: noopBool,
    setError: noopStr,
    setProgress: (_m, sec) => {
      if (_m) onProgress?.(sec);
    },
    setProbed: () => {},
  });
}

/** Stop the memory sidecar (e.g. when AI memory is toggled off). Best-effort. */
export async function stopHarness(): Promise<void> {
  try {
    await api.memorySidecarStop();
  } catch (e) {
    console.warn("memory sidecar stop failed (already down?):", e instanceof Error ? e.message : e);
  }
}
