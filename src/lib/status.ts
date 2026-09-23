/**
 * status — the single status→color map for every board in the app.
 * Properties, Projects, and Novel each had their own copy (Novel's even
 * disagreed on `done`). One map, one meaning: draft = accent, revised =
 * green, final/done = purple, cut = red, everything else muted.
 */
export function statusColor(status: string): string {
  switch (status) {
    case "draft":
      return "var(--accent-primary)";
    case "revised":
      return "var(--accent-semantic-green)";
    case "final":
    case "done":
      return "var(--accent-semantic-purple)";
    case "cut":
      return "var(--accent-semantic-red)";
    default:
      return "var(--text-muted)";
  }
}
