import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const STYLE_FILES = [
  "apps/web/src/styles/theme.css",
  "apps/web/src/styles/app.css",
  "apps/web/src/components/AppearanceDock.css",
  "apps/web/src/components/ProductFrame.css",
  "apps/web/src/components/TranscriptFeed.css",
  "apps/web/src/components/StudentInputArea.css",
  "apps/web/src/components/VoiceControls.css",
  "apps/web/src/components/DeliveryBadge.css",
  "apps/web/src/pages/HomePage.css",
  "apps/web/src/pages/SessionsPage.css",
  "apps/web/src/pages/SettingsPage.css",
  "apps/web/src/pages/ReviewPageShell.css",
  "apps/web/src/pages/ReviewReadPanel.css"
] as const;

describe("expressive product integration invariants", () => {
  it("keeps authoritative voice and whiteboard integration intact", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("<VoiceControls");
    expect(app).toContain("state={session.voice}");
    expect(app).toContain("controls={session.voiceControls}");

    expect(app).toContain("<WhiteboardCanvas");
    expect(app).toContain("onEditorMount={handleWhiteboardEditorMount}");
    expect(app).toContain("onNormalizedBoardChange={(change)");
    expect(app).toContain("session.submitWhiteboardMutation(change)");
    expect(app).toContain('session.whiteboardSync.status === "UNSYNCHRONIZED"');
  });

  it("route-locks ACTIVE interviews to the live workspace", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("routeForActiveInterview(route, hasActiveInterview)");
    expect(app).toContain('navigate({ page: "interview" }, { replace: true })');
    expect(app).toContain("<ProductPageRouter");
  });

  it("does not reveal topic or category hints in the live interview shell", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const problemCss = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );

    expect(app).not.toContain("session.problem.topics");
    expect(app).not.toContain("{session.problem.category}");
    expect(problemCss).toContain(".problem-tags");
    expect(problemCss).toContain("display: none !important");
  });

  it("keeps the native tldraw toolbar local and starts on Pencil", () => {
    const whiteboard = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/WhiteboardCanvas.tsx"),
      "utf8"
    );

    expect(whiteboard).toContain('@tldraw/assets/imports.vite.js');
    expect(whiteboard).toContain("assetUrls={TLDRAW_ASSET_URLS}");
    expect(whiteboard).toContain('initialState="draw"');
  });

  it("does not add expensive decorative effects", () => {
    for (const file of STYLE_FILES) {
      const css = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(css).not.toMatch(/backdrop-filter/iu);
      expect(css).not.toMatch(/(?:linear|radial|conic)-gradient\(/iu);
      expect(css).not.toMatch(/filter\s*:\s*blur\(/iu);
      expect(css).not.toMatch(/@keyframes/iu);
    }

    const sourceFiles = [
      "apps/web/src/appearance/AppearanceProvider.tsx",
      "apps/web/src/components/AppearanceDock.tsx",
      "apps/web/src/navigation/useProductNavigation.ts",
      "apps/web/src/pages/HomePage.tsx",
      "apps/web/src/pages/SessionsPage.tsx",
      "apps/web/src/pages/SettingsPage.tsx",
      "apps/web/src/pages/ReviewReadPanel.tsx"
    ];
    for (const file of sourceFiles) {
      const source = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(source).not.toContain("requestAnimationFrame");
      expect(source).not.toContain("setInterval");
    }
  });
});
