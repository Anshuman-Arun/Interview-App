import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolveTheme
} from "../apps/web/src/appearance/appearance.js";

describe("expressive UI appearance foundations", () => {
  it("keeps appearance local, bounded, and fail-closed", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(normalizeAppearance({ accentIntensity: 99 }).accentIntensity).toBe(28);
    expect(normalizeAppearance({ accentIntensity: -10 }).accentIntensity).toBe(8);
    expect(normalizeAppearance({ theme: "unknown" })).toEqual(DEFAULT_APPEARANCE);
  });

  it("suppresses live problem topic spoilers without changing problem data", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );
    expect(css).toContain(".problem-tags");
    expect(css).toContain("display: none !important");
  });

  it("uses local tldraw assets and starts in the pencil tool", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/WhiteboardCanvas.tsx"),
      "utf8"
    );
    expect(source).toContain('@tldraw/assets/imports.vite.js');
    expect(source).toContain("assetUrls={TLDRAW_ASSET_URLS}");
    expect(source).toContain('initialState="draw"');
  });

  it("avoids expensive decorative UI loops and blur effects", () => {
    const files = [
      "apps/web/src/components/AppearanceDock.css",
      "apps/web/src/styles/theme.css",
      "apps/web/src/styles/app.css"
    ];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(source).not.toContain("backdrop-filter");
      expect(source).not.toContain("requestAnimationFrame");
      expect(source).not.toContain("setInterval");
    }
  });
});
