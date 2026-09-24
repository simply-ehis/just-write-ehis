import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, isBrowserPreview } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs, showSettings } from "$lib/stores/app";
import { showToast } from "$lib/stores/notifications";

export async function openNativeFile(path: string): Promise<void> {
  try {
    const doc = await api.openExternalFile(path);
    if (!doc) return;
    currentDoc.set(doc);
    currentWorkspace.set(doc.workspace);
    showSettings.set(false);
    openTabs.update((tabs) => tabs.some((tab) => tab.id === doc.id) ? tabs : [doc, ...tabs]);
    await api.usageRecord(doc.id, "open").catch(() => {});
  } catch (e) {
    showToast(`Couldn't open ${path}: ${e instanceof Error ? e.message : e}`, "error");
  }
}

export async function consumeNativeLaunchFile(): Promise<void> {
  if (isBrowserPreview()) return;
  const path = await api.takeLaunchFile();
  if (path) await openNativeFile(path);
}

export async function listenForNativeFileOpen(): Promise<UnlistenFn> {
  if (isBrowserPreview()) return () => {};
  return listen("native-file-open", () => {
    void consumeNativeLaunchFile();
  });
}
