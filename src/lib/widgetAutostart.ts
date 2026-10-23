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

// There is deliberately no native confirm() here. WebView2 titles a native
// dialog with the page origin ("tauri.localhost says"), which read as a
// network-permission request the first time the widget opened. Startup is
// opt-in through the "Launch at startup" switch in Settings instead.
