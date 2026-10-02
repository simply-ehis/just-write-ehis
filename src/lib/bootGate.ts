/**
 * bootGate — wait for the Rust backend to finish `setup` before the frontend
 * uses it.
 *
 * Tauri creates the configured windows and starts loading their webviews
 * *before* `setup` returns, so the frontend can mount and start issuing
 * commands while the database and the sidecar managers are still unmanaged.
 * Every such call fails with "state not managed for field `db`", and because
 * the boot steps do not retry, the failure is permanent for the session: the
 * file watcher, the Home dashboard, status-bar stats, the inbox triage banner
 * and the streak nudge all stay dead, and the companion widget looks broken
 * because its document commands hit the same wall.
 *
 * `app_boot_ready` is flipped true as the last statement of setup. Polling it
 * is safe from the very first tick: before setup is entered the command's own
 * state is missing, which surfaces as an error, and that is normalised to
 * "not ready" so the caller only ever sees a boolean.
 *
 * Fails open. If the backend never reports ready, booting anyway is strictly
 * better than never booting: the shell appears and whatever does work still
 * works.
 *
 * The api import is dynamic (and the module has no import-time side effects)
 * so tests/boot-gate-unit.mjs can import this file in plain node, the same way
 * tests/window-state-unit.mjs does.
 */

/** Give up waiting after this long and boot anyway. */
export const BOOT_GATE_TIMEOUT_MS = 8000;

/** Delay between polls. Short, because setup is normally sub-second. */
export const BOOT_GATE_INTERVAL_MS = 50;

export interface BootGateDeps {
  /** Resolves true once the backend is managed. Must not throw. */
  isReady: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Resolves true if the backend became ready, false if the wait timed out.
 * Never throws and never rejects: a stuck backend must not trap the user
 * behind a splash screen.
 */
export async function waitForBackend(deps: BootGateDeps): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? BOOT_GATE_TIMEOUT_MS;
  const intervalMs = deps.intervalMs ?? BOOT_GATE_INTERVAL_MS;

  // Check first: a warm backend should cost one round trip, not one interval.
  try {
    if (await deps.isReady()) return true;
  } catch {
    /* not managed yet — keep waiting */
  }

  // Elapsed time is accumulated from the sleeps we perform rather than read
  // from Date.now(), so the budget cannot be skewed by a wall-clock jump and
  // the whole loop stays deterministic under an injected clock.
  let waited = 0;
  while (waited < timeoutMs) {
    const step = Math.min(intervalMs, timeoutMs - waited);
    await sleep(step);
    waited += step;
    try {
      if (await deps.isReady()) return true;
    } catch {
      /* still starting */
    }
  }

  try {
    return await deps.isReady();
  } catch {
    return false;
  }
}

/** Convenience wrapper bound to the real backend. */
export async function waitForBackendReady(): Promise<boolean> {
  const { api } = await import("$lib/api");
  return waitForBackend({ isReady: () => api.appBootReady() });
}
