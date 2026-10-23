/**
 * osNotifications — OS-level notification surface.
 *
 * Desktop: the Tauri notification plugin (the Windows WebView exposes no
 * Notification API, so the old Web-only path was a silent no-op there).
 * Browser preview: the Web Notification API.
 *
 * Events wired here (owner decision 2026-10-22 — "those 2 first"):
 *   - hidden-app error toasts (pre-existing, notifyHiddenAppError)
 *   - conflict-found: external file change while the doc is open
 *   - long AI job finished: a generation that ran long enough that the
 *     user probably switched away
 * All respect `settings.desktopNotificationsEnabled` and only fire while
 * the app is hidden — if you're looking at the app, the banner/panel is
 * the notification.
 */
import { get } from "svelte/store";
import { isTauri } from "@tauri-apps/api/core";
import { settings } from "$lib/stores/settings";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// Inlined (not imported from $lib/api) to keep this module cycle-free:
// api → errors → notifications → osNotifications would otherwise loop.
function isBrowserPreview(): boolean {
  try {
    return !isTauri();
  } catch {
    return true;
  }
}

export type OsNotificationSetup = "enabled" | "unsupported" | "denied" | "failed";

/** A generation at least this long raises a finished notification. */
export const LONG_AI_JOB_SECONDS = 30;

export async function requestOsNotificationPermission(): Promise<OsNotificationSetup> {
  if (!isBrowserPreview()) {
    try {
      const granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
      return granted ? "enabled" : "denied";
    } catch {
      return "failed";
    }
  }
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission === "granted") return "enabled";
    return permission === "denied" ? "denied" : "failed";
  } catch {
    return "failed";
  }
}

function sendOsNotification(title: string, body: string, tag: string): void {
  if (!isBrowserPreview()) {
    try {
      // No `tag` on the plugin's Options (Web-only concept) — each send is a
      // fresh toast; distinct titles keep the events distinguishable.
      sendNotification({ title, body });
    } catch (error) {
      console.warn("Could not show OS notification:", error);
    }
    return;
  }
  try {
    if (
      typeof window === "undefined" ||
      !("Notification" in window) ||
      Notification.permission !== "granted"
    ) return;
    new Notification(title, { body, tag });
  } catch (error) {
    console.warn("Could not show OS notification:", error);
  }
}

/** True when the user cannot see the app right now. */
function appHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Error toasts escalate to the OS when the setting is on and the app is hidden. */
export function notifyHiddenAppError(message: string): void {
  if (!get(settings).desktopNotificationsEnabled || !appHidden()) return;
  sendOsNotification("Just Write ehis", message.slice(0, 240), "just-write-error");
}

/**
 * Conflict-found: the file changed on disk under an open doc. The docked
 * banner covers the visible case, so the OS notification is for when the
 * app is hidden.
 */
export function notifyConflictFound(path: string): void {
  if (!get(settings).desktopNotificationsEnabled || !appHidden()) return;
  sendOsNotification(
    "File changed externally",
    path.slice(0, 240),
    "just-write-conflict",
  );
}

/**
 * Long AI job finished. Fires only when the app is hidden — the panel's
 * own status line is the in-app signal. Errors skip this path: they
 * already raise a hidden-app error toast notification.
 */
export function notifyLongAiJobFinished(seconds: number): void {
  if (!get(settings).desktopNotificationsEnabled || !appHidden()) return;
  sendOsNotification(
    "AI job finished",
    `Completed in ${seconds}s — switch back to review.`,
    "just-write-ai-done",
  );
}
