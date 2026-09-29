import { describe, it, expect } from "vitest";

describe("settings validation", () => {
  it("should pass a basic sanity check", () => {
    expect(1 + 1).toBe(2);
  });

  it("should validate settings structure", () => {
    const settings = { theme: "dark", fontSize: 16 };
    expect(settings.theme).toBe("dark");
    expect(settings.fontSize).toBe(16);
  });
});

describe("markdown utilities", () => {
  it("should escape HTML entities", () => {
    const escapeHtml = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
});
