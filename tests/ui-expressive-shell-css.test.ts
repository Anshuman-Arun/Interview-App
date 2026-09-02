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

  it("keeps live problem metadata structurally spoiler-light", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/ProblemCard.tsx"),
      "utf8"
    );
    expect(source).not.toContain("problem.topics");
    expect(source).not.toContain("problem.category");
    expect(source).toContain("problem.difficulty");
  });
});
