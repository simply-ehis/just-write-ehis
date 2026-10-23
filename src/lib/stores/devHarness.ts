/**
 * devHarness — visibility flag for the TTS listen-test harness.
 *
 * Desktop manual QA page (gaps / mid-page skips / speed changes): opened
 * from the command palette ("TTS listen harness (dev)") or by booting
 * with `?listen-harness=1`. Not a workspace — an overlay, so no
 * workspace enum/validation/sidebar surface changes.
 */
import { writable } from "svelte/store";

export const listenHarnessOpen = writable(false);

// Boot-param entry (web preview + any webview that carries the query).
try {
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("listen-harness") === "1") {
    listenHarnessOpen.set(true);
  }
} catch {
  /* no location (tests, workers) — palette entry still works */
}
