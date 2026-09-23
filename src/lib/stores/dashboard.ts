/**
 * dashboard — single truth for Home cards + Stats (UsageMemory).
 *
 * Both surfaces read the same backend commands; this store is the one
 * frontend cache so they can never disagree. Commands underneath are
 * unchanged — only the callers consolidate here. Refresh is explicit
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
  streakHeatmap: { date: string; words: number }[];
  writingTimePatterns: { hour: number; count: number }[];
  writingVelocity: { date: string; words: number }[];
  productivityScore: {
    score: number;
    totalWords: number;
    totalDocs: number;
    activeDays: number;
    avgWords: number;
  } | null;
  loadedAt: number;
}

const EMPTY: DashboardStats = {
  reopenNeverFinish: [],
  streakHeatmap: [],
  writingTimePatterns: [],
  writingVelocity: [],
  productivityScore: null,
  loadedAt: 0,
};

export const dashboardStats = writable<DashboardStats>(EMPTY);

let inflight: Promise<void> | null = null;

/** Load all five stats commands at once; concurrent callers share one flight. */
export function refreshDashboardStats(): Promise<void> {
  if (!inflight) {
    inflight = (async () => {
      const [reopen, streak, patterns, velocity, productivity] = await Promise.all([
        api.getReopenNeverFinish(),
        api.dashboardStreakHeatmap(),
        api.dashboardWritingTimePatterns(),
        api.dashboardWritingVelocity(),
        api.dashboardProductivityScore(),
      ]);
      dashboardStats.set({
        reopenNeverFinish: reopen ?? [],
        streakHeatmap: streak ?? [],
        writingTimePatterns: patterns ?? [],
        writingVelocity: velocity ?? [],
        productivityScore: productivity,
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
