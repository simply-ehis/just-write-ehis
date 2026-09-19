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
}

let nextId = 0;

export const toasts = writable<Toast[]>([]);
export const banners = writable<Banner[]>([]);

export function showToast(message: string, kind: ToastKind = "info", duration = 3000) {
  const id = nextId++;
  toasts.update((t) => [...t, { id, kind, message, duration }]);

  setTimeout(() => {
    toasts.update((t) => t.filter((x) => x.id !== id));
  }, duration);
}

export function showBanner(message: string, kind: BannerKind = "info") {
  const id = nextId++;
  banners.update((b) => [...b, { id, kind, message }]);
}

export function dismissBanner(id: number) {
  banners.update((b) => b.filter((x) => x.id !== id));
}
