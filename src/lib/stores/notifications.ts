import { writable } from "svelte/store";

export type ToastKind = "success" | "error" | "warning" | "info";
export type BannerKind = "warning" | "error" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  duration: number;
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

export function showToast(message: string, kind: ToastKind = "info", duration = 3000) {
  const id = nextId++;
  toasts.update((t) => {
    const next = [...t, { id, kind, message, duration }];
    if (next.length <= 3) return next;
    // Evict the oldest NON-error first: a data-loss error must not be
    // silently dropped because three success toasts arrived after it.
    const evict = next.find((x) => x.kind !== "error") ?? next[0];
    return next.filter((x) => x.id !== evict.id);
  });

  // Errors latch until dismissed — a 3s window is not enough to notice
  // (let alone act on) a failed save. Toast.svelte is click-to-dismiss.
  if (kind === "error") return;
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
