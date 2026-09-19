/**
 * capture — cross-entry quick-capture plumbing.
 *
 * The Inbox owns the capture box; PWA shortcuts, the share target, and
 * notification taps only *request* captures. These stores are the handoff:
 * `capturePrefill` text is appended to the box once, `captureFocus` bumps
 * to focus it. Consumed (cleared) by InboxWorkspace.
 */
import { writable } from "svelte/store";

/** Text waiting to be appended to the Inbox capture box. */
export const capturePrefill = writable<string>("");

/** Bump to focus the Inbox capture box. Inbox consumes the bump. */
export const captureFocus = writable<number>(0);

/** Queue text for the Inbox and request focus there. */
export function sendToCapture(text: string): void {
  if (text) capturePrefill.update((cur) => (cur ? cur + "\n" + text : text));
  captureFocus.update((n) => n + 1);
}
