import { get } from "svelte/store";
import { api, isBrowserPreview, type BibleMemoryRebuild, type Doc } from "$lib/api";
import { ensureLlm } from "$lib/stores/audio";
import { settings } from "$lib/stores/settings";
import { assertAiAllowedForDoc } from "$lib/stores/lock";

const SAVE_DEBOUNCE_MS = 4000;
const RETRY_DELAYS_MS = [60000, 180000, 600000, 900000];

type QueueEntry = {
  retries: number;
  expectedContent: string;
  timer: ReturnType<typeof setTimeout> | null;
};

const queue = new Map<string, QueueEntry>();

function announce(scopeId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("story-memory-updated", { detail: { scopeId } }));
}

function retry(entry: QueueEntry, doc: Doc): void {
  if (queue.get(doc.id) !== entry) return;
  if (entry.retries >= RETRY_DELAYS_MS.length) {
    queue.delete(doc.id);
    return;
  }
  const delay = RETRY_DELAYS_MS[entry.retries];
  entry.retries += 1;
  entry.timer = setTimeout(() => run(entry, doc), delay);
}

async function run(entry: QueueEntry, doc: Doc): Promise<void> {
  if (queue.get(doc.id) !== entry) return;
  if (isBrowserPreview() || !get(settings).llmEnabled) return;
  try {
    assertAiAllowedForDoc(doc);
  } catch {
    queue.delete(doc.id);
    return;
  }
  try {
    if (!(await ensureLlm())) {
      retry(entry, doc);
      return;
    }
    if (queue.get(doc.id) !== entry) return;
    const result = await api.bibleExtractMentions(doc.id, entry.expectedContent);
    if (queue.get(doc.id) !== entry) return;
    if (result.skipped) {
      if (result.retryable) {
        retry(entry, doc);
      } else {
        queue.delete(doc.id);
      }
      return;
    }
    queue.delete(doc.id);
    announce();
  } catch {
    retry(entry, doc);
  }
}

export function scheduleStoryMemory(doc: Doc, content: string): void {
  if (isBrowserPreview() || (doc.kind !== "scene" && doc.kind !== "chapter")) return;
  const previous = queue.get(doc.id);
  if (previous?.timer) clearTimeout(previous.timer);
  const entry: QueueEntry = { retries: 0, expectedContent: content, timer: null };
  queue.set(doc.id, entry);
  entry.timer = setTimeout(() => run(entry, doc), SAVE_DEBOUNCE_MS);
}

export async function rebuildStoryMemory(project: Doc): Promise<BibleMemoryRebuild> {
  if (isBrowserPreview()) return { skipped: true, retryable: false, processed: 0, matched: 0, suggested: 0 };
  try {
    assertAiAllowedForDoc(project);
  } catch {
    return { skipped: true, retryable: false, processed: 0, matched: 0, suggested: 0 };
  }
  if (!get(settings).llmEnabled || !(await ensureLlm())) {
    return { skipped: true, retryable: false, processed: 0, matched: 0, suggested: 0 };
  }
  try {
    const result = await api.bibleRebuildMemory(project.id);
    if (result.processed > 0 || result.matched > 0 || result.suggested > 0) announce(project.id);
    return result;
  } catch {
    return { skipped: true, retryable: false, processed: 0, matched: 0, suggested: 0 };
  }
}
