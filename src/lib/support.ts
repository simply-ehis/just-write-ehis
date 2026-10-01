/**
 * support — Support page data + GitHub issue composer.
 *
 * Pure module (no Svelte, no DOM): safe to unit-test in plain node.
 *
 * Nothing is ever sent automatically — opening the tracker or copying the
 * draft is always an explicit tap.
 */

/** Public tracker backing the feedback path. */
export const GITHUB_OWNER = "simply-ehis";
export const GITHUB_REPO = "just-write-ehis";
export const GITHUB_ISSUES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/issues`;
export const COMPANY_NAME = "simply-ehis";
export const COMPANY_BLURB =
  "Simply Ehis is one independent developer making personal software — starting with Just Write ehis, a super app for writing and everything around it.";
/** Public support hub (static site). */
export const SUPPORT_SITE_URL = "https://ehis.pages.dev";
/** False: the maker blurb and logo above are final, not placeholders. Kept
 * as an explicit signal (tests/support-unit.mjs asserts it) so a future
 * placeholder swap cannot pass silently. */
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
  bootMs?: number | null;
  prevExit?: string;
  stuckStep?: string | null;
  slowCalls?: string;
}

/** "cmd 123ms, other 4ms" for panels and pasted diagnostics. */
export function formatSlowCalls(calls: { cmd: string; ms: number }[]): string {
  return calls.map((c) => `${c.cmd} ${c.ms}ms`).join(", ");
}

/** One-line-per-fact block appended to the feedback email body. */
export function buildDiagnosticsSnapshot(snap: DiagnosticsSnapshot): string {
  const lines = [
    "---",
    "Diagnostics (auto-attached, edit or delete as you like):",
    `app version: ${snap.version || "unknown"}`,
    `platform: ${snap.desktop ? "desktop app" : "browser preview"}`,
    `theme: ${snap.theme || "unknown"} / ${snap.themeMode || "unknown"}`,
  ];
  if (snap.bootMs != null) lines.push(`last boot: ${snap.bootMs}ms`);
  if (snap.prevExit) lines.push(`previous session: ${snap.prevExit}`);
  if (snap.stuckStep) lines.push(`stuck boot step: ${snap.stuckStep}`);
  if (snap.slowCalls) lines.push(`slow calls: ${snap.slowCalls}`);
  return lines.join("\n");
}

const MAX_LINK_BODY = 1500;

function buildFeedbackSubject(draft: FeedbackDraft): string {
  return `[${SEVERITY_LABELS[draft.severity] ?? "Feedback"}] ${((draft.subject || "").trim() || "Untitled feedback")}`.slice(0, 200);
}

/** Shared body builder: truncates loudly (link URLs have practical length limits). */
function buildFeedbackBody(
  draft: FeedbackDraft,
  snapshot: string,
  maxLen: number
): { body: string; truncated: boolean } {
  let message = draft.message.trim() || "(no details written)";
  let truncated = false;
  if (message.length > maxLen) {
    message = message.slice(0, maxLen);
    truncated = true;
  }
  const body = [
    message,
    ...(truncated ? ["", "(message truncated to fit the link — paste the rest manually)"] : []),
    "",
    snapshot,
  ].join("\n");
  return { body, truncated };
}

/**
 * Compose a prefilled GitHub issue URL (title + body query params).
 * Opens the tracker with everything filled in; the user still presses
 * Submit there. Returns the URL and whether the message was truncated.
 */
export function buildIssueUrl(
  draft: FeedbackDraft,
  snapshot: string
): { url: string; truncated: boolean } {
  const subject = buildFeedbackSubject(draft);
  const { body, truncated } = buildFeedbackBody(draft, snapshot, MAX_LINK_BODY);
  const url =
    `${GITHUB_ISSUES_URL}/new` +
    `?title=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`;
  return { url, truncated };
}

/** Plain-text version of the same draft for the copy-to-clipboard fallback. */
export function buildFeedbackText(draft: FeedbackDraft, snapshot: string): string {
  const subject = `[${SEVERITY_LABELS[draft.severity] ?? "Feedback"}] ${((draft.subject || "").trim() || "Untitled feedback")}`;
  return [`Subject: ${subject}`, "", draft.message.trim() || "(no details written)", "", snapshot].join("\n");
}
