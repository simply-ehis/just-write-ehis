import { get } from "svelte/store";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs, showSettings, workspaces, type WorkspaceId } from "$lib/stores/app";
import { settings } from "$lib/stores/settings";
import { showToast } from "$lib/stores/notifications";

function isWidgetWorkspace(value: string): value is WorkspaceId {
  return workspaces.some((workspace) => workspace.id === value);
}

let openRequest = 0;

async function focusMain(mainWindow: Window) {
  await mainWindow.show();
  await mainWindow.unminimize();
  await mainWindow.setFocus();
}

async function openWidgetDoc(id: string, mainWindow: Window) {
  if (typeof id !== "string" || !id || id.length > 128) return;
  const request = ++openRequest;
  let failure: unknown = null;
  try {
    const doc = await api.docGet(id);
    if (request !== openRequest) return;
    if (doc.locked || !isWidgetWorkspace(doc.workspace)) {
      throw new Error("document is not available to the companion");
    }
    showSettings.set(false);
    currentDoc.set(doc);
    currentWorkspace.set(doc.workspace);
    openTabs.update((tabs) => tabs.some((tab) => tab.id === doc.id) ? tabs : [doc, ...tabs]);
  } catch (e) {
    failure = e;
  }
  try {
    await focusMain(mainWindow);
    await emitTo("widget", "main-window-shown");
  } catch (e) {
    failure ??= e;
  }
  if (failure) showToast(`Couldn't open document: ${failure instanceof Error ? failure.message : failure}`, "error");
}

async function openWidgetWorkspace(id: string, mainWindow: Window) {
  if (!isWidgetWorkspace(id)) throw new Error("workspace is not available to the companion");
  showSettings.set(false);
  currentDoc.set(null);
  openTabs.set([]);
  currentWorkspace.set(id === "files" ? "properties" : id);
  await focusMain(mainWindow);
  if (id === "files") {
    setTimeout(() => window.dispatchEvent(new CustomEvent("open-library-files")), 250);
  }
}

export async function initializeMainWindowBridge(): Promise<() => void> {
  const mainWindow = getCurrentWindow();
  const cleanups: UnlistenFn[] = [];
  const cleanup = () => cleanups.forEach((off) => off());

  try {
    cleanups.push(await mainWindow.onCloseRequested((event) => {
      event.preventDefault();
      void (async () => {
        try {
          await mainWindow.hide();
          await emitTo("widget", "main-window-hidden");
        } catch (e) {
          console.warn("Failed to hide main window:", e);
        }
      })();
    }));

    cleanups.push(await listen<string>("widget-open-doc", (event) => {
      if (typeof event.payload === "string" && event.payload.length <= 128) {
        void openWidgetDoc(event.payload, mainWindow);
      }
    }));

    cleanups.push(await listen<string>("widget-open-workspace", (event) => {
      if (typeof event.payload === "string" && event.payload.length <= 64) {
        void openWidgetWorkspace(event.payload, mainWindow).catch((e) => {
          showToast(`Couldn't open workspace: ${e instanceof Error ? e.message : e}`, "error");
        });
      }
    }));

    if (get(settings).companionWidgetVisible) {
      const widget = await WebviewWindow.getByLabel("widget");
      if (widget) {
        await widget.show();
        await widget.emit("widget-show", {});
      }
    }
    return cleanup;
  } catch (e) {
    cleanup();
    throw e;
  }
}
