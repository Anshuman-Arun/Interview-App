import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("expressive live shell CSS compatibility", () => {
  it("keeps existing brand chrome while making the board surface dominant", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );
    expect(css).toContain('background-image: url("/brand-mark.svg")');
    expect(css).toContain('content: "Interview"');
    expect(css).toContain(".problem-card-container");
    expect(css).toContain("width: var(--live-context-width, 31%) !important");
    expect(css).toContain("background: var(--board-surface) !important");
    expect(css).toContain(".live-pane-resizer");
    expect(css).toContain(".interview-app-container--backgrounded");
    expect(css).toContain("position: fixed !important");
    expect(css).toContain("visibility: hidden");
  });

  it("keeps live problem metadata structurally spoiler-light", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/ProblemCard.tsx"),
      "utf8"
    );
    expect(source).not.toContain("problem.topics");
    expect(source).not.toContain("problem.category");
    expect(source).not.toContain("problem.difficulty");
  });
});
