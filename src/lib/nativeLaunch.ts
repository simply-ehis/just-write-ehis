import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, isBrowserPreview } from "$lib/api";
import { warnOnce } from "$lib/errors";
import { currentDoc, currentWorkspace, externalFilePreview, openTabs, showSettings } from "$lib/stores/app";
import { showToast } from "$lib/stores/notifications";

/** Open the file the backend recorded from argv / the OS file association. */
async function openNativeFile(): Promise<void> {
  try {
    // No path argument: the backend reads the file it recorded from argv / the
    // OS file association. The renderer deliberately cannot name a path here.
    const opened = await api.openExternalFile();
    if (!opened) return;
    showSettings.set(false);
    if (opened.kind === "preview") {
      currentDoc.set(null);
      currentWorkspace.set("properties");
      externalFilePreview.set({ ...opened.preview, id: `${Date.now()}-${Math.random()}` });
      return;
    }
    externalFilePreview.set(null);
    const doc = opened.doc;
    currentDoc.set(doc);
    currentWorkspace.set(doc.workspace);
    openTabs.update((tabs) => tabs.some((tab) => tab.id === doc.id) ? tabs : [doc, ...tabs]);
    await api.usageRecord(doc.id, "open").catch((e) => warnOnce("Launch usage telemetry", e));
  } catch (e) {
    showToast(`Couldn't open the file: ${e instanceof Error ? e.message : e}`, "error");
  }
}

export async function consumeNativeLaunchFile(): Promise<void> {
  if (isBrowserPreview()) return;
  await openNativeFile();
}

export async function listenForNativeFileOpen(): Promise<UnlistenFn> {
  if (isBrowserPreview()) return () => {};
  return listen("native-file-open", () => {
    void consumeNativeLaunchFile();
  });
}
