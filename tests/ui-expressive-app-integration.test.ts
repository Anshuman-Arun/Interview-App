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
    expect(app).toContain("await session.startConfiguredSession(configuration)");
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

  it("routes ambiguous multiple-ACTIVE state to explicit session selection", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const start = app.indexOf("if (activeSessions.length > 1)");
    const end = app.indexOf("const existingActive = activeSessions[0]", start);
    const branch = app.slice(start, end);

    expect(branch).toContain('navigate({ page: "sessions" })');
    expect(branch).not.toContain("setShowSessionsModal(true)");
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

  it("keeps live navigation focused and uses Home as a non-terminal pause", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );

    expect(app).toContain("session.pauseSession()");
    expect(app).toContain('navigateProductPage("home")');
    expect(app).toContain("session.resumePausedSession()");
    expect(app).not.toContain("Stored Interview Sessions");
    expect(app).not.toContain("<SessionReviewModal");
    expect(hook).toContain("const pauseSession = useCallback");
    expect(hook).toContain("sessionMutationAdmissionRef.current = false");
    expect(hook).toContain("stopVisionScheduling()");
    expect(hook).toContain("stopRendererTransport()");
  });

  it("route-locks live ACTIVE interviews while permitting an explicit paused Home", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain("routeForActiveInterview(");
    expect(app).toContain("session.isPaused");
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

  it("reattaches Quant reloads by session identity without reconstructing authority", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain('const QUANT_REATTACH_SESSION_KEY = "interview.quant.active-session"');
    expect(app).toContain("writeQuantReattachSessionId(session.sessionId)");
    expect(app).toContain("SessionIdSchema.safeParse(value)");

    const start = app.indexOf("reloadQuantRecoveryAttemptedRef.current = true");
    const end = app.indexOf("const handleWhiteboardEditorMount", start);
    const recovery = app.slice(start, end);

    expect(recovery).toContain("session.recoverSession(reloadQuantSessionId)");
    expect(recovery).toContain('status === "ACTIVE"');
    expect(recovery).toContain('status === "COMPLETED" || status === "ARCHIVED"');
    expect(recovery).toContain('view: "replay"');
    expect(recovery).not.toContain("startConfiguredSession");
    expect(recovery).not.toContain("submitQuantTradingAction");
    expect(recovery).not.toContain("submitQuantResearchAction");
    expect(recovery).not.toContain("currentRound");
    expect(recovery).not.toContain("acceptedActionCount");
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

  it("does not switch to any other ACTIVE session while one interview is live", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain('(session.isSessionStarted && session.sessionStatus === "ACTIVE")');
    expect(app).toContain('storedSession.status === "ACTIVE"');
    expect(app).toContain("activeSessions");
    expect(app).toContain("hasActiveInterview");
    expect(app).toContain("|| sessionTerminalPending");
  });

  it("keeps the live whiteboard mounted behind paused Home navigation", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain('displayRoute.page !== "interview" && !hasActiveInterview');
    expect(app).toContain('hidden={displayRoute.page !== "interview"}');
    expect(app).toContain('{productPage}');
    expect(app).toContain("tldraw retains the exact browser-native student canvas");
  });

  it("does not mount history or review UI inside the focused live workspace", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain('if (displayRoute.page !== "interview" && !hasActiveInterview)');
    expect(app).toContain("<ProductPageRouter");
    expect(app).not.toContain("Stored Interview Sessions");
    expect(app).not.toContain("Grounded history");
    expect(app).not.toContain("<SessionReviewModal");
  });

  it("locks all live mutation surfaces across terminal transitions", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );
    const complete = app.slice(
      app.indexOf("const handleCompleteSession"),
      app.indexOf("const handleArchiveSession")
    );

    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );
    const hookComplete = hook.slice(
      hook.indexOf("const completeSession = useCallback"),
      hook.indexOf("const archiveSession = useCallback")
    );

    expect(complete.indexOf("whiteboardAdapter.setReadOnly(true)"))
      .toBeGreaterThan(-1);
    expect(complete.indexOf("whiteboardAdapter.setReadOnly(true)"))
      .toBeLessThan(complete.indexOf("await session.completeSession()"));
    expect(hookComplete.indexOf("stopRendererTransport()"))
      .toBeGreaterThan(-1);
    expect(hookComplete.indexOf("stopRendererTransport()"))
      .toBeLessThan(hookComplete.indexOf("await client.completeSession"));
    expect(hookComplete).toContain("voiceControls.disableMicrophone()");
    expect(app).toContain("retryDisabled={sessionEntryPending || sessionTerminalPending}");
    expect(app).toContain("|| sessionTerminalPending");
    expect(app).toContain('session.whiteboardSync.status === "UNINITIALIZED"');
    expect(app).toContain('session.whiteboardSync.status === "UNSYNCHRONIZED"');
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
    const settings = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/pages/SettingsPage.tsx"),
      "utf8"
    );

    expect(hook).toContain("deriveDefaultRendererStreamUrl(candidate)");
    expect(hook).toContain("deriveDefaultVoiceBaseUrl(candidate)");
    expect(hook).toContain("Command server URL must be an exact HTTP loopback origin with usable renderer and voice ports");
    expect(hook).toContain("if (normalized === baseUrl) return");
    expect(settings).toContain('const [draftBaseUrl, setDraftBaseUrl]');
    expect(settings).toContain('setDraftBaseUrl(connection?.baseUrl ?? "")');
    expect(settings).toContain("[connection?.baseUrl]");
    expect(app).toContain("onSaveBaseUrl: session.setBaseUrl");
    expect(app).not.toContain("setInputUrl(session.baseUrl)");
  });

  it("keeps ambiguous and superseded terminal outcomes fail-closed", () => {
    const hook = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/hooks/useInterviewSession.ts"),
      "utf8"
    );
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(hook).toContain("client.getSessionSummary(targetSessionId)");
    expect(hook).toContain("TerminalSessionOutcomeUnknownError");
    expect(hook).toContain("TerminalSessionTransitionSupersededError");
    expect(app).toContain("error instanceof TerminalSessionOutcomeUnknownError");
    expect(app).toContain("error instanceof TerminalSessionTransitionSupersededError");
  });

  it("fails closed for live interaction states and validates manual recovery", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain('session.sessionStatus !== "ACTIVE"');
    expect(app).toContain("session.isPaused");
    expect(app).toContain("const recoverySessionParse = SessionIdSchema.safeParse");
    expect(app).toContain("recoverySessionId === null");
    expect(app).toContain("aria-invalid={recoverySessionInputInvalid}");
    expect(app).toContain('setCompactPane("whiteboard")');
  });

  it("keeps one focused whiteboard surface instead of an empty Details inspector", () => {
    const app = fs.readFileSync(
      path.resolve(process.cwd(), "apps/web/src/App.tsx"),
      "utf8"
    );

    expect(app).toContain('data-testid="tab-whiteboard"');
    expect(app).toContain("<WhiteboardCanvas");
    expect(app).not.toContain("Session Context");
    expect(app).not.toContain("Problem metadata is intentionally hidden during the live interview.");
    expect(app).not.toContain('activeTab === "formulation"');
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
