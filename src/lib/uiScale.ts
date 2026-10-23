import { isBrowserPreview } from "$lib/api";
import { warnOnce } from "$lib/errors";

export const UI_SCALE_MIN = 0.8;
export const UI_SCALE_MAX = 1.6;
export const UI_SCALE_STEP = 0.05;

export function clampUiScale(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
  const stepped = Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.round(Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped)) * 100) / 100;
}

/**
 * Scale the whole interface (icons, buttons, text) like browser zoom.
 * The app is sized in px, so a root font-size trick would do nothing; the
 * native webview zoom scales everything uniformly and keeps CodeMirror's
 * pointer maths correct (CSS `zoom` does not). Browser/PWA builds already
 * have the browser's own zoom, so this is a no-op there.
 */
export async function applyUiScale(scale: unknown): Promise<void> {
  if (isBrowserPreview()) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(clampUiScale(scale));
  } catch (e) {
    warnOnce("Interface size", e);
  }
}
