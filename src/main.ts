import { mount } from "svelte";
import "./app.css";

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
