import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, isBrowserPreview } from "$lib/api";
import { warnOnce } from "$lib/errors";
import { currentDoc, currentWorkspace, openTabs, showSettings } from "$lib/stores/app";
import { showToast } from "$lib/stores/notifications";

/** Open the file the backend recorded from argv / the OS file association. */
async function openNativeFile(): Promise<void> {
  try {
    // No path argument: the backend reads the file it recorded from argv / the
    // OS file association. The renderer deliberately cannot name a path here.
    const doc = await api.openExternalFile();
    if (!doc) return;
    currentDoc.set(doc);
    currentWorkspace.set(doc.workspace);
    showSettings.set(false);
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
