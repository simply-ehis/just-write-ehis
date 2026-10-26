import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { cloudflare } from "@cloudflare/vite-plugin";
import { resolve } from "path";

// The Cloudflare plugin redirects the client build into
// `.cloudflare/output/v0/…` so `cf deploy` can read the Build Output
// Specification — which leaves no `dist/` behind. Tauri's
// `beforeBuildCommand` needs `dist/` (tauri.conf.json `frontendDist`), so
// keep the plugin off whenever the Tauri CLI is driving the build. Tauri
// exports TAURI_PLATFORM / TAURI_ENV_PLATFORM into the build command.
const isTauriBuild = !!(process.env.TAURI_PLATFORM || process.env.TAURI_ENV_PLATFORM);

export default defineConfig({
  plugins: isTauriBuild ? [svelte()] : [svelte(), cloudflare()],
  resolve: {
    alias: {
      "$lib": resolve(__dirname, "src/lib"),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: ["codemirror", "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/search", "@codemirror/lang-markdown"],
          d3: ["d3-dispatch", "d3-force", "d3-quadtree", "d3-timer"],
          pdfjs: ["pdfjs-dist"],
        },
      },
    },
  },
});
