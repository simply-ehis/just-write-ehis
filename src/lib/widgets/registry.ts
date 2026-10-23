/**
 * Widget registry — the ONE place that says what a widget is.
 *
 * A widget is NOT a window that hosts a whole tab. It is a small, purpose-
 * built mini version of a tab that does exactly one job. Only the kinds
 * listed here exist; adding a kind means writing its mini component, not
 * pointing a window at an existing workspace.
 *
 * Pure data + pure helpers so tests can import it headlessly.
 */

export type WidgetKind = "quicknote" | "reader";

export interface WidgetSpec {
  id: WidgetKind;
  /** Shown in the widget bar and in Settings. */
  label: string;
  /** The single job, in one line (Settings help text). */
  job: string;
  /** The full workspace the "open in app" button jumps to. */
  opens: "logs" | "reader";
  /** Window size the first time this kind is shown (logical px). */
  initial: { w: number; h: number };
}

/** Real-widget floor and ceiling. The OS enforces the floor (window minWidth/minHeight). */
export const WIDGET_MIN = { w: 280, h: 180 } as const;
export const WIDGET_MAX = { w: 720, h: 1000 } as const;

export const WIDGET_KINDS: readonly WidgetSpec[] = [
  {
    id: "quicknote",
    label: "Quick note",
    job: "Jot a note into today's log. Nothing else.",
    opens: "logs",
    initial: { w: 340, h: 240 },
  },
  {
    id: "reader",
    label: "Reader",
    job: "Read the book you're on, one section at a time. Nothing else.",
    opens: "reader",
    initial: { w: 380, h: 480 },
  },
];

export const DEFAULT_WIDGET_KIND: WidgetKind = "quicknote";

export function isWidgetKind(value: unknown): value is WidgetKind {
  return WIDGET_KINDS.some((kind) => kind.id === value);
}

/** Unknown or retired values fall back to the default instead of breaking the widget. */
export function widgetSpec(kind: unknown): WidgetSpec {
  return WIDGET_KINDS.find((spec) => spec.id === kind) ?? WIDGET_KINDS[0];
}

export function clampWidgetSize(w: number, h: number): { w: number; h: number } {
  const fix = (n: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, Number.isFinite(n) ? n : min)));
  return { w: fix(w, WIDGET_MIN.w, WIDGET_MAX.w), h: fix(h, WIDGET_MIN.h, WIDGET_MAX.h) };
}
