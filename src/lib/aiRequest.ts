/**
 * aiRequest — ONE definition for AI request plumbing shared by the panel
 * and the browser preview backend (Rust mirrors the same strings; see
 * friendly_http_status in commands.rs — language boundary, tested there).
 *
 * - friendlyEndpointError(): maps transport/HTTP failures to the exact
 *   user-facing strings the panel shows in Error bubbles + retry.
 * - shouldRetryStatus(): 429/503 only — everything else fails fast.
 * - rateLimited(): pure cooldown check behind the panel's guardRate().
 */
export function friendlyEndpointError(msg: unknown): string {
  const text = msg instanceof Error ? msg.message : String(msg);
  if (text.includes("401") || text.includes("403")) {
    return "API key rejected — check your provider settings";
  }
  if (text.includes("429")) return "Rate limited — wait a moment";
  if (text.includes("408") || text.includes("timed out")) {
    return "Request timed out — the model may be overloaded";
  }
  if (text.includes("503")) return "Model server overloaded — try again in a moment";
  const lower = text.toLowerCase();
  if (
    lower.includes("econnrefused") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("failed to fetch")
  ) {
    return "Can't reach AI server — is it running?";
  }
  return text;
}

/** Retry with backoff for 429/503 only; everything else fails fast. */
export function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 503;
}

/** Pure cooldown check: true when a send must wait. */
export function rateLimited(now: number, lastSend: number, cooldownMs: number): boolean {
  return cooldownMs > 0 && now - lastSend < cooldownMs;
}

export const RETRY_BACKOFF_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
