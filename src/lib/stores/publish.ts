import { writable } from "svelte/store";

// NOTE: the render path used to live here as a TS twin of the Rust
// publisher (regex markdown, raw customJs injection). It was deleted:
// the Rust backend (pulldown-cmark + ammonia + sanitized customJs/Css +
// inlined images) is the single implementation — see commands.rs
// publish_static_site. These types/stores remain as UI state.

export interface PublishConfig {
  title: string;
  description: string;
  baseUrl: string;
  theme: "light" | "dark" | "auto";
  includeWorkspaces: string[];
  includeDrafts: boolean;
  tocDepth: number;
  customCss?: string;
  customJs?: string;
  favicon?: string;
}

export interface PublishResult {
  outputDir: string;
  files: string[];
  indexHtml: string;
}

const defaultConfig: PublishConfig = {
  title: "My Writing",
  description: "Published from Just Write",
  baseUrl: "/",
  theme: "auto",
  includeWorkspaces: ["write", "novel", "projects"],
  includeDrafts: false,
  tocDepth: 3,
};

export const publishConfig = writable<PublishConfig>(defaultConfig);
export const isPublishing = writable(false);
export const lastPublishResult = writable<PublishResult | null>(null);
