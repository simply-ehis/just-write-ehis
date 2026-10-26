import { defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    "name": "just-write-ehis",
    "compatibilityDate": "2026-10-19",
    "observability": {
      "enabled": true
    },
    "assets": {
      "notFoundHandling": "single-page-application"
    }
  }
});
