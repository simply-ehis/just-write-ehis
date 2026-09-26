import { mount } from "svelte";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./app.css";

// Boot-timing baseline: milliseconds from navigation start to interactive
// shell. App.svelte reports the delta when `ready` flips (see jwe-boot-ms).
try {
  (window as unknown as { __jweBootT0?: number }).__jweBootT0 = performance.now();
} catch {
  /* timing unavailable: boot continues */
}

window.addEventListener("vite:preloadError", (e) => {
  console.error("[preload] chunk failed to load:", e);
});

async function bootstrap() {
  const isWidget = new URLSearchParams(window.location.search).get("widget") === "1";
  const route = isWidget
    ? await import("./WidgetApp.svelte")
    : await import("./App.svelte");
  mount(route.default, {
    target: document.getElementById("app")!,
  });
}

void bootstrap();
