import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("expressive live shell CSS compatibility", () => {
  it("replaces prototype brand chrome without changing App.tsx", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );
    expect(css).toContain('background-image: url("/brand-mark.svg")');
    expect(css).toContain('content: "Interview"');
    expect(css).toContain(".problem-card-container");
    expect(css).toContain("width: 44% !important");
    expect(css).toContain("width: 56% !important");
  });

  it("keeps live problem metadata quiet and spoiler-light", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );
    expect(css).toContain(".problem-tags");
    expect(css).toContain("problem-header .flex.flex-wrap.items-center.gap-2");
  });
});
