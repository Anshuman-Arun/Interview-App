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
    expect(app).toContain("colorScheme={resolvedTheme}");
    expect(app).toContain("onEditorMount={handleWhiteboardEditorMount}");
    expect(app).toContain("onNormalizedBoardChange={(change)");
    expect(app).toContain("session.submitWhiteboardMutation(change)");
    expect(app).toContain('session.whiteboardSync.status === "UNSYNCHRONIZED"');
  });

  it("rechecks stored authority before every start attempt", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("const storedSessions = await session.fetchAvailableSessionsStrict()");
    expect(app).toContain('storedSession.status === "ACTIVE"');
    expect(app).toContain("await session.recoverSession(existingActive.sessionId)");
    expect(app).toContain("await session.startSession()");
  });

  it("fails closed if the pre-Start stored-session authority check cannot be read", () => {
    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );

    expect(hook).toContain("fetchAvailableSessionsStrict");
    expect(hook).toContain("return await listAvailableSessions()");
    expect(hook).toContain("throw err");
  });

  it("prefers a stored ACTIVE session over starting a second interview", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const home = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/pages/HomePage.tsx"),
      "utf8"
    );

    expect(app).toContain('storedSession.status === "ACTIVE"');
    expect(app).toContain("resumableActiveSessionId");
    expect(app).toContain("currentSessionId={hasActiveInterview ? session.sessionId : null}");
    expect(home).toContain("activeSessionId === null");
    expect(home).toContain("Return to room");
  });

  it("does not offer a second session from the ACTIVE-session overlay", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    expect(app).toContain("Current interview is active. End or archive it before starting another.");
    expect(app).toContain("key={sessionId}");
  });

  it("route-locks ACTIVE interviews to the live workspace", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("routeForActiveInterview(route, hasActiveInterview)");
    expect(app).toContain('navigate({ page: "interview" }, { replace: true })');
    expect(app).toContain("<ProductPageRouter");
    expect(app).toContain('data-compact-pane={compactPane}');
    expect(app).toContain('aria-label="Compact interview workspace"');
  });

  it("does not reveal topic or category hints in the live interview shell", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const problem = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/ProblemCard.tsx"),
      "utf8"
    );

    expect(app).not.toContain("session.problem.topics");
    expect(app).not.toContain("{session.problem.category}");
    expect(problem).not.toContain("problem.topics");
    expect(problem).not.toContain("problem.category");
    expect(problem).not.toContain("problem.difficulty");
    expect(app).not.toContain("session.problem.difficulty");
  });

  it("keeps the native tldraw toolbar local and starts on Pencil", () => {
    const whiteboard = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/components/WhiteboardCanvas.tsx"),
      "utf8"
    );

    expect(whiteboard).toContain('@tldraw/assets/imports.vite.js');
    expect(whiteboard).toContain("assetUrls={TLDRAW_ASSET_URLS}");
    expect(whiteboard).toContain("colorScheme={colorScheme}");
    expect(whiteboard).toContain('initialState="draw"');
  });

  it("keeps both live panes mounted while compact CSS chooses visibility", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );

    expect(app).toContain("<ProblemCard");
    expect(app).toContain("<WhiteboardCanvas");
    expect(css).toContain('main[data-compact-pane="interview"] .right-panel');
    expect(css).toContain('main[data-compact-pane="whiteboard"] .left-panel');
    expect(css).not.toContain("height: 50% !important");
  });

  it("does not hide first letters now that emoji prefixes are gone", () => {
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );

    expect(css).not.toContain('[data-testid="sessions-btn"]::first-letter');
    expect(css).not.toContain('[data-testid="settings-btn"]::first-letter');
    expect(css).not.toContain('[data-testid="tab-whiteboard"]::first-letter');
    expect(css).not.toContain('[data-testid="tab-formulation"]::first-letter');
  });

  it("serializes product entry actions before creating or recovering sessions", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("sessionEntryPendingRef.current");
    expect(app).toContain("sessionEntryPendingRef.current || sessionTerminalPendingRef.current");
    expect(app).toContain("setSessionEntryPending(true)");
    expect(app).toContain("setSessionEntryPending(false)");
  });

  it("serializes entry and terminal session transitions against each other", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("sessionTerminalPendingRef.current");
    expect(app).toContain("sessionEntryPendingRef.current || sessionTerminalPendingRef.current");
    expect(app).toContain("|| sessionEntryPendingRef.current");
    expect(app).toContain("|| sessionTerminalPendingRef.current");
    expect(app).toContain("disabled={sessionTerminalPending || sessionEntryPending}");
    expect(app).toContain("disabled={sessionEntryPending || sessionTerminalPending}");
  });

  it("does not recover the already-current ACTIVE session from the live Sessions overlay", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("session.sessionId === targetSessionId");
    expect(app).toContain('s.status === "ACTIVE" && s.sessionId === session.sessionId');
    expect(app).toContain("s.sessionId === session.sessionId");
    expect(app).toContain("|| sessionTerminalPending");
  });

  it("validates browser transport settings before changing the live endpoint", () => {
    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(hook).toContain("deriveDefaultRendererStreamUrl(candidate)");
    expect(hook).toContain("Command server URL must be an exact HTTP loopback origin with a usable port");
    expect(hook).toContain("if (normalized === baseUrl) return");
    expect(app).toContain("setInputUrl(session.baseUrl)");
    expect(app).toContain("[session.baseUrl]");
  });

  it("styles Whiteboard and Details from actual tab selection state", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const css = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/styles/app.css"),
      "utf8"
    );

    expect(app).toContain('role="tablist"');
    expect(app).toContain('aria-selected={activeTab === "whiteboard"}');
    expect(app).toContain('aria-selected={activeTab === "formulation"}');
    expect(css).toContain('.panel-tabs button[aria-selected="true"]');
    expect(css).not.toContain('button[data-testid="tab-whiteboard"] {');
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
