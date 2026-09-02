import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  MAX_INTERFACE_ZOOM_PERCENT,
  MIN_INTERFACE_ZOOM_PERCENT,
  normalizeAppearance,
  resolveTheme
} from "../apps/web/src/appearance/appearance.js";

describe("expressive UI appearance foundations", () => {
  it("keeps appearance local, bounded, migratable, and fail-closed", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(normalizeAppearance({ accentIntensity: 99 }).accentIntensity).toBe(28);
    expect(normalizeAppearance({ accentIntensity: -10 }).accentIntensity).toBe(8);
    expect(normalizeAppearance({ zoomPercent: 113 }).zoomPercent).toBe(113);
    expect(normalizeAppearance({ zoomPercent: 10 }).zoomPercent)
      .toBe(MIN_INTERFACE_ZOOM_PERCENT);
    expect(normalizeAppearance({ zoomPercent: 500 }).zoomPercent)
      .toBe(MAX_INTERFACE_ZOOM_PERCENT);
    expect(normalizeAppearance({ scale: "xl" }).zoomPercent).toBe(125);
    expect(normalizeAppearance({ theme: "unknown" })).toEqual(DEFAULT_APPEARANCE);
  });

  it("does not render live problem category or topic spoilers", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/ProblemCard.tsx"),
      "utf8"
    );
    expect(source).not.toContain("problem.category");
    expect(source).not.toContain("problem.topics");
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

  it("supports continuous interface zoom instead of named size presets", () => {
    const provider = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/appearance/AppearanceProvider.tsx"),
      "utf8"
    );
    const dock = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/AppearanceDock.tsx"),
      "utf8"
    );

    expect(provider).toContain("}, [settings.zoomPercent]);");
    expect(provider).toContain("bridge.setZoomFactor(zoomFactor)");
    expect(dock).toContain('aria-label="Interface zoom percent"');
    expect(dock).toContain("setZoomPercent");
    expect(dock).not.toContain("const SCALES");
  });

  it("lets transient appearance popovers dismiss without sacrificing controls", () => {
    const dock = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/AppearanceDock.tsx"),
      "utf8"
    );
    expect(dock).toContain('document.addEventListener("pointerdown", closeFromOutside)');
    expect(dock).toContain('event.key !== "Escape"');
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
