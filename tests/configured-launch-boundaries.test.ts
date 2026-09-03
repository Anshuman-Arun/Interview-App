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

  it("routes Quant sessions through the dedicated workspace rather than Oxford controls", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    const quantGuard = app.indexOf('session.configuration.mode !== "OXFORD_MATHEMATICS"');
    const quantWorkspace = app.indexOf("<QuantSessionWorkspace", quantGuard);
    const oxfordProblem = app.indexOf("<ProblemCard", quantWorkspace);
    const quantBranch = app.slice(quantGuard, oxfordProblem);

    expect(quantGuard).toBeGreaterThan(-1);
    expect(quantWorkspace).toBeGreaterThan(quantGuard);
    expect(oxfordProblem).toBeGreaterThan(quantWorkspace);
    expect(quantBranch).not.toContain("<ProblemCard");
    expect(quantBranch).not.toContain("<StudentInputArea");
    expect(quantBranch).not.toContain("<WhiteboardCanvas");
    expect(app).not.toContain('data-testid="quant-session-handoff"');
  });
});
