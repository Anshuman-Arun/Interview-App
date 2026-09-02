import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionIdSchema, type SessionId } from "../../../packages/domain/src/index.js";
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
import { useAppearance } from "./appearance/AppearanceProvider.js";
import "./styles/app.css";
import "./styles/transcript.css";

export const App: React.FC = () => {
  const { resolvedTheme } = useAppearance();
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionsModal, setShowSessionsModal] = useState(false);
  const [recoverySessionInput, setRecoverySessionInput] = useState("");
  const [activeTab, setActiveTab] = useState<"whiteboard" | "formulation">("whiteboard");
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

  const [inputUrl, setInputUrl] = useState(session.baseUrl);
  const recoverySessionParse = SessionIdSchema.safeParse(recoverySessionInput.trim());
  const recoverySessionId = recoverySessionParse.success
    ? recoverySessionParse.data
    : null;
  const recoverySessionInputInvalid =
    recoverySessionInput.trim().length > 0 && recoverySessionId === null;

  useEffect(() => {
    setInputUrl(session.baseUrl);
  }, [session.baseUrl]);

  const handleStartSession = async (): Promise<void> => {
    if (sessionEntryPendingRef.current || sessionTerminalPendingRef.current) return;
    sessionEntryPendingRef.current = true;
    setSessionEntryPending(true);
    try {
      const storedSessions = await session.fetchAvailableSessionsStrict();
      const activeSessions = storedSessions.filter(
        (storedSession) => storedSession.status === "ACTIVE"
      );
      if (activeSessions.length > 1) {
        setShowSessionsModal(false);
        navigate({ page: "sessions" });
        return;
      }
      const existingActive = activeSessions[0];
      if (existingActive !== undefined) {
        const recoveredStatus = await session.recoverSession(existingActive.sessionId);
        setShowSessionsModal(false);
        navigate(
          recoveredStatus === "ACTIVE"
            ? { page: "interview" }
            : { page: "sessions" }
        );
        return;
      }
      await session.startSession();
      setShowSessionsModal(false);
      navigate({ page: "interview" });
    } catch {
      // Error handled in session.error
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
      await session.voiceControls.disableMicrophone().catch(() => undefined);
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
      await session.voiceControls.disableMicrophone().catch(() => undefined);
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

  const openHistoricalReview = (targetSessionId: SessionId): void => {
    if (session.isSessionStarted && session.sessionStatus === "ACTIVE") return;
    setShowSessionsModal(false);
    navigate({
      page: "review",
      sessionId: targetSessionId,
      view: "evaluation"
    });
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
      setShowSessionsModal(false);
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
      setShowSessionsModal(false);
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

  const handleSaveSettings = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    if (
      session.isTransportManaged
      || (session.isSessionStarted && session.sessionStatus === "ACTIVE")
      || sessionEntryPendingRef.current
      || sessionTerminalPendingRef.current
    ) {
      setShowSettings(false);
      return;
    }
    session.setBaseUrl(inputUrl.trim());
    setShowSettings(false);
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

  const openSessionsModal = (): void => {
    if (session.isSessionStarted && session.sessionStatus === "ACTIVE") {
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
      setHistoryRead(null);
      setHistoryLoading(false);
      setHistoryError(null);
      void session.fetchAvailableSessions();
    } else {
      refreshStoredSessions();
    }
    setShowSessionsModal(true);
  };

  const navigateProductPage = useCallback((page: ProductPageId): void => {
    setShowSettings(false);
    setShowSessionsModal(false);
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
    if (route.page === "home") {
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
  const displayRoute = routeForActiveInterview(route, hasActiveInterview);

  useEffect(() => {
    if (!hasActiveInterview || route.page === "interview") return;
    navigate({ page: "interview" }, { replace: true });
  }, [hasActiveInterview, navigate, route.page]);

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
      case "COMPLETED":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "ARCHIVED":
        return "bg-slate-100 text-slate-600 border-slate-200";
      default:
        return "bg-amber-50 text-amber-700 border-amber-200";
    }
  };

  if (displayRoute.page !== "interview") {
    return (
      <ProductPageRouter
        route={displayRoute}
        sessions={session.availableSessions}
        activeSessionId={resumableActiveSessionId}
        currentSessionId={hasActiveInterview ? session.sessionId : null}
        activeProblemTitle={hasActiveInterview ? session.problem?.title ?? null : null}
        canReview={(storedSession) =>
          (
            storedSession.status === "COMPLETED"
            || storedSession.status === "ARCHIVED"
          )
          && isSessionIdAddressableForRead(storedSession.sessionId)
        }
        onNavigatePage={navigateProductPage}
        sessionEntryPending={sessionEntryPending}
        onEnterInterview={() => {
          void handleStartSession();
        }}
        onResume={(sessionId) => {
          void handleRecoverSession(sessionId);
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
          locked: hasActiveInterview || sessionEntryPending || sessionTerminalPending,
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
  }

  return (
    <div className="interview-app-container flex flex-col h-screen w-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      {/* Focused live interview header */}
      <header className="app-header">
        <button
          type="button"
          className="app-header__identity"
          disabled={hasActiveInterview}
          onClick={() => navigateProductPage("home")}
          aria-label={hasActiveInterview ? "Interview in progress" : "Open Home"}
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

          <button
            type="button"
            onClick={
              hasActiveInterview
                ? openSessionsModal
                : () => navigateProductPage("sessions")
            }
            className="app-header__quiet"
            data-testid="sessions-btn"
          >
            Sessions
          </button>

          <button
            type="button"
            disabled={hasActiveInterview && session.isTransportManaged}
            onClick={() => {
              if (hasActiveInterview) {
                if (!session.isTransportManaged) {
                  setShowSettings((previous) => !previous);
                }
                return;
              }
              navigateProductPage("settings");
            }}
            className="app-header__quiet"
            data-testid="settings-btn"
          >
            Settings
          </button>
        </div>
      </header>

      {/* Settings Modal / Drawer */}
      {showSettings && hasActiveInterview && !session.isTransportManaged && (
        <div className="settings-drawer bg-slate-800 text-white px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-6 shrink-0 shadow-md">
          <form onSubmit={handleSaveSettings} className="flex flex-wrap items-center gap-4 flex-1">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                Loopback Command URL · locked during active interview
              </label>
              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                disabled
                aria-disabled="true"
                className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white font-mono w-56 focus:outline-none focus:border-indigo-400"
                placeholder="http://127.0.0.1:43123"
              />
            </div>

            <div className="flex items-end gap-2 pt-4">
              <button
                type="submit"
                disabled
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold"
              >
                Locked
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs"
              >
                Close
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Sessions Management Modal */}
      {showSessionsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden border border-slate-200"
            role="dialog"
            aria-modal="true"
            aria-labelledby="stored-sessions-title"
          >
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <span id="stored-sessions-title" className="text-base font-bold text-slate-900">Stored Interview Sessions</span>
                <span className="text-xs text-slate-500 font-mono">
                  ({session.availableSessions.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowSessionsModal(false)}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold"
                aria-label="Close stored sessions"
              >
                ✕
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                {hasActiveInterview ? (
                  <span className="text-[11px] text-slate-500">
                    Current interview is active. End or archive it before starting or reviewing another session.
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStartSession()}
                    disabled={sessionEntryPending || sessionTerminalPending}
                    className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-md shadow-xs transition-colors"
                  >
                    {sessionEntryPending ? "Opening interview…" : "+ Start New Interview Session"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (hasActiveInterview) {
                      void session.fetchAvailableSessions();
                    } else {
                      refreshStoredSessions();
                    }
                  }}
                  className="text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  Refresh List
                </button>
              </div>

              {!hasActiveInterview ? (
                historyLoading && historyRead === null ? (
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                    Loading grounded history…
                  </div>
                ) : historyError !== null && historyRead === null ? (
                  <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                    {historyError}
                  </div>
                ) : null
              ) : null}

              {!hasActiveInterview && historyRead !== null ? (
                <section
                  className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                  data-testid="longitudinal-history-panel"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-bold text-slate-900">Grounded history</h3>
                    <span className="text-[10px] text-slate-500">
                      {historyRead.longitudinal.includedSessionCount} bounded session projection(s)
                    </span>
                  </div>
                  {historyRead.longitudinal.evaluationStatistics.some(
                    (item) => item.average.compositeScore !== null
                  ) ? (
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {historyRead.longitudinal.evaluationStatistics
                        .filter((item) => item.average.compositeScore !== null)
                        .slice(0, 4)
                        .map((item) => (
                          <div
                            key={`${item.problemId}:${item.problemVersion}`}
                            className="rounded border border-slate-200 bg-white p-2 text-[11px]"
                          >
                            <div className="font-mono text-[10px] text-slate-500 break-all">
                              {item.problemId} @ {item.problemVersion}
                            </div>
                            <div className="mt-1 font-semibold text-slate-800">
                              Composite average: {item.average.compositeScore}
                            </div>
                            <div className="text-slate-500">
                              {item.scoredSessionCount["compositeScore"]} scored / {item.sessionCount} evaluated
                            </div>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-slate-500">
                      No supported cross-session score trend is currently grounded.
                    </p>
                  )}
                  {historyRead.longitudinal.improvement.length > 0 ? (
                    <div className="mt-2 text-[11px] text-slate-600">
                      {historyRead.longitudinal.improvement.slice(0, 3).map((item) => (
                        <div key={`${item.fromSessionId}:${item.toSessionId}`}>
                          Exact-problem composite change:{" "}
                          {item.compositeScoreDelta > 0 ? "+" : ""}
                          {item.compositeScoreDelta}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {historyRead.longitudinal.sessionTruncation.truncated ? (
                    <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
                      {historyRead.longitudinal.sessionTruncation.remainingCount} session(s) are outside the current grounded aggregate coverage.
                    </p>
                  ) : null}
                  <p className="mt-2 text-[10px] text-slate-400">
                    Comparisons require exact problem ID and version. Unsupported dimensions remain excluded.
                  </p>
                </section>
              ) : null}

              {session.availableSessions.length === 0 ? (
                <div className="text-center py-8 text-slate-400 text-xs">
                  No local sessions found. Start a new session to begin.
                </div>
              ) : (
                session.availableSessions.map((s) => (
                  <div
                    key={s.sessionId}
                    className="p-3 rounded-lg border border-slate-200 hover:border-indigo-300 transition-colors flex items-center justify-between bg-white shadow-2xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-slate-900">{s.sessionId}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${getStatusBadgeClass(s.status)}`}>
                          {s.status}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-3">
                        <span>{hasActiveInterview ? "Session record" : `Problem: ${s.problemId ?? "Configured session"}`}</span>
                        <span>•</span>
                        <span>Events: {s.eventCount}</span>
                        <span>•</span>
                        <span>Updated: {new Date(s.updatedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={
                        s.status === "ACTIVE" && s.sessionId === session.sessionId
                          ? undefined
                          : s.status === "ACTIVE"
                            ? () => void handleRecoverSession(s.sessionId)
                          : (
                              !hasActiveInterview
                              && (s.status === "COMPLETED" || s.status === "ARCHIVED")
                              && isSessionIdAddressableForRead(s.sessionId)
                            )
                            ? () => openHistoricalReview(s.sessionId)
                            : undefined
                      }
                      disabled={
                        (
                          s.status === "ACTIVE"
                          && (
                            hasActiveInterview
                            || sessionEntryPending
                            || sessionTerminalPending
                          )
                        )
                        || (
                          s.status !== "ACTIVE"
                          && (
                            hasActiveInterview
                            || (s.status !== "COMPLETED" && s.status !== "ARCHIVED")
                            || !isSessionIdAddressableForRead(s.sessionId)
                          )
                        )
                      }
                      className={`px-3 py-1 border rounded text-xs font-semibold transition-colors ${
                        s.status === "ACTIVE"
                          ? "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                          : (
                              (s.status === "COMPLETED" || s.status === "ARCHIVED")
                              && isSessionIdAddressableForRead(s.sessionId)
                            )
                            ? "bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200"
                            : "bg-slate-50 text-slate-400 border-slate-200 cursor-not-allowed"
                      }`}
                    >
                      {s.sessionId === session.sessionId && s.status === "ACTIVE"
                        ? "Current"
                        : s.status === "ACTIVE"
                          ? "Resume"
                          : (
                              (s.status === "COMPLETED" || s.status === "ARCHIVED")
                              && isSessionIdAddressableForRead(s.sessionId)
                            )
                            ? "Review"
                            : "Unavailable"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

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
            setActiveTab("whiteboard");
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
                  onClick={() => void handleStartSession()}
                  disabled={sessionEntryPending}
                  className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer"
                  data-testid="start-session-btn"
                >
                  {sessionEntryPending ? "Opening…" : "Start Session"}
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

        {/* Right Panel: Whiteboard & Formulation Inspector */}
        <section className="right-panel w-1/2 flex flex-col bg-slate-50 overflow-hidden">
          {/* Panel Tab Header */}
          <div className="panel-tabs bg-white border-b border-slate-200 px-4 py-2 flex items-center justify-between shrink-0">
            <div
              className="flex items-center gap-2"
              role="tablist"
              aria-label="Whiteboard view"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "whiteboard"}
                onClick={() => setActiveTab("whiteboard")}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeTab === "whiteboard"
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid="tab-whiteboard"
              >
                Whiteboard
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "formulation"}
                onClick={() => setActiveTab("formulation")}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeTab === "formulation"
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid="tab-formulation"
              >
                Details
              </button>
            </div>

            <div className="text-[11px] text-slate-400 flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full"
                data-sync={session.whiteboardSync.status}
              />
              <span>
                {session.whiteboardSync.status === "SYNCED"
                  ? "Board synced"
                  : session.whiteboardSync.status === "PENDING"
                    ? "Updating board…"
                    : session.whiteboardSync.status === "UNSYNCHRONIZED"
                      ? "Board unavailable"
                      : "Board readying"}
              </span>
            </div>
          </div>

          {/* Panel Content */}
          <div className="flex-1 p-4 overflow-hidden flex flex-col">
            {activeTab === "whiteboard" ? (
              <div className="whiteboard-wrapper flex-1 bg-white border border-slate-200 rounded-lg shadow-xs overflow-hidden flex flex-col">
                <div className="whiteboard-toolbar px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-xs text-slate-600">
                  <span className="font-semibold flex items-center gap-1.5">
                    <span>Interview Whiteboard</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void whiteboardAdapter.clearAiOverlay()}
                      className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[11px] font-medium"
                    >
                      Clear AI Overlays
                    </button>
                  </div>
                </div>
                <div className="flex-1 relative bg-slate-100/50">
                  <WhiteboardCanvas
                    adapter={whiteboardAdapter}
                    colorScheme={resolvedTheme}
                    readOnly={
                      !session.isSessionStarted
                      || session.sessionStatus !== "ACTIVE"
                      || sessionEntryPending
                      || sessionTerminalPending
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
            ) : (
              <div className="formulation-inspector flex-1 bg-white border border-slate-200 rounded-lg p-5 overflow-y-auto space-y-4 shadow-xs">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 mb-1">
                    Session Context
                  </h3>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Safe public identity for the problem bound to this session.
                  </p>
                </div>

                <div className="border border-slate-200 rounded-md p-4 bg-slate-50 text-sm text-slate-500">
                  Problem metadata is intentionally hidden during the live interview.
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};
