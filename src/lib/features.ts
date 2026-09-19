/**
 * features — feature-usage tracking for skill nudges.
 *
 * SkillNudges.svelte shows unused-power-feature hints sparingly; every
 * hint retires forever once its feature is actually used (or dismissed).
 * Kept in a plain module (not a component) so any workspace can import it.
 */
import { get } from "svelte/store";
import { settings } from "$lib/stores/settings";

export function markUsed(feature: string): void {
  const current = get(settings);
  if (!current.featuresUsed.includes(feature)) {
    settings.set({ ...current, featuresUsed: [...current.featuresUsed, feature] });
  }
}

export function dismissNudge(id: string): void {
  const current = get(settings);
  if (!current.dismissedNudges.includes(id)) {
    settings.set({ ...current, dismissedNudges: [...current.dismissedNudges, id] });
  }
}
