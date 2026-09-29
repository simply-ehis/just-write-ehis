import { mount } from "svelte";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/fira-code/400.css";
import "@fontsource/fira-code/700.css";
import "@fontsource/source-code-pro/400.css";
import "@fontsource/source-code-pro/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/700.css";
import "@fontsource/archivo-black/400.css";
import "@fontsource/space-mono/400.css";
import "@fontsource/space-mono/700.css";
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

// A failed chunk load otherwise leaves #app permanently empty (a true
// blank screen with no toast and no console access for most users). Render
// the failure as text so it is always diagnosable and recoverable.
void bootstrap().catch((error) => {
  console.error("Startup failed to load:", error);
  const target = document.getElementById("app");
  if (target) {
    const reason = error instanceof Error ? error.message : String(error);
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;padding:24px;";
    const h1 = document.createElement("h1");
    h1.textContent = "Just Write ehis couldn't start";
    const p = document.createElement("p");
    p.textContent = `The app shell failed to load (${reason}). Reloading usually fixes this; reinstalling repairs a damaged install.`;
    const btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.style.cssText = "padding:8px 20px;cursor:pointer;";
    btn.addEventListener("click", () => location.reload());
    wrap.append(h1, p, btn);
    target.replaceChildren(wrap);
  }
});
