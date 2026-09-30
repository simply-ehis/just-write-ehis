/**
 * sessionHealth — breadcrumbs for hang diagnosis (About → Diagnostics).
 *
 * The app already records boot timing (`jwe-boot-ms`) and the in-progress
 * boot step (`jwe-boot-step`, removed only by a finished boot) in
 * localStorage. This module adds a clean-exit flag so the *next* launch
 * can tell a kill/crash apart from a clean quit, and exposes one read
 * function for the diagnostics panel + support snapshot. All reads are
 * synchronous and never throw — unknown means "no data", never an error.
 */

const BOOT_MS_KEY = "jwe-boot-ms";
const BOOT_STEP_KEY = "jwe-boot-step";
const CLEAN_EXIT_KEY = "jwe-clean-exit";

export interface SessionHealth {
  /** This boot's navigation-start → interactive-shell ms (null until reported). */
  bootMs: number | null;
  /** Boot step the current boot is stuck on, if any (removed on clean boot). */
  stuckStep: string | null;
  /** How the previous session ended: "clean", "unclean", or "unknown". */
  prevExit: "clean" | "unclean" | "unknown";
  /** Previous boot's ms, for comparing across the incident. */
  prevBootMs: number | null;
}

function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function toMs(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Previous session's flag + boot ms, captured once before overwrite. */
let previous: { exit: string | null; bootMs: number | null } | null = null;

/** Call once at boot: snapshots the previous session, then marks this one open. */
export function markBootStart(): void {
  if (previous == null) {
    previous = { exit: readKey(CLEAN_EXIT_KEY), bootMs: toMs(readKey(BOOT_MS_KEY)) };
  }
  try {
    localStorage.setItem(CLEAN_EXIT_KEY, "0");
  } catch {
    /* storage unavailable: health just stays unknown */
  }
}

/** Call on pagehide: a later boot that finds anything but "1" died uncleanly. */
export function markCleanExit(): void {
  try {
    localStorage.setItem(CLEAN_EXIT_KEY, "1");
  } catch {
    /* shutting down anyway */
  }
}

export function readSessionHealth(): SessionHealth {
  const prevExit: SessionHealth["prevExit"] =
    previous == null
      ? "unknown"
      : previous.exit === "1"
        ? "clean"
        : previous.bootMs != null
          ? "unclean"
          : "unknown";
  return {
    bootMs: toMs(readKey(BOOT_MS_KEY)),
    stuckStep: readKey(BOOT_STEP_KEY),
    prevExit,
    prevBootMs: previous?.bootMs ?? null,
  };
}
