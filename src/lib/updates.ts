/**
 * updates — in-app update flow over the Tauri updater plugin.
 *
 * Check → download (with progress) → install → relaunch. Everything here
 * is a no-op with a clear message in the browser preview, which is
 * redeployed rather than self-updated.
 */
import { isBrowserPreview } from "$lib/api";
import { getVersion } from "@tauri-apps/api/app";

export interface UpdateInfo {
  version: string;
  date?: string;
  notes?: string;
}

export type UpdateProgress =
  | { phase: "started"; downloaded: number; total?: number }
  | { phase: "progress"; downloaded: number; total?: number }
  | { phase: "finished"; downloaded: number };

const PREVIEW_MSG =
  "App updates are delivered by the desktop app — this browser preview updates when the site is rebuilt.";

export async function getAppVersion(fallback: string): Promise<string> {
  if (isBrowserPreview()) return fallback;
  try {
    return await getVersion();
  } catch {
    return fallback;
  }
}

/** Returns the available update, or null when up to date. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (isBrowserPreview()) throw new Error(PREVIEW_MSG);
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    date: update.date ?? undefined,
    notes: update.body ?? undefined,
  };
}

/** Downloads and installs the pending update, reporting progress. */
export async function downloadAndInstall(onProgress: (p: UpdateProgress) => void): Promise<void> {
  if (isBrowserPreview()) throw new Error(PREVIEW_MSG);
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) throw new Error("No update available to install.");
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? undefined;
      onProgress({ phase: "started", downloaded: 0, total });
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ phase: "progress", downloaded, total });
    } else {
      onProgress({ phase: "finished", downloaded });
    }
  });
}

export async function relaunchApp(): Promise<void> {
  if (isBrowserPreview()) throw new Error(PREVIEW_MSG);
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
