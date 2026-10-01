import { get } from "svelte/store";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { api } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs, showSettings, workspaces, type WorkspaceId } from "$lib/stores/app";
import { appLockConfigured, settings } from "$lib/stores/settings";
import { appUnlocked } from "$lib/stores/lock";
import { showToast } from "$lib/stores/notifications";

function isWidgetWorkspace(value: string): value is WorkspaceId {
  return workspaces.some((workspace) => workspace.id === value);
}

function mainShellUnlocked(): boolean {
  return (!get(appLockConfigured) && !get(settings).lockEnabled) || get(appUnlocked);
}

let openRequest = 0;

async function notifyWidgetFailure(message: string): Promise<void> {
  try {
    await emitTo("widget", "widget-open-failed", message);
  } catch (e) {
    console.warn("Widget failure notice undelivered:", e instanceof Error ? e.message : e);
  }
}

async function focusMain(mainWindow: Window) {
  await mainWindow.show();
  await mainWindow.unminimize();
  await mainWindow.setFocus();
}

async function openWidgetDoc(id: string, mainWindow: Window) {
  if (!mainShellUnlocked()) {
    await notifyWidgetFailure("Unlock the main app before opening a document");
    return;
  }
  if (typeof id !== "string" || !id || id.length > 128) {
    await notifyWidgetFailure("That document request is invalid");
    return;
  }
  const request = ++openRequest;
  let failure: unknown = null;
  try {
    const doc = await api.widgetDocGet(id);
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
  if (failure) {
    const message = failure instanceof Error ? failure.message : String(failure);
    showToast(`Couldn't open document: ${message}`, "error");
    await notifyWidgetFailure(message);
    return;
  }
  try {
    await focusMain(mainWindow);
    await emitTo("widget", "main-window-shown");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showToast(`Couldn't focus the main window: ${message}`, "error");
    await notifyWidgetFailure(message);
  }
}

async function openWidgetWorkspace(id: string, mainWindow: Window) {
  if (!mainShellUnlocked()) {
    await notifyWidgetFailure("Unlock the main app before opening a workspace");
    return;
  }
  if (!isWidgetWorkspace(id)) throw new Error("workspace is not available to the companion");
  showSettings.set(false);
  currentDoc.set(null);
  openTabs.set([]);
  currentWorkspace.set(id === "files" ? "properties" : id);
  await focusMain(mainWindow);
  await emitTo("widget", "main-window-shown");
  if (id === "files") {
    setTimeout(() => window.dispatchEvent(new CustomEvent("open-library-files")), 250);
  }
}

export async function initializeMainWindowBridge(): Promise<() => void> {
  const mainWindow = getCurrentWindow();
  const cleanups: UnlistenFn[] = [];
  const cleanup = () => cleanups.forEach((off) => off());

  try {
    // NOTE: no close interception here by design — × quits the app for
    // real (Rust exits on main-window destroy), so a hidden main window
    // only ever means an autostart warm boot or a widget handoff.
    cleanups.push(await listen<string>("widget-open-doc", (event) => {
      if (typeof event.payload === "string" && event.payload.length <= 128) {
        void openWidgetDoc(event.payload, mainWindow);
      }
    }));

    cleanups.push(await listen<string>("widget-open-workspace", (event) => {
      if (typeof event.payload === "string" && event.payload.length <= 64) {
        void openWidgetWorkspace(event.payload, mainWindow).catch(async (e) => {
          const message = e instanceof Error ? e.message : String(e);
          showToast(`Couldn't open workspace: ${message}`, "error");
          await notifyWidgetFailure(message);
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
