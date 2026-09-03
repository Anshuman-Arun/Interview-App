import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SessionIdSchema,
  type InterviewSessionConfiguration,
  type SessionId
} from "../../../packages/domain/src/index.js";
import { AppearanceDock } from "./components/AppearanceDock.js";
import { BrandMark } from "./components/BrandMark.js";
import { ProblemCard } from "./components/ProblemCard.js";
import { TranscriptFeed } from "./components/TranscriptFeed.js";
import { StudentInputArea } from "./components/StudentInputArea.js";
import { VoiceControls } from "./components/VoiceControls.js";
import { WhiteboardCanvas } from "./components/WhiteboardCanvas.js";
import { TldrawWhiteboardAdapter } from "./tldraw-whiteboard-adapter.js";
import {
  TerminalSessionOutcomeUnknownError,
  TerminalSessionTransitionSupersededError,
  useInterviewSession
} from "./hooks/useInterviewSession.js";
import type { SessionHistoryReadResponse } from "../../../packages/replay/src/index.js";
import { isSessionIdAddressableForRead } from "./session-read-client.js";
import { ProductPageRouter } from "./navigation/ProductPageRouter.js";
import {
  routeForActiveInterview
} from "./navigation/product-route.js";
import { useProductNavigation } from "./navigation/useProductNavigation.js";
import type { ProductPageId } from "./components/ProductFrame.js";
import { ReviewReadPanel } from "./pages/ReviewReadPanel.js";
import { QuantSessionWorkspace } from "./quant/QuantSessionWorkspace.js";
import { useAppearance } from "./appearance/AppearanceProvider.js";
import "./styles/app.css";
import "./styles/transcript.css";

export const App: React.FC = () => {
  const { resolvedTheme } = useAppearance();
  const [recoverySessionInput, setRecoverySessionInput] = useState("");
  const [compactPane, setCompactPane] =
    useState<"interview" | "whiteboard">("interview");
  const [historyRead, setHistoryRead] = useState<SessionHistoryReadResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const sessionEntryPendingRef = useRef(false);
  const sessionTerminalPendingRef = useRef(false);
  const [sessionEntryPending, setSessionEntryPending] = useState(false);
  const [sessionTerminalPending, setSessionTerminalPending] = useState(false);

  const whiteboardAdapter = useMemo(() => {
    return new TldrawWhiteboardAdapter();
  }, []);

  const session = useInterviewSession({
    whiteboardAdapter
  });
  const { route, navigate } = useProductNavigation();

  const recoverySessionParse = SessionIdSchema.safeParse(recoverySessionInput.trim());
  const recoverySessionId = recoverySessionParse.success
    ? recoverySessionParse.data
    : null;
  const recoverySessionInputInvalid =
    recoverySessionInput.trim().length > 0 && recoverySessionId === null;

  const handleOpenNewInterview = (): void => {
    if (sessionEntryPendingRef.current || sessionTerminalPendingRef.current) return;
    navigate({ page: "new" });
  };

  const handleStartConfiguredSession = async (
    configuration: InterviewSessionConfiguration
  ): Promise<void> => {
    if (sessionEntryPendingRef.current || sessionTerminalPendingRef.current) return;
    sessionEntryPendingRef.current = true;
    setSessionEntryPending(true);
    try {
      const storedSessions = await session.fetchAvailableSessionsStrict();
      const activeSessions = storedSessions.filter(
        (storedSession) => storedSession.status === "ACTIVE"
      );
      if (activeSessions.length > 1) {
        navigate({ page: "sessions" });
        return;
      }
      const existingActive = activeSessions[0];
      if (existingActive !== undefined) {
        const recoveredStatus = await session.recoverSession(existingActive.sessionId);
        navigate(
          recoveredStatus === "ACTIVE"
            ? { page: "interview" }
            : { page: "sessions" }
        );
        return;
      }
      await session.startConfiguredSession(configuration);
      navigate({ page: "interview" });
    } catch {
      // Error handled by the authoritative session hook.
    } finally {
      sessionEntryPendingRef.current = false;
      setSessionEntryPending(false);
    }
  };

  const handleCompleteSession = async (): Promise<void> => {
    const targetSessionId = session.sessionId;
    if (
      targetSessionId === null
      || sessionTerminalPendingRef.current
      || sessionEntryPendingRef.current
    ) return;
    sessionTerminalPendingRef.current = true;
    whiteboardAdapter.setReadOnly(true);
    setSessionTerminalPending(true);
    try {
      await session.completeSession();
      navigate({
        page: "review",
        sessionId: targetSessionId,
        view: "evaluation"
      });
    } catch (error) {
      if (
        !(error instanceof TerminalSessionOutcomeUnknownError)
        && !(error instanceof TerminalSessionTransitionSupersededError)
      ) {
        whiteboardAdapter.setReadOnly(false);
      }
      // Error handled in session.error
    } finally {
      sessionTerminalPendingRef.current = false;
      setSessionTerminalPending(false);
    }
  };

  const handleArchiveSession = async (): Promise<void> => {
    const targetSessionId = session.sessionId;
    if (
      targetSessionId === null
      || sessionTerminalPendingRef.current
      || sessionEntryPendingRef.current
    ) return;
    sessionTerminalPendingRef.current = true;
    whiteboardAdapter.setReadOnly(true);
    setSessionTerminalPending(true);
    try {
      await session.archiveSession();
      navigate({
        page: "review",
        sessionId: targetSessionId,
        view: "evaluation"
      });
    } catch (error) {
      if (
        !(error instanceof TerminalSessionOutcomeUnknownError)
        && !(error instanceof TerminalSessionTransitionSupersededError)
      ) {
        whiteboardAdapter.setReadOnly(false);
      }
      // Error handled in session.error
    } finally {
      sessionTerminalPendingRef.current = false;
      setSessionTerminalPending(false);
    }
  };

  const handleRecoverSession = async (targetSessionId: SessionId): Promise<void> => {
    if (
      sessionEntryPendingRef.current
      || sessionTerminalPendingRef.current
      || (session.isSessionStarted && session.sessionStatus === "ACTIVE")
    ) return;
    sessionEntryPendingRef.current = true;
    setSessionEntryPending(true);
    try {
      const recoveredStatus = await session.recoverSession(targetSessionId);
      if (recoveredStatus === null) return;
      navigate(
        recoveredStatus === "ACTIVE"
          ? { page: "interview" }
          : {
              page: "review",
              sessionId: targetSessionId,
              view: "evaluation"
            }
      );
    } catch {
      // Error handled in session.error
    } finally {
      sessionEntryPendingRef.current = false;
      setSessionEntryPending(false);
    }
  };

  const handleResumePausedSession = async (): Promise<void> => {
    if (
      !session.isPaused
      || session.sessionId === null
      || sessionEntryPendingRef.current
      || sessionTerminalPendingRef.current
    ) {
      return;
    }
    sessionEntryPendingRef.current = true;
    setSessionEntryPending(true);
    try {
      await session.resumePausedSession();
      navigate({ page: "interview" });
    } catch {
      // Error handled in session.error; the session remains safely paused.
    } finally {
      sessionEntryPendingRef.current = false;
      setSessionEntryPending(false);
    }
  };

  const handleManualRecover = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (
      recoverySessionId === null
      || sessionEntryPendingRef.current
      || sessionTerminalPendingRef.current
    ) return;
    sessionEntryPendingRef.current = true;
    setSessionEntryPending(true);
    try {
      const recoveredStatus = await session.recoverSession(recoverySessionId);
      if (recoveredStatus === null) return;
      navigate(
        recoveredStatus === "ACTIVE"
          ? { page: "interview" }
          : {
              page: "review",
              sessionId: recoverySessionId,
              view: "evaluation"
            }
      );
    } catch {
      // Error handled in session.error
    } finally {
      sessionEntryPendingRef.current = false;
      setSessionEntryPending(false);
    }
  };

  const refreshStoredSessions = useCallback((): void => {
    void session.fetchAvailableSessions();
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryRead(null);
    setHistoryLoading(true);
    setHistoryError(null);

    void session.readSessionHistory(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setHistoryRead(value);
        setHistoryLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHistoryError("Bounded session history could not be loaded.");
        setHistoryLoading(false);
      });
  }, [session.fetchAvailableSessions, session.readSessionHistory]);

  const navigateProductPage = useCallback((page: ProductPageId): void => {
    navigate({ page });
  }, [navigate]);

  useEffect(() => {
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    setHistoryRead(null);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [session.baseUrl]);

  useEffect(() => {
    if (session.isSessionStarted && session.sessionStatus === "ACTIVE") {
      return;
    }
    if (route.page === "home" || route.page === "new") {
      void session.fetchAvailableSessions();
      return;
    }
    if (route.page === "sessions") {
      refreshStoredSessions();
    }
  }, [
    refreshStoredSessions,
    route.page,
    session.fetchAvailableSessions,
    session.isSessionStarted,
    session.sessionStatus
  ]);

  useEffect(() => {
    return () => {
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
    };
  }, []);


  const handleWhiteboardEditorMount = useCallback((): void => {
    void session.synchronizeWhiteboard().catch(() => {
      // The sync status remains fail-closed and is surfaced by the session hook.
    });
  }, [session.synchronizeWhiteboard]);

  const hasActiveInterview =
    session.isSessionStarted && session.sessionStatus === "ACTIVE";
  const storedActiveSessions = session.availableSessions.filter(
    (storedSession) => storedSession.status === "ACTIVE"
  );
  const storedActiveSession =
    storedActiveSessions.length === 1 ? storedActiveSessions[0] ?? null : null;
  const resumableActiveSessionId =
    hasActiveInterview && session.sessionId !== null
      ? session.sessionId
      : storedActiveSession?.sessionId ?? null;
  const displayRoute = routeForActiveInterview(
    route,
    hasActiveInterview,
    session.isPaused
  );
  const activeModeLabel =
    session.configuration?.mode === "QUANT_TRADING"
      ? "Quant Trading"
      : session.configuration?.mode === "QUANT_RESEARCH"
        ? "Quant Research"
        : "Oxford Mathematics";

  useEffect(() => {
    if (!hasActiveInterview) return;
    if (route.page === "home" && !session.isPaused) {
      session.pauseSession();
      return;
    }
    if (session.isPaused) {
      if (route.page !== "home" && route.page !== "new") {
        navigate({ page: "home" }, { replace: true });
      }
      return;
    }
    if (route.page !== "interview") {
      navigate({ page: "interview" }, { replace: true });
    }
  }, [
    hasActiveInterview,
    navigate,
    route.page,
    session.isPaused,
    session.pauseSession
  ]);

  // Pausing is presentation-only. Keep the live tree mounted behind Home so
  // tldraw retains the exact browser-native student canvas that is later
  // verified against authoritative shape revisions/hashes on resume.
  const productPage = displayRoute.page === "interview"
    ? null
    : (
      <ProductPageRouter
        route={displayRoute}
        sessions={session.availableSessions}
        activeSessionId={resumableActiveSessionId}
        currentSessionId={hasActiveInterview ? session.sessionId : null}
        activeProblemTitle={
          hasActiveInterview
            ? session.problem?.title ?? activeModeLabel
            : null
        }
        activeSessionPaused={session.isPaused}
        canReview={(storedSession) =>
          (
            storedSession.status === "COMPLETED"
            || storedSession.status === "ARCHIVED"
          )
          && isSessionIdAddressableForRead(storedSession.sessionId)
        }
        onNavigatePage={navigateProductPage}
        sessionEntryPending={sessionEntryPending}
        onEnterInterview={handleOpenNewInterview}
        launchCatalog={session.interviewCatalog}
        launchCatalogLoading={session.interviewCatalogLoading}
        launchCatalogError={session.interviewCatalogError}
        providerOptions={session.providerOptions}
        providerOptionsLoading={session.providerOptionsLoading}
        providerOptionsError={session.providerOptionsError}
        onRefreshLaunchCatalog={session.refreshInterviewCatalog}
        onRefreshProviderOptions={session.refreshProviderOptions}
        onStartConfiguredInterview={handleStartConfiguredSession}
        onResume={(sessionId) => {
          if (session.isPaused && session.sessionId === sessionId) {
            void handleResumePausedSession();
          } else {
            void handleRecoverSession(sessionId);
          }
        }}
        onReview={(sessionId, view, options) => {
          navigate(
            {
              page: "review",
              sessionId,
              view
            },
            options
          );
        }}
        onRefreshSessions={refreshStoredSessions}
        history={historyRead}
        historyLoading={historyLoading}
        historyError={historyError}
        connection={{
          managed: session.isTransportManaged,
          baseUrl: session.baseUrl,
          locked:
            (
              session.sessionId !== null
              && session.sessionStatus === "ACTIVE"
            )
            || sessionEntryPending
            || sessionTerminalPending,
          onSaveBaseUrl: session.setBaseUrl
        }}
        notice={session.error}
        onDismissNotice={session.clearError}
        renderReview={(sessionId, view) => (
          <ReviewReadPanel
            key={sessionId}
            sessionId={sessionId}
            view={view}
            readEvaluation={session.readSessionEvaluation}
            readReplay={session.readSessionReplay}
          />
        )}
      />
    );

  if (displayRoute.page !== "interview" && !hasActiveInterview) {
    return productPage;
  }

  if (
    session.configuration !== null
    && session.configuration.mode !== "OXFORD_MATHEMATICS"
  ) {
    return (
      <>
        {productPage}
        <QuantSessionWorkspace
          configuration={session.configuration}
          quantState={session.quantState}
          quantStateLoading={session.quantStateLoading}
          quantActionPending={session.quantActionPending}
          sessionStatus={session.sessionStatus}
          paused={session.isPaused}
          productHidden={displayRoute.page !== "interview"}
          notice={session.error}
          onDismissNotice={session.clearError}
          onHome={() => {
            if (hasActiveInterview) session.pauseSession();
            navigateProductPage("home");
          }}
          onReview={() => {
            if (session.sessionId === null) return;
            navigate({
              page: "review",
              sessionId: session.sessionId,
              view: "replay"
            });
          }}
          onRefresh={session.refreshQuantState}
          onSubmitTrading={session.submitQuantTradingAction}
          onSubmitResearch={session.submitQuantResearchAction}
        />
      </>
    );
  }

  return (
    <>
      {productPage}
      <div
        hidden={displayRoute.page !== "interview"}
        className="interview-app-container flex flex-col h-screen w-screen bg-slate-100 font-sans text-slate-900 overflow-hidden"
      >
      {/* Focused live interview header */}
      <header className="app-header">
        <button
          type="button"
          className="app-header__identity"
          disabled={sessionEntryPending || sessionTerminalPending}
          onClick={() => {
            if (hasActiveInterview) session.pauseSession();
            navigateProductPage("home");
          }}
          aria-label={hasActiveInterview ? "Pause interview and open Home" : "Open Home"}
        >
          <BrandMark size={28} title="Interview" />
          <span className="app-header__identity-copy">
            <strong>Interview</strong>
            <small>{session.problem?.title ?? "Live reasoning workspace"}</small>
          </span>
        </button>

        <div className="app-header__actions">
          <span
            className="app-header__connection"
            data-connected={String(session.isConnected)}
            data-testid="connection-status"
          >
            <span aria-hidden="true" />
            {session.isConnected ? "Connected" : "Disconnected"}
          </span>

          {session.isStreaming && (
            <span className="app-header__streaming">Responding</span>
          )}

          {hasActiveInterview && (
            <div className="app-header__session-actions">
              <button
                type="button"
                onClick={() => {
                  session.pauseSession();
                  navigateProductPage("home");
                }}
                disabled={sessionTerminalPending || sessionEntryPending}
                className="app-header__quiet"
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => void handleCompleteSession()}
                disabled={sessionTerminalPending || sessionEntryPending}
                className="app-header__end"
              >
                {sessionTerminalPending ? "Ending…" : "End interview"}
              </button>
              <button
                type="button"
                onClick={() => void handleArchiveSession()}
                disabled={sessionTerminalPending || sessionEntryPending}
                className="app-header__quiet"
              >
                {sessionTerminalPending ? "Working…" : "Archive"}
              </button>
            </div>
          )}

          <AppearanceDock compact />

          {!hasActiveInterview && (
            <>
              <button
                type="button"
                onClick={() => navigateProductPage("sessions")}
                className="app-header__quiet"
                data-testid="sessions-btn"
              >
                Sessions
              </button>
              <button
                type="button"
                onClick={() => navigateProductPage("settings")}
                className="app-header__quiet"
                data-testid="settings-btn"
              >
                Settings
              </button>
            </>
          )}
        </div>
      </header>

      <div
        className="compact-workspace-tabs"
        role="tablist"
        aria-label="Compact interview workspace"
      >
        <button
          type="button"
          role="tab"
          aria-selected={compactPane === "interview"}
          onClick={() => setCompactPane("interview")}
        >
          Interview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={compactPane === "whiteboard"}
          onClick={() => {
            setCompactPane("whiteboard");
          }}
        >
          Whiteboard
        </button>
      </div>

      {/* Error Banner */}
      {session.error !== null && (
        <div className="bg-rose-50 border-b border-rose-200 px-6 py-2.5 flex items-center justify-between text-xs text-rose-800 shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-bold">⚠️ Notice:</span>
            <span>{session.error}</span>
          </div>
          <button
            type="button"
            onClick={session.clearError}
            className="text-rose-600 hover:text-rose-900 font-bold px-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Split-Pane Workspace */}
      <main
        className="flex-1 flex overflow-hidden"
        data-compact-pane={compactPane}
      >
        {/* Left Panel: Problem, Transcript, Input */}
        <section className="left-panel w-1/2 flex flex-col border-r border-slate-200 bg-white overflow-hidden">
          {/* Top Session Actions if not started */}
          {!session.isSessionStarted && (
            <div className="p-4 bg-indigo-50/70 border-b border-indigo-100 flex items-center justify-between shrink-0">
              <div>
                <p className="text-xs font-semibold text-indigo-950">Ready to begin your interview?</p>
                <p className="text-[11px] text-indigo-700">Start an interview session or recover an existing one.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenNewInterview}
                  disabled={sessionEntryPending}
                  className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer"
                  data-testid="start-session-btn"
                >
                  {sessionEntryPending ? "Opening…" : "New interview"}
                </button>
                <form
                  onSubmit={(e) => {
                    void handleManualRecover(e);
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    type="text"
                    value={recoverySessionInput}
                    disabled={sessionEntryPending || sessionTerminalPending}
                    onChange={(e) => setRecoverySessionInput(e.target.value)}
                    aria-invalid={recoverySessionInputInvalid}
                    title={recoverySessionInputInvalid ? "Enter a valid session ID" : undefined}
                    placeholder="session_..."
                    className="w-28 px-2 py-1 text-xs border border-indigo-200 rounded bg-white font-mono"
                  />
                  <button
                    type="submit"
                    disabled={
                      sessionEntryPending
                      || sessionTerminalPending
                      || recoverySessionId === null
                    }
                    className="px-2.5 py-1 bg-white hover:bg-slate-50 text-indigo-700 border border-indigo-200 text-xs font-medium rounded"
                  >
                    {sessionEntryPending ? "Opening…" : "Recover"}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* Scrollable Problem & Transcript Section */}
          <div className="flex-1 flex flex-col p-4 gap-4 overflow-y-auto min-h-0">
            <ProblemCard problem={session.problem} className="shrink-0" />
            <div className="flex-1 min-h-[220px]">
              <TranscriptFeed
                items={session.transcript}
                onRetry={(itemId) => {
                  if (
                    sessionEntryPendingRef.current
                    || sessionTerminalPendingRef.current
                  ) return;
                  void session.retrySubmission(itemId);
                }}
                retryDisabled={sessionEntryPending || sessionTerminalPending}
                className="h-full"
              />
            </div>
          </div>

          {/* Bottom Reasoning Input Area */}
          <div className="p-4 border-t border-slate-200 bg-slate-50/50 shrink-0">
            <VoiceControls
              state={session.voice}
              controls={session.voiceControls}
              disabled={
                !session.isSessionStarted
                || session.sessionStatus !== "ACTIVE"
                || session.isPaused
                || sessionEntryPending
                || sessionTerminalPending
              }
            />
            <StudentInputArea
              onSubmit={(text) => {
                if (
                  sessionEntryPendingRef.current
                  || sessionTerminalPendingRef.current
                ) {
                  throw new Error("Session transition is in progress");
                }
                return session.submitTypedInput(text);
              }}
              disabled={
                !session.isSessionStarted
                || session.sessionStatus !== "ACTIVE"
                || session.isPaused
                || sessionEntryPending
                || sessionTerminalPending
              }
              placeholder={
                session.sessionStatus === "COMPLETED" || session.sessionStatus === "ARCHIVED"
                  ? `Session is ${session.sessionStatus.toLowerCase()}. Reasoning input is closed.`
                  : session.isSessionStarted
                  ? "Enter your proof step (e.g. Choose $v_1 \\in V$. Since $\\deg(v_1) = 5$, by PHP...)"
                  : "Start or recover a session above to submit reasoning."
              }
            />
          </div>
        </section>

        {/* Right Panel: Whiteboard */}
        <section className="right-panel w-1/2 flex flex-col bg-slate-50 overflow-hidden">
          {session.whiteboardSync.status !== "SYNCED" && (
            <div className="panel-tabs bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between shrink-0">
              <strong className="text-xs text-slate-700" data-testid="tab-whiteboard">
                Whiteboard
              </strong>
              <div className="text-[11px] text-slate-500 flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  data-sync={session.whiteboardSync.status}
                />
                <span>
                  {session.whiteboardSync.status === "PENDING"
                    ? "Saving…"
                    : session.whiteboardSync.status === "UNSYNCHRONIZED"
                      ? "Board unavailable"
                      : "Preparing…"}
                </span>
              </div>
            </div>
          )}

          <div className="flex-1 p-4 overflow-hidden flex flex-col">
            <div className="whiteboard-wrapper flex-1 bg-white border border-slate-200 rounded-lg shadow-xs overflow-hidden flex flex-col">
              <div className="whiteboard-toolbar px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span className="font-semibold">Whiteboard</span>
                <button
                  type="button"
                  onClick={() => void whiteboardAdapter.clearAiOverlay()}
                  className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[11px] font-medium"
                >
                  Clear AI marks
                </button>
              </div>
              <div className="flex-1 relative bg-slate-100/50">
                <WhiteboardCanvas
                  adapter={whiteboardAdapter}
                  colorScheme={resolvedTheme}
                  readOnly={
                    !session.isSessionStarted
                    || session.sessionStatus !== "ACTIVE"
                    || session.isPaused
                    || sessionEntryPending
                    || sessionTerminalPending
                    || session.whiteboardSync.status === "UNINITIALIZED"
                    || session.whiteboardSync.status === "UNSYNCHRONIZED"
                  }
                  onEditorMount={handleWhiteboardEditorMount}
                  onNormalizedBoardChange={(change) => {
                    void session.submitWhiteboardMutation(change).catch(() => {
                      // The hook retains the fail-closed synchronization state.
                    });
                  }}
                  className="w-full h-full min-h-[380px]"
                />
              </div>
            </div>
          </div>
        </section>
      </main>
      </div>
    </>
  );
};
