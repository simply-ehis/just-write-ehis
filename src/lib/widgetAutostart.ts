import { get } from "svelte/store";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { isBrowserPreview } from "$lib/api";
import { settings } from "$lib/stores/settings";

export function isWindowsRuntime(): boolean {
  return !isBrowserPreview() && /win/i.test(navigator.userAgent);
}

export async function setWidgetAutostart(enabled: boolean): Promise<string | null> {
  const previous = get(settings).widgetLaunchAtStartup;
  settings.update((current) => ({ ...current, widgetLaunchAtStartup: enabled }));
  if (isBrowserPreview() || !isWindowsRuntime()) return null;
  try {
    if (enabled) await enableAutostart();
    else await disableAutostart();
    if ((await isAutostartEnabled()) !== enabled) throw new Error("the operating system did not apply the startup setting");
    return null;
  } catch (e) {
    settings.update((current) => ({ ...current, widgetLaunchAtStartup: previous }));
    return e instanceof Error ? e.message : String(e);
  }
}

export async function promptWidgetAutostart(): Promise<string | null> {
  if (isBrowserPreview() || !isWindowsRuntime() || get(settings).widgetAutostartPromptShown) return null;
  const startWithWindows = window.confirm("Also start Just Write ehis automatically with Windows? Choose Cancel to decline.");
  settings.update((current) => ({ ...current, widgetAutostartPromptShown: true, widgetLaunchAtStartup: startWithWindows }));
  if (!startWithWindows) return null;
  return setWidgetAutostart(true);
}
