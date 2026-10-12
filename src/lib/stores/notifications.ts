import { writable } from "svelte/store";

export type ToastKind = "success" | "error" | "warning" | "info";
export type BannerKind = "warning" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  duration: number;
  /** Optional inline undo/action button (e.g. "Undo" after Mark Finished). */
  action?: { label: string; run: () => void };
}

export interface Banner {
  id: number;
  kind: BannerKind;
  message: string;
  /** Optional inline action (e.g. "Open Capture" on the triage banner). */
  action?: { label: string; run: () => void };
}

let nextId = 0;

export const toasts = writable<Toast[]>([]);
export const banners = writable<Banner[]>([]);

/**
 * showToast — transient notification. `action` renders an inline button
 * (e.g. "Undo") next to the message; running it dismisses the toast.
 * Additive: existing 3-arg callers are unchanged.
 *
 * Note: an action toast never latches, even for kind "error" — the action
 * button is the recovery path, so it must stay clickable.
 */
export function showToast(
  message: string,
  kind: ToastKind = "info",
  duration = 3000,
  action?: Toast["action"]
) {
  const id = nextId++;
  toasts.update((t) => {
    const next = [...t, { id, kind, message, duration, action }];
    if (next.length <= 3) return next;
    // Evict the oldest NON-error first: a data-loss error must not be
    // silently dropped because three success toasts arrived after it.
    const evict = next.find((x) => x.kind !== "error") ?? next[0];
    return next.filter((x) => x.id !== evict.id);
  });

  // Errors latch until dismissed — a 3s window is not enough to notice
  // (let alone act on) a failed save. Toast.svelte is click-to-dismiss.
  // An action button is the explicit recovery path, so it stays live.
  if (kind === "error" && !action) return;
  setTimeout(() => {
    toasts.update((t) => t.filter((x) => x.id !== id));
  }, duration);
}

export function dismissToast(id: number) {
  toasts.update((t) => t.filter((x) => x.id !== id));
}

export function showBanner(message: string, kind: BannerKind = "info", action?: Banner["action"]) {
  const id = nextId++;
  banners.update((b) => [...b, { id, kind, message, action }]);
  return id;
}

export function dismissBanner(id: number) {
  banners.update((b) => b.filter((x) => x.id !== id));
}
