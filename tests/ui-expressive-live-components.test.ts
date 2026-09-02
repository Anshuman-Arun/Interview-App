import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("expressive live interview components", () => {
  it("keeps voice state contracts while removing permanent device-control clutter", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/VoiceControls.tsx"),
      "utf8"
    );
    expect(source).toContain('data-testid="voice-listening-status"');
    expect(source).toContain('data-testid="voice-speaking-status"');
    expect(source).toContain("selectInputDevice");
    expect(source).toContain("selectOutputDevice");
    expect(source).toContain("<details");
  });

  it("keeps transcript identity and delivery metadata available without chat bubbles", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/TranscriptFeed.tsx"),
      "utf8"
    );
    expect(source).toContain("Student (You)");
    expect(source).toContain("Socratic Interviewer");
    expect(source).toContain("student-math-bubble");
    expect(source).toContain("ai-math-bubble");
    expect(source).toContain("Turn:");
    expect(source).toContain("Episode:");
    expect(source).toContain("Delivery:");
    expect(source).not.toContain("rounded-2xl");
  });

  it("keeps reasoning hotkeys, limits, and expected UI labels stable", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/StudentInputArea.tsx"),
      "utf8"
    );
    expect(source).toContain("Your Mathematical Reasoning");
    expect(source).toContain("20_000");
    expect(source).toContain("Ctrl+Enter");
    expect(source).toContain("Submit Reasoning");
    expect(source).toContain('data-testid="reasoning-textarea"');
  });

  it("removes decorative pulse and ping animations from delivery state", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/DeliveryBadge.tsx"),
      "utf8"
    );
    expect(source).not.toContain("animate-pulse");
    expect(source).not.toContain("animate-ping");
    expect(source).toContain("POSSIBLY_EXPOSED");
  });
});
