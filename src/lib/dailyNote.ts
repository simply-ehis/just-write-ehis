/**
 * dailyNote — open today's daily note, creating it from the daily-note
 * template when it doesn't exist yet. Extracted from CommandPalette so
 * PWA shortcuts and launch params can reuse the exact same flow.
 */
import { get } from "svelte/store";
import { api } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";
import { createDocFromTemplate } from "$lib/stores/templates";

export async function openDailyNote(): Promise<void> {
  // Local calendar day (not UTC): toISOString at 11pm local already reads
  // as tomorrow, which would open/search the wrong note.
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  try {
    // Search the short title, then match the date line locally: the full
    // "Daily Note <date>" string never appears contiguously (title holds
    // the name, the body holds `# <date>`), so exact-phrase search misses
    // on substring backends and duplicates the note.
    const results = await api.docSearchFull("Daily Note");
    const hit = results.map((r) => r.doc).find((d) => (d.content ?? "").startsWith(`# ${today}`));
    if (hit) {
      currentDoc.set(hit);
      currentWorkspace.set(hit.workspace);
      const tabs = get(openTabs);
      if (!tabs.find((t) => t.id === hit.id)) {
        openTabs.set([hit, ...tabs]);
      }
      return;
    }
    // Create new daily note from template
    const docId = await createDocFromTemplate("daily-note", { date: today });
    if (docId) {
      const doc = await api.docGet(docId);
      currentDoc.set(doc);
      currentWorkspace.set(doc.workspace);
      openTabs.set([doc, ...get(openTabs)]);
    }
  } catch (e) {
    console.error("Failed to open daily note:", e);
  }
}
