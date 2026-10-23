/**
 * dashboard — single truth for Home cards + Stats (UsageMemory).
 *
 * Both surfaces read the same backend commands; this store is the one
 * frontend cache so they can never disagree. Refresh is explicit
 * (doc/workspace change, manual invalidate), never polled.
 */
import { writable } from "svelte/store";
import { api } from "$lib/api";

export interface ReopenItem {
  doc: { id: string; title: string; workspace: string };
  openCount: number;
  lastOpened: string;
}

export interface DashboardStats {
  reopenNeverFinish: ReopenItem[];
  activityHeatmap: { date: string; activity: number }[];
  writingTimePatterns: { hour: number; count: number }[];
  writingActivity: { date: string; activity: number }[];
  libraryStats: {
    totalWords: number;
    totalDocs: number;
    activeDays: number;
    avgWords: number;
  } | null;
  loadedAt: number;
}

const EMPTY: DashboardStats = {
  reopenNeverFinish: [],
  activityHeatmap: [],
  writingTimePatterns: [],
  writingActivity: [],
  libraryStats: null,
  loadedAt: 0,
};

export const dashboardStats = writable<DashboardStats>(EMPTY);

let inflight: Promise<void> | null = null;

/** Load all five stats commands at once; concurrent callers share one flight. */
export function refreshDashboardStats(): Promise<void> {
  if (!inflight) {
    inflight = (async () => {
      const [reopen, heatmap, patterns, activity, libraryStats] = await Promise.all([
        api.getReopenNeverFinish(),
        api.dashboardActivityHeatmap(),
        api.dashboardWritingTimePatterns(),
        api.dashboardWritingActivity(),
        api.dashboardLibraryStats(),
      ]);
      dashboardStats.set({
        reopenNeverFinish: reopen ?? [],
        activityHeatmap: heatmap ?? [],
        writingTimePatterns: patterns ?? [],
        writingActivity: activity ?? [],
        libraryStats,
        loadedAt: Date.now(),
      });
    })();
    void inflight.finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/** Drop the cache (e.g. after clearing usage history). Next read refreshes. */
export function invalidateDashboardStats(): void {
  dashboardStats.set(EMPTY);
}
