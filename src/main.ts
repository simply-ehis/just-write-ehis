import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

// A chunk/script/stylesheet preload failure must never be silent anywhere
// in the app: Vite dispatches this on genuine load failures (see the
// preload helper in the built bundle). LazyWorkspace covers its own views;
// this catches anything else that preloads chunks.
window.addEventListener("vite:preloadError", (e) => {
  console.error("[preload] chunk failed to load:", e);
});

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
