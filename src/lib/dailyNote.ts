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
  const today = new Date().toISOString().split("T")[0];
  try {
    // Search for existing daily note
    const results = await api.docSearchFull(`Daily Note ${today}`);
    if (results.length > 0) {
      const doc = results[0].doc;
      currentDoc.set(doc);
      currentWorkspace.set(doc.workspace);
      const tabs = get(openTabs);
      if (!tabs.find((t) => t.id === doc.id)) {
        openTabs.set([doc, ...tabs]);
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
