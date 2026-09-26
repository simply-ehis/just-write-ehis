/**
 * support — Support page data + feedback mailto composer.
 *
 * Pure module (no Svelte, no DOM): safe to unit-test in plain node.
 *
 * The repo is private, so there is no public issue tracker. Feedback
 * travels by email; nothing is ever sent automatically — opening the mail
 * app (or copying the draft) is always an explicit tap.
 *
 * Feedback travels by email; nothing is ever sent automatically — opening
 * the mail app (or copying the draft) is always an explicit tap.
 */

export const SUPPORT_EMAIL = "hehisehis@gmail.com";
export const COMPANY_NAME = "simply-ehis";
export const COMPANY_BLURB =
  "Simply Ehis is one independent developer making personal software — starting with Just Write ehis, a super app for writing and everything around it.";
/** Public support hub (static site). */
export const SUPPORT_SITE_URL = "https://ehis.pages.dev";
/** True while the maker blurb and logo above are placeholders. */
export const SUPPORT_PLACEHOLDER = false;

export type FeedbackSeverity = "bug" | "idea" | "question" | "other";

export const SEVERITY_LABELS: Record<FeedbackSeverity, string> = {
  bug: "Bug report",
  idea: "Feature idea",
  question: "Question",
  other: "Other",
};

export interface FeedbackDraft {
  subject: string;
  message: string;
  severity: FeedbackSeverity;
}

export interface DiagnosticsSnapshot {
  version: string;
  desktop: boolean;
  theme: string;
  themeMode: string;
}

/** One-line-per-fact block appended to the feedback email body. */
export function buildDiagnosticsSnapshot(snap: DiagnosticsSnapshot): string {
  return [
    "---",
    "Diagnostics (auto-attached, edit or delete as you like):",
    `app version: ${snap.version || "unknown"}`,
    `platform: ${snap.desktop ? "desktop app" : "browser preview"}`,
    `theme: ${snap.theme || "unknown"} / ${snap.themeMode || "unknown"}`,
  ].join("\n");
}

const MAX_MAILTO_BODY = 1500;

/**
 * Compose the feedback email. Long messages are truncated (mailto URLs
 * have practical length limits) and the cut is marked loudly, never
 * silent. Returns the mailto: URL and whether truncation happened.
 */
export function buildFeedbackMailto(
  draft: FeedbackDraft,
  snapshot: string
): { url: string; truncated: boolean } {
  const subject = `[${SEVERITY_LABELS[draft.severity] ?? "Feedback"}] ${((draft.subject || "").trim() || "Untitled feedback")}`.slice(0, 200);
  let message = draft.message.trim() || "(no details written)";
  let truncated = false;
  if (message.length > MAX_MAILTO_BODY) {
    message = message.slice(0, MAX_MAILTO_BODY);
    truncated = true;
  }
  const body = [
    message,
    ...(truncated ? ["", "(message truncated to fit the email link — paste the rest manually)"] : []),
    "",
    snapshot,
  ].join("\n");
  const url =
    `mailto:${SUPPORT_EMAIL}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  return { url, truncated };
}

/** Plain-text version of the same draft for the copy-to-clipboard fallback. */
export function buildFeedbackText(draft: FeedbackDraft, snapshot: string): string {
  const subject = `[${SEVERITY_LABELS[draft.severity] ?? "Feedback"}] ${((draft.subject || "").trim() || "Untitled feedback")}`;
  return [`To: ${SUPPORT_EMAIL}`, `Subject: ${subject}`, "", draft.message.trim() || "(no details written)", "", snapshot].join("\n");
}
