/**
 * errors — one vocabulary for failure across the app.
 *
 * Every user-visible failure speaks as `Domain — couldn't <action>: <reason>`
 * (e.g. "Novel — couldn't open scene: …"), so the message always says which
 * part of the app broke and what the user was doing. Background telemetry
 * stays out of the user's face but still logs once per session per site.
 */
import { showToast } from "$lib/stores/notifications";

/** User-facing, domain-tied error. Shows a Toast and returns the message. */
export function domainError(domain: string, action: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  const message = `${domain} — ${action}: ${reason}`;
  try {
    showToast(message, "error");
  } catch {
    /* notifications unavailable: message still returned + logged below */
  }
  console.error(message);
  return message;
}

/** Session-once console warning for background/telemetry failures. */
const warned = new Set<string>();
export function warnOnce(site: string, err: unknown): void {
  if (warned.has(site)) return;
  warned.add(site);
  console.warn(`${site}:`, err);
}

/**
 * True when a Tauri invoke failed because the window ACL grants nothing
 * for the command. Tauri rejects with a bare "not allowed" message that
 * names no command and suggests no fix — match on the stable fragments.
 * Deliberately narrow: a mere mention of "ACL" elsewhere is not a denial.
 */
export function isAclDenied(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /not allowed|not permitted|denied by acl/i.test(text);
}

/** Readable text for an ACL-denied command (api.ts wraps, App.svelte probes). */
export function aclDeniedMessage(cmd: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `App permissions blocked "${cmd}" (${raw}). Rebuild the desktop app after fixing the window ACL.`;
}
