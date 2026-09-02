import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  THEME_STORAGE_KEY,
  isThemeMode,
  resolveThemeMode
} from "../apps/web/src/theme/theme.js";

const FOUNDATION_FILES = [
  "apps/web/src/styles/theme.css",
  "apps/web/src/components/ProblemCard.module.css",
  "apps/web/src/components/DeliveryBadge.module.css",
  "apps/web/src/components/TranscriptFeed.module.css",
  "apps/web/src/components/StudentInputArea.module.css",
  "apps/web/src/components/SessionReviewModal.module.css",
  "apps/web/src/components/ThemeControl.module.css",
  "apps/web/src/components/BrandMark.module.css",
  "apps/web/src/theme/ThemeProvider.tsx"
] as const;

describe("professional UI foundation invariants", () => {
  it("keeps theme mode resolution deterministic and local-only", () => {
    expect(THEME_STORAGE_KEY).toBe("interview-ui-theme-v1");
    expect(isThemeMode("system")).toBe(true);
    expect(isThemeMode("light")).toBe(true);
    expect(isThemeMode("dark")).toBe(true);
    expect(isThemeMode("auto")).toBe(false);
    expect(resolveThemeMode("system", true)).toBe("dark");
    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("light", true)).toBe("light");
    expect(resolveThemeMode("dark", false)).toBe("dark");
  });

  it("defines semantic light and dark tokens without a remote font dependency", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/theme.css"),
      "utf8"
    );

    for (const token of [
      "--surface-app",
      "--surface-panel",
      "--border-default",
      "--text-primary",
      "--text-secondary",
      "--accent",
      "--success",
      "--warning",
      "--danger"
    ]) {
      expect(css).toContain(token);
    }

    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).not.toMatch(/@import\s+url/u);
    expect(css).not.toMatch(/url\(\s*["']?https?:/u);
  });

  it("uses a local vector brand mark without decorative effects", () => {
    const component = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/BrandMark.tsx"),
      "utf8"
    );
    const favicon = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/public/brand-mark.svg"),
      "utf8"
    );
    const html = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/index.html"),
      "utf8"
    );

    expect(component).toContain('data-testid="brand-mark"');
    expect(component).not.toContain("gradient");
    expect(favicon).not.toContain("<text");
    expect(favicon).not.toContain("gradient");
    expect(html).toContain('href="/brand-mark.svg"');
  });

  it("rejects expensive decorative effects from the stage-A foundation surface", () => {
    const combined = FOUNDATION_FILES
      .map((file) => fs.readFileSync(path.resolve(process.cwd(), file), "utf8"))
      .join("\n");

    expect(combined).not.toContain("backdrop-filter");
    expect(combined).not.toMatch(/filter\s*:\s*blur\s*\(/u);
    expect(combined).not.toContain("linear-gradient(");
    expect(combined).not.toContain("radial-gradient(");
    expect(combined).not.toContain("requestAnimationFrame");
    expect(combined).not.toContain("setInterval(");
  });
});
