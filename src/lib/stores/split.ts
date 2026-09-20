import { writable } from "svelte/store";

/** Split-pane target for AI write-back (the Write tab's second editor). */
export interface SplitTarget {
  id: string;
  title: string;
}

/** Null when no split is open. Set by JustWriteWorkspace, read by AiPanel. */
export const splitTarget = writable<SplitTarget | null>(null);
