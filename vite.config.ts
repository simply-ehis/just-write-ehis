import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "path";

export default defineConfig({
  plugins: [svelte()],
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
