/**
 * Global loading state — thin indeterminate line under TabBar (A9.2).
 * Set to true during background work (indexing, backup, AI generation).
 */
import { writable } from "svelte/store";

export const globalLoading = writable(false);
