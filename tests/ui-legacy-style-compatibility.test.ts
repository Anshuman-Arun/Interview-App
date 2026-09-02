import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("bounded legacy style compatibility", () => {
  it("backs surviving review/modal utilities with semantic tokens", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );

    for (const required of [
      ".grid {",
      ".md\\:grid-cols-2",
      ".max-w-5xl",
      ".max-h-\\[92vh\\]",
      ".bg-blue-50",
      ".bg-amber-50",
      ".text-amber-800",
      ".shadow-2xl",
      ".z-\\[60\\]"
    ]) {
      expect(css).toContain(required);
    }

    expect(css).toContain("var(--info-soft)");
    expect(css).toContain("var(--warning-soft)");
    expect(css).toContain("var(--shadow-popover)");
  });

  it("does not introduce a styling framework or expensive effects", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );
    expect(css).not.toContain("backdrop-filter");
    expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\(/iu);
    expect(css).not.toMatch(/@keyframes/iu);
  });
});
