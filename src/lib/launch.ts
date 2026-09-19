/**
 * launch — PWA entry points: share target, app shortcuts, notification taps.
 *
 * The manifest declares `share_target: /?share=target` (GET title/text/url)
 * and shortcuts `?new=doc`, `?daily=note`, `?capture=inbox`. Nothing in the
 * app read them until now: `consumeLaunchParams()` runs once at boot (after
 * tab restore, so a launch intent wins) and routes each intent. Shared /
 * captured text never creates a doc directly — it goes through the Inbox
 * capture box via `sendToCapture()`, so triage stays the single funnel.
 *
 * Also owns the Android "notification" capture method: `pinCaptureNotification()`
 * shows a sticky notification whose tap opens `?capture=inbox` (handled by
 * the `notificationclick` handler in public/sw.js). The "widget" method
 * needs the native Tauri-Android shell and is documented as such in TODOS.
 */
import { get } from "svelte/store";
import { api, isBrowserPreview } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";
import { sendToCapture } from "$lib/stores/capture";
import { openDailyNote } from "$lib/dailyNote";
import { markUsed } from "$lib/features";

export type LaunchIntent =
  | { kind: "share"; text: string }
  | { kind: "capture" }
  | { kind: "new-doc" }
  | { kind: "daily" };

/** Pure parse — takes a query string so it stays unit-testable. */
export function parseLaunchParams(search: string): LaunchIntent | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  if (params.get("share") === "target") {
    const parts = [params.get("title") ?? "", params.get("text") ?? "", params.get("url") ?? ""]
      .map((s) => s.trim())
      .filter(Boolean);
    // Empty share (some browsers fire the target with no params) still
    // opens the Inbox so the user can type.
    return { kind: "share", text: parts.join("\n") };
  }
  if (params.get("capture") === "inbox") return { kind: "capture" };
  if (params.get("new") === "doc") return { kind: "new-doc" };
  if (params.get("daily") === "note") return { kind: "daily" };
  return null;
}

async function openNewDoc(): Promise<void> {
  try {
    const doc = await api.docCreate("write", "doc", "Untitled");
    currentDoc.set(doc);
    currentWorkspace.set("write");
    const tabs = get(openTabs);
    openTabs.set(tabs.find((t) => t.id === doc.id) ? tabs : [doc, ...tabs]);
  } catch (e) {
    console.error("Failed to create doc from launch shortcut:", e);
  }
}

export async function handleLaunchIntent(intent: LaunchIntent): Promise<void> {
  switch (intent.kind) {
    case "share":
      currentWorkspace.set("inbox");
      sendToCapture(intent.text);
      markUsed("inbox");
      break;
    case "capture":
      currentWorkspace.set("inbox");
      sendToCapture("");
      markUsed("inbox");
      break;
    case "new-doc":
      await openNewDoc();
      markUsed("write");
      break;
    case "daily":
      await openDailyNote();
      break;
  }
}

/**
 * Read the boot URL once, strip the params (so a reload doesn't
 * re-trigger), and route. Returns true when an intent was handled.
 */
export async function consumeLaunchParams(): Promise<boolean> {
  let search = "";
  try {
    search = window.location.search;
  } catch {
    return false;
  }
  const intent = parseLaunchParams(search);
  if (!intent) return false;
  try {
    const url = new URL(window.location.href);
    for (const key of ["share", "title", "text", "url", "capture", "new", "daily"]) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* cosmetic: worst case a reload re-triggers the intent */
  }
  await handleLaunchIntent(intent);
  return true;
}

/**
 * Service-worker → app bridge for content shared while the app is open.
 * The SW forwards SHARED_CONTENT messages; the payload shape matches the
 * manifest GET params ({ title?, text?, url? }).
 */
export function listenForSharedContent(): void {
  try {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { type?: string; payload?: { title?: string; text?: string; url?: string } } | null;
      if (!data || data.type !== "SHARED_CONTENT") return;
      const p = data.payload ?? {};
      const text = [p.title ?? "", p.text ?? "", p.url ?? ""].map((s) => s.trim()).filter(Boolean).join("\n");
      void handleLaunchIntent({ kind: "share", text });
    });
  } catch {
    /* messaging unavailable: share target via boot URL still works */
  }
}

export type NotificationState = "unsupported" | "denied" | "granted" | "prompt";

export function captureNotificationState(): NotificationState {
  try {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission as NotificationState;
  } catch {
    return "unsupported";
  }
}

/**
 * Android "notification" capture method: pin a sticky notification whose
 * tap opens the capture box (`?capture=inbox`, via sw.js
 * `notificationclick`). Re-pinning replaces the previous one (same tag).
 * Returns a human-readable status for the Settings button.
 */
export async function pinCaptureNotification(): Promise<string> {
  if (captureNotificationState() === "unsupported") {
    return "Notifications aren't available here (needs the installed PWA or the Android app).";
  }
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return "Couldn't ask for notification permission.";
  }
  if (permission !== "granted") {
    return "Notification permission denied — enable it in the browser/site settings, then try again.";
  }
  try {
    if (!("serviceWorker" in navigator)) throw new Error("no service worker");
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification("Quick capture", {
      body: "Tap to capture to Inbox",
      tag: "jwe-capture",
      renotify: false,
      data: { url: `${location.origin}${location.pathname}?capture=inbox` },
    } as NotificationOptions & { renotify?: boolean });
    return "Pinned — tap the notification any time to capture.";
  } catch {
    // No SW (Tauri shell, insecure context): fall back to a page
    // notification, which still works while the app is open.
    try {
      new Notification("Quick capture", { body: "App is open — use the Inbox capture box.", tag: "jwe-capture" });
      return "Pinned for this session (no service worker here, so it won't survive app close).";
    } catch {
      return "Couldn't show the notification.";
    }
  }
}

/** Browser-only setup: SW bridge. Safe to call under Tauri (no-ops). */
export function setupLaunchBridge(): void {
  if (isBrowserPreview()) listenForSharedContent();
}
