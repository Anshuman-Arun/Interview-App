import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("configured launch browser boundaries", () => {
  it("keeps private problem definitions and provider secrets out of the setup surface", () => {
    const setup = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/pages/NewInterviewPage.tsx"),
      "utf8"
    );
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const browserBundleInputs = `${setup}\n${app}`;

    expect(browserBundleInputs).not.toContain("packages/problems");
    expect(browserBundleInputs).not.toContain("canonicalSolution");
    expect(browserBundleInputs).not.toContain("reasoningGraph");
    expect(browserBundleInputs).not.toContain("verificationNotes");
    expect(setup).not.toContain(".topics");
    expect(setup).not.toContain("credentialRef");
    expect(setup).not.toContain("apiKey");
    expect(setup).not.toContain("executablePath");
  });

  it("routes Quant sessions through the dedicated handoff guard rather than Oxford controls", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    const quantGuard = app.indexOf("if (!isOxfordWorkspace)");
    const oxfordProblem = app.indexOf("<ProblemCard");
    expect(quantGuard).toBeGreaterThan(-1);
    expect(oxfordProblem).toBeGreaterThan(quantGuard);
    expect(app).toContain('data-testid="quant-session-handoff"');
    expect(app).toContain("Dedicated Quant actions are intentionally");
  });
});
