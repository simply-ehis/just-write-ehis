import { get } from "svelte/store";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs, showSettings } from "$lib/stores/app";
import { settings } from "$lib/stores/settings";
import { showToast } from "$lib/stores/notifications";

const WIDGET_WORKSPACES = new Set(["write", "logs", "inbox"]);
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
    if (doc.locked || !WIDGET_WORKSPACES.has(doc.workspace)) {
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
