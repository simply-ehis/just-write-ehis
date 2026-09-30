/**
 * windowState — main-window geometry: first launch opens the spec viewport
 * (1240×740, centered), later launches restore the user's own
 * size/position.
 *
 * Pure web APIs only for measuring (window.screen.avail* is the work area
 * minus the taskbar; outerWidth/outerHeight/screenX/screenY track the
 * window) so no monitor permissions are needed. Only setSize/setPosition
 * go through Tauri (allowed in main-window.json). Everything is
 * best-effort and never blocks boot: any failure keeps the
 * tauri.conf.json fallback size.
 *
 * Side-effect-free on import (pure functions at top level) so
 * tests/window-state-unit.mjs can import it in plain node.
 */

/** Mirrors tauri.conf.json minWidth/minHeight for the main window. */
export const MIN_WINDOW_W = 900;
export const MIN_WINDOW_H = 600;

/** Fresh-launch size: the spec viewport (mirrors tauri.conf.json). */
export const DEFAULT_WINDOW_W = 1240;
export const DEFAULT_WINDOW_H = 740;

const STORAGE_KEY = "jwe-main-window";

/** At least this many px of chrome stay inside the work area. */
const MIN_VISIBLE_CHROME = 120;

export interface WorkArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WindowGeometry {
  w: number;
  h: number;
  x: number;
  y: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Fresh-launch geometry: the spec viewport, centered; fills smaller areas. */
export function defaultGeometry(area: WorkArea): WindowGeometry {
  const w = Math.round(Math.min(area.w, Math.max(MIN_WINDOW_W, DEFAULT_WINDOW_W)));
  const h = Math.round(Math.min(area.h, Math.max(MIN_WINDOW_H, DEFAULT_WINDOW_H)));
  return {
    w,
    h,
    x: Math.round(area.x + Math.max(0, (area.w - w) / 2)),
    y: Math.round(area.y + Math.max(0, (area.h - h) / 2)),
  };
}

/**
 * Validate a stored geometry against the CURRENT work area (monitors
 * change) and clamp it inside. Returns null when there is nothing usable
 * to restore — the caller falls back to defaultGeometry().
 */
export function coerceGeometry(saved: unknown, area: WorkArea): WindowGeometry | null {
  if (!saved || typeof saved !== "object") return null;
  const s = saved as Record<string, unknown>;
  if (!isFiniteNumber(s.w) || !isFiniteNumber(s.h)) return null;
  const w = Math.round(Math.min(area.w, Math.max(MIN_WINDOW_W, s.w)));
  const h = Math.round(Math.min(area.h, Math.max(MIN_WINDOW_H, s.h)));
  const minX = area.x;
  const minY = area.y;
  // Clamp so at least a grabbable strip of chrome stays on-screen.
  const maxX = area.x + Math.max(0, area.w - MIN_VISIBLE_CHROME);
  const maxY = area.y + Math.max(0, area.h - MIN_VISIBLE_CHROME);
  const x = isFiniteNumber(s.x)
    ? Math.round(Math.min(maxX, Math.max(minX, s.x)))
    : Math.round(area.x + (area.w - w) / 2);
  const y = isFiniteNumber(s.y)
    ? Math.round(Math.min(maxY, Math.max(minY, s.y)))
    : Math.round(area.y + (area.h - h) / 2);
  return { w, h, x, y };
}

/** Restored + clamped user geometry, or the spec-viewport default. */
export function computeWindowTarget(area: WorkArea, saved: unknown): WindowGeometry {
  return coerceGeometry(saved, area) ?? defaultGeometry(area);
}

function readWorkArea(): WorkArea | null {
  try {
    if (typeof window === "undefined" || !window.screen) return null;
    const s = window.screen;
    const w = s.availWidth || window.outerWidth;
    const h = s.availHeight || window.outerHeight;
    if (!isFiniteNumber(w) || !isFiniteNumber(h) || w <= 0 || h <= 0) return null;
    // availLeft/availTop exist at runtime (Chromium/WebView2) but are
    // absent from TS's Screen type — read them structurally.
    const withOrigin = s as Screen & { availLeft?: unknown; availTop?: unknown };
    return {
      x: isFiniteNumber(withOrigin.availLeft) ? withOrigin.availLeft : 0,
      y: isFiniteNumber(withOrigin.availTop) ? withOrigin.availTop : 0,
      w,
      h,
    };
  } catch {
    return null;
  }
}

function readSaved(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function currentGeometry(): WindowGeometry | null {
  try {
    const w = window.outerWidth;
    const h = window.outerHeight;
    const x = window.screenX;
    const y = window.screenY;
    if (![w, h, x, y].every(isFiniteNumber)) return null;
    // Skip minimized/hidden states (0-size or occluded reads) so a
    // minimize-to-tray never overwrites the user's real geometry.
    if (document.hidden || w < 400 || h < 300) return null;
    return { w: Math.round(w), h: Math.round(h), x: Math.round(x), y: Math.round(y) };
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    const g = currentGeometry();
    if (g && JSON.stringify(g) !== JSON.stringify(readSaved())) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(g));
    }
  } catch {
    /* storage unavailable: geometry just isn't remembered */
  }
}

/** Debounced save on resize + periodic save (catches moves, which fire no
 * web event) + flush on hide. Desktop shell only; safe to call twice. */
let tracking = false;
export function trackMainWindow(): void {
  try {
    if (tracking || typeof window === "undefined") return;
    tracking = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 600);
    };
    window.addEventListener("resize", debounced);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) persist();
    });
    window.addEventListener("pagehide", persist);
    window.setInterval(() => {
      if (!document.hidden) persist();
    }, 3000);
  } catch {
    /* tracking is best-effort */
  }
}

/**
 * Reveal the main window after geometry restore. The window starts hidden
 * (tauri.conf.json `visible: false`) so first paint and the restore resize
 * never flash on screen. Idempotent — call it from every boot exit
 * (post-restore, post-ready, failsafe) so a stuck boot can never trap the
 * user behind an invisible window. Desktop shell only — no-op in preview.
 */
export async function showMainWindow(): Promise<void> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().show();
  } catch {
    /* visible fallback stands / not a shell */
  }
}

/**
 * Restore the main window once at startup: user's saved geometry when it
 * still fits, else the spec viewport centered (never overlapping the
 * taskbar). Desktop shell only — no-op in the browser preview. Never
 * throws; failures keep the tauri.conf.json fallback.
 */
export async function restoreMainWindow(): Promise<void> {
  try {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const area = readWorkArea();
    if (!area) return;
    const target = computeWindowTarget(area, readSaved());
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    try {
      await win.setSize(new LogicalSize(target.w, target.h));
    } catch {
      /* keep current size: position still applies below */
    }
    try {
      await win.setPosition(new LogicalPosition(target.x, target.y));
    } catch {
      /* keep current position */
    }
  } catch {
    /* best-effort: the fallback size stands */
  } finally {
    try {
      const { isTauri } = await import("@tauri-apps/api/core");
      if (isTauri()) trackMainWindow();
    } catch {
      /* tracking is best-effort */
    }
  }
}
