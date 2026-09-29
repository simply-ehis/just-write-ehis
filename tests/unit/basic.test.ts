import { describe, it, expect } from "vitest";
import { validateSettings, clampNumber } from "$lib/settingsValidate";
import { markdownToHtmlFragment } from "$lib/markdown";
import { normalizeCharacters } from "$lib/autocorrect";

describe("validateSettings", () => {
  it("accepts known keys with valid values", () => {
    const r = validateSettings({ lockEnabled: true, backupFrequency: "weekly" });
    expect(r.valid).toMatchObject({ lockEnabled: true, backupFrequency: "weekly" });
    expect(r.rejected).toEqual([]);
  });

  it("rejects unknown keys", () => {
    const r = validateSettings({ nope: 1 });
    expect(r.rejected).toEqual(["nope"]);
    expect(r.valid).toEqual({});
  });

  it("clamps out-of-range ints to the schema max", () => {
    const r = validateSettings({ snapshotRetentionDays: 9999 });
    expect(r.valid.snapshotRetentionDays).toBe(365);
    expect(r.clamped).toEqual(["snapshotRetentionDays"]);
  });

  it("routes secrets aside instead of validating them", () => {
    const r = validateSettings({ apiKey: "sk-x", lockEnabled: false });
    expect(r.secrets).toEqual(["apiKey"]);
    expect(r.valid).toMatchObject({ lockEnabled: false });
  });

  it("clampNumber clamps ranged keys and rejects the rest", () => {
    expect(clampNumber("snapshotRetentionDays", 5)).toBe(7);
    expect(clampNumber("lockEnabled", true)).toBeNull();
    expect(clampNumber("nope", 3)).toBeNull();
  });
});

describe("markdownToHtmlFragment", () => {
  it("renders bold and escapes raw HTML", () => {
    const html = markdownToHtmlFragment("**hi** <script>");
    expect(html).toContain("<strong>hi</strong>");
    expect(html).not.toContain("<script>");
  });
});

describe("normalizeCharacters", () => {
  it("curls opening vs closing quotes by context", () => {
    expect(normalizeCharacters('"hi"')).toBe("\u201Chi\u201D");
    expect(normalizeCharacters("say 'hi'")).toBe("say \u2018hi\u2019");
  });
});
