import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionIdSchema, type SessionId } from "../../../packages/domain/src/index.js";
import { ProblemCard } from "./components/ProblemCard.js";
import { TranscriptFeed } from "./components/TranscriptFeed.js";
import { StudentInputArea } from "./components/StudentInputArea.js";
import { VoiceControls } from "./components/VoiceControls.js";
import { BrandMark } from "./components/BrandMark.js";
import { ThemeControl } from "./components/ThemeControl.js";
import { WhiteboardCanvas } from "./components/WhiteboardCanvas.js";
import { TldrawWhiteboardAdapter } from "./tldraw-whiteboard-adapter.js";
import { useInterviewSession } from "./hooks/useInterviewSession.js";
import {
  SessionReviewModal,
  type SessionReviewTab
} from "./components/SessionReviewModal.js";
import type { SessionHistoryReadResponse } from "../../../packages/replay/src/index.js";
import { isSessionIdAddressableForRead } from "./session-read-client.js";
import { useAppRoute } from "./navigation/useAppRoute.js";
import {
  ProductPageRouter,
  type ProductNavPage
} from "./pages/ProductPageRouter.js";
import styles from "./AppShell.module.css";

export const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionsModal, setShowSessionsModal] = useState(false);
  const [recoverySessionInput, setRecoverySessionInput] = useState("");
  const [activeTab, setActiveTab] = useState<"whiteboard" | "formulation">("whiteboard");
  const [compactWorkspace, setCompactWorkspace] = useState<"interview" | "whiteboard">("interview");
  const [reviewTarget, setReviewTarget] = useState<{
    readonly sessionId: SessionId;
    readonly tab: SessionReviewTab;
  } | null>(null);
  const [historyRead, setHistoryRead] = useState<SessionHistoryReadResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const sessionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionsCloseRef = useRef<HTMLButtonElement | null>(null);
  const sessionsDialogRef = useRef<HTMLDivElement | null>(null);
  const moreMenuRef = useRef<HTMLDetailsElement | null>(null);
  const whiteboardTabRef = useRef<HTMLButtonElement | null>(null);
  const detailsTabRef = useRef<HTMLButtonElement | null>(null);

  const whiteboardAdapter = useMemo(() => {
    return new TldrawWhiteboardAdapter();
  }, []);

  const session = useInterviewSession({
    whiteboardAdapter
  });
  const { route, navigate } = useAppRoute();

  const [inputUrl, setInputUrl] = useState(session.baseUrl);

  const handleStartSession = async () => {
    try {
      await session.startSession();
      setShowSessionsModal(false);
      navigate({ page: "interview" });
    } catch {
      // Error handled in session.error
    }
  };

  const handleSubmitReasoning = useCallback((text: string): Promise<void> => {
    return session.submitTypedInput(text);
  }, [session.submitTypedInput]);

  const handleCompleteSession = async (): Promise<void> => {
    const targetSessionId = session.sessionId;
    if (targetSessionId === null) return;
    try {
      await session.completeSession();
      setReviewTarget(null);
      navigate({
        page: "review",
        sessionId: targetSessionId,
        tab: "evaluation"
      });
    } catch {
      // Error handled in session.error
    }
  };

  const openHistoricalReview = (
    targetSessionId: SessionId,
    tab: SessionReviewTab = "evaluation"
  ): void => {
    setShowSessionsModal(false);
    if (session.isSessionStarted && session.sessionStatus === "ACTIVE") {
      setReviewTarget({ sessionId: targetSessionId, tab });
      return;
    }
    navigate({ page: "review", sessionId: targetSessionId, tab });
  };

  const handleRecoverSession = async (targetSessionId: SessionId): Promise<void> => {
    try {
      await session.recoverSession(targetSessionId);
      setShowSessionsModal(false);
      navigate({ page: "interview" });
    } catch {
      // Error handled in session.error
    }
  };

  const handleManualRecover = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (!recoverySessionInput.trim()) return;
    try {
      const parsed = SessionIdSchema.parse(recoverySessionInput.trim());
      await session.recoverSession(parsed);
      setShowSessionsModal(false);
    } catch {
      // Error handled in session.error
    }
  };

  const handleSaveSettings = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    if (session.isTransportManaged) {
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
    setShowSettings(false);
    refreshStoredSessions();
    setShowSessionsModal(true);
  };

  const navigateProductPage = useCallback((page: ProductNavPage): void => {
    setShowSettings(false);
    setShowSessionsModal(false);
    setReviewTarget(null);
    navigate({ page });
  }, [navigate]);

  const closeSessionsModal = useCallback((): void => {
    setShowSessionsModal(false);
    queueMicrotask(() => sessionsTriggerRef.current?.focus());
  }, []);

  const closeReview = useCallback((): void => {
    setReviewTarget(null);
    queueMicrotask(() => sessionsTriggerRef.current?.focus());
  }, []);

  const closeMoreMenu = useCallback((): void => {
    moreMenuRef.current?.removeAttribute("open");
  }, []);

  const handleWorkspaceTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();

      const next = event.currentTarget.id === "workspace-tab-whiteboard"
        ? "formulation"
        : "whiteboard";
      setActiveTab(next);
      queueMicrotask(() => {
        if (next === "whiteboard") {
          whiteboardTabRef.current?.focus();
        } else {
          detailsTabRef.current?.focus();
        }
      });
    },
    []
  );

  const handleSessionsDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== "Tab") return;

      const dialog = sessionsDialogRef.current;
      if (dialog === null) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    []
  );

  useEffect(() => {
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    setHistoryRead(null);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [session.baseUrl]);

  useEffect(() => {
    if (route.page === "sessions") {
      refreshStoredSessions();
      return;
    }
    if (route.page === "home") {
      void session.fetchAvailableSessions();
    }
  }, [refreshStoredSessions, route.page, session.fetchAvailableSessions]);

  useEffect(() => {
    return () => {
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!showSessionsModal) return;
    sessionsCloseRef.current?.focus();
  }, [showSessionsModal]);

  useEffect(() => {
    if (!showSessionsModal && !showSettings) return;

    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;

      if (showSessionsModal) {
        event.preventDefault();
        closeSessionsModal();
        return;
      }

      if (showSettings) {
        event.preventDefault();
        setShowSettings(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [closeSessionsModal, showSessionsModal, showSettings]);


  const hasActiveInterview =
    session.isSessionStarted && session.sessionStatus === "ACTIVE";

  useEffect(() => {
    if (!hasActiveInterview || route.page === "interview") return;
    navigate({ page: "interview" }, { replace: true });
  }, [hasActiveInterview, navigate, route.page]);

  const getStatusBadgeClass = (status: string): string => {
    switch (status) {
      case "ACTIVE":
        return styles.statusActive ?? "";
      case "COMPLETED":
        return styles.statusCompleted ?? "";
      case "ARCHIVED":
        return styles.statusArchived ?? "";
      default:
        return styles.statusOther ?? "";
    }
  };

  const displayRoute =
    hasActiveInterview && route.page !== "interview"
      ? ({ page: "interview" } as const)
      : route;

  if (displayRoute.page !== "interview") {
    return (
      <ProductPageRouter
        route={displayRoute}
        sessions={session.availableSessions}
        currentSessionId={session.sessionId}
        history={historyRead}
        historyLoading={historyLoading}
        historyError={historyError}
        baseUrl={session.baseUrl}
        isTransportManaged={session.isTransportManaged}
        notice={session.error}
        onDismissNotice={session.clearError}
        onNavigate={navigateProductPage}
        onStartInterview={handleStartSession}
        onResumeInterview={handleRecoverSession}
        onRefreshSessions={refreshStoredSessions}
        onSaveBaseUrl={session.setBaseUrl}
        onReviewRoute={(sessionId, tab, options) => {
          navigate(
            {
              page: "review",
              sessionId,
              tab
            },
            options
          );
        }}
        readEvaluation={session.readSessionEvaluation}
        readReplay={session.readSessionReplay}
      />
    );
  }

  return (
    <div className={styles.app ?? ""}>
      {/* Top Header Bar */}
      <header className={styles.header}>
        <button
          type="button"
          className={styles.identityButton}
          onClick={() => {
            if (!hasActiveInterview) navigateProductPage("home");
          }}
          aria-label={hasActiveInterview ? "Interview in progress" : "Open home"}
          disabled={hasActiveInterview}
        >
          <BrandMark size={26} />
          <div className={styles.identityCopy}>
            <div className={styles.identityLine}>
              <h1 className={styles.productName}>Interview</h1>
              {session.isSessionStarted && (
                <span className={styles.sessionState}>
                  {session.sessionStatus.toLowerCase()}
                </span>
              )}
            </div>
            <p className={styles.problemName}>
              {session.problem?.title ?? "Technical interview practice"}
            </p>
          </div>
        </button>

        <div className={styles.headerActions}>
          <span
            className={
              session.isConnected
                ? styles.connectionOnline
                : styles.connectionOffline
            }
            data-testid="connection-status"
            role="status"
            aria-live="polite"
          >
            <span className={styles.statusDot} aria-hidden="true" />
            {session.isConnected ? "Connected" : "Disconnected"}
          </span>

          {session.isStreaming && (
            <span className={styles.streamingState} role="status" aria-live="polite">
              Responding
            </span>
          )}

          {session.isSessionStarted && session.sessionStatus === "ACTIVE" && (
            <button
              type="button"
              onClick={() => void handleCompleteSession()}
              className={styles.endInterviewButton}
              title="Complete interview session"
            >
              End interview
            </button>
          )}

          <button
            ref={sessionsTriggerRef}
            type="button"
            onClick={
              hasActiveInterview
                ? openSessionsModal
                : () => navigateProductPage("sessions")
            }
            className={styles.headerButton}
            data-testid="sessions-btn"
          >
            Sessions
          </button>

          <details ref={moreMenuRef} className={styles.moreMenu}>
            <summary aria-label="More options">•••</summary>
            <div className={styles.morePopover}>
              <div className={styles.menuSection}>
                <span className={styles.menuLabel}>Appearance</span>
                <ThemeControl compact />
              </div>

              {!hasActiveInterview && (
                <button
                  type="button"
                  onClick={() => {
                    closeMoreMenu();
                    navigateProductPage("settings");
                  }}
                  className={styles.menuItem}
                >
                  Settings
                </button>
              )}

              {session.isSessionStarted && session.sessionStatus === "ACTIVE" && (
                <button
                  type="button"
                  onClick={() => {
                    closeMoreMenu();
                    void session.archiveSession();
                  }}
                  className={styles.menuItem}
                >
                  Archive session
                </button>
              )}

              {!session.isTransportManaged && (
                <button
                  type="button"
                  onClick={() => {
                    closeMoreMenu();
                    setShowSettings((prev) => !prev);
                  }}
                  className={styles.menuItem}
                  data-testid="settings-btn"
                >
                  Connection settings
                </button>
              )}

              {session.sessionId !== null && (
                <div className={styles.menuDiagnostics}>
                  <span>{session.sessionId}</span>
                  <span>Seq {session.sequence}</span>
                </div>
              )}
            </div>
          </details>
        </div>
      </header>

      {/* Settings Modal / Drawer */}
      {showSettings && !session.isTransportManaged && (
        <div className={styles.settingsDrawer}>
          <form onSubmit={handleSaveSettings} className={styles.settingsForm}>
            <div className={styles.settingsCopy}>
              <strong>Connection settings</strong>
              <span>Browser-only loopback transport configuration.</span>
            </div>
            <div className={styles.settingsField}>
              <label htmlFor="loopback-command-url">Loopback command URL</label>
              <input
                id="loopback-command-url"
                type="text"
                value={inputUrl}
                onChange={(event) => setInputUrl(event.target.value)}
                className={styles.settingsInput}
                placeholder="http://127.0.0.1:43123"
              />
            </div>
            <div className={styles.settingsActions}>
              <button type="submit" className={styles.primaryButton}>
                Apply
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className={styles.secondaryButton}
              >
                Close
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Sessions Management Modal */}
      {showSessionsModal && (
        <div className={styles.sessionOverlay}>
          <div
            ref={sessionsDialogRef}
            className={styles.sessionsDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sessions-dialog-title"
            onKeyDown={handleSessionsDialogKeyDown}
          >
            <header className={styles.sessionsHeader}>
              <div>
                <div className={styles.sessionsTitleLine}>
                  <h2 id="sessions-dialog-title">Sessions</h2>
                  <span>{session.availableSessions.length}</span>
                </div>
                <p>Resume active work or inspect a grounded completed session.</p>
              </div>
              <button
                type="button"
                ref={sessionsCloseRef}
                onClick={closeSessionsModal}
                className={styles.dialogClose}
                aria-label="Close sessions"
              >
                ×
              </button>
            </header>

            <div className={styles.sessionsToolbar}>
              <button
                type="button"
                onClick={() => void handleStartSession()}
                className={styles.primaryButton}
              >
                New interview
              </button>
              <button
                type="button"
                onClick={refreshStoredSessions}
                className={styles.quietButton}
              >
                Refresh
              </button>
            </div>

            <div className={styles.sessionsBody}>
              {historyLoading && historyRead === null ? (
                <div className={styles.inlineState}>Loading grounded history…</div>
              ) : historyError !== null && historyRead === null ? (
                <div className={styles.inlineError}>{historyError}</div>
              ) : null}

              {historyRead !== null && (
                <section
                  className={styles.historySummary}
                  data-testid="longitudinal-history-panel"
                >
                  <div className={styles.historyHeading}>
                    <div>
                      <h3>Grounded history</h3>
                      <p>Exact problem/version comparisons only.</p>
                    </div>
                    <span>
                      {historyRead.longitudinal.includedSessionCount} bounded session
                      {historyRead.longitudinal.includedSessionCount === 1 ? "" : "s"}
                    </span>
                  </div>

                  {historyRead.longitudinal.evaluationStatistics.some(
                    (item) => item.average.compositeScore !== null
                  ) ? (
                    <div className={styles.historyMetrics}>
                      {historyRead.longitudinal.evaluationStatistics
                        .filter((item) => item.average.compositeScore !== null)
                        .slice(0, 4)
                        .map((item) => (
                          <div
                            key={`${item.problemId}:${item.problemVersion}`}
                            className={styles.historyMetric}
                          >
                            <div>
                              <code>{item.problemId}</code>
                              <span>v{item.problemVersion}</span>
                            </div>
                            <strong>{item.average.compositeScore}</strong>
                            <span>
                              {item.scoredSessionCount["compositeScore"]} scored / {item.sessionCount}
                            </span>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className={styles.historyEmpty}>
                      No supported cross-session score trend is currently grounded.
                    </p>
                  )}

                  {historyRead.longitudinal.improvement.length > 0 && (
                    <div className={styles.historyChanges}>
                      {historyRead.longitudinal.improvement.slice(0, 3).map((item) => (
                        <span key={`${item.fromSessionId}:${item.toSessionId}`}>
                          Composite change{" "}
                          <strong>
                            {item.compositeScoreDelta > 0 ? "+" : ""}
                            {item.compositeScoreDelta}
                          </strong>
                        </span>
                      ))}
                    </div>
                  )}

                  {historyRead.longitudinal.sessionTruncation.truncated && (
                    <p className={styles.historyWarning}>
                      {historyRead.longitudinal.sessionTruncation.remainingCount} additional
                      session(s) are outside the current grounded aggregate coverage.
                    </p>
                  )}
                </section>
              )}

              <section className={styles.sessionListSection}>
                <div className={styles.sessionListHeading}>
                  <h3>Local sessions</h3>
                </div>

                {session.availableSessions.length === 0 ? (
                  <div className={styles.sessionEmpty}>
                    No local sessions found. Start a new interview to begin.
                  </div>
                ) : (
                  <div className={styles.sessionList}>
                    <div className={styles.sessionTableHeader} aria-hidden="true">
                      <span>Session</span>
                      <span>Status</span>
                      <span>Events</span>
                      <span>Updated</span>
                      <span />
                    </div>

                    {session.availableSessions.map((stored) => {
                      const reviewable =
                        (stored.status === "COMPLETED" || stored.status === "ARCHIVED")
                        && isSessionIdAddressableForRead(stored.sessionId);
                      const actionable = stored.status === "ACTIVE" || reviewable;

                      return (
                        <div key={stored.sessionId} className={styles.sessionRow}>
                          <div className={styles.sessionIdentity}>
                            <strong>{stored.problemId ?? "Configured session"}</strong>
                            <code>{stored.sessionId}</code>
                          </div>
                          <span
                            className={`${styles.statusBadge ?? ""} ${getStatusBadgeClass(stored.status)}`}
                          >
                            {stored.status.toLowerCase()}
                          </span>
                          <span className={styles.sessionEvents}>{stored.eventCount}</span>
                          <time className={styles.sessionUpdated} dateTime={stored.updatedAt}>
                            {new Date(stored.updatedAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit"
                            })}
                          </time>
                          <button
                            type="button"
                            onClick={
                              stored.status === "ACTIVE"
                                ? () => void handleRecoverSession(stored.sessionId)
                                : reviewable
                                  ? () => openHistoricalReview(stored.sessionId)
                                  : undefined
                            }
                            disabled={!actionable}
                            className={styles.sessionAction}
                          >
                            {stored.sessionId === session.sessionId && stored.status === "ACTIVE"
                              ? "Current"
                              : stored.status === "ACTIVE"
                                ? "Resume"
                                : reviewable
                                  ? "Review"
                                  : "Unavailable"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {session.error !== null && (
        <div className={styles.errorBanner} role="status">
          <span className={styles.errorLabel}>Notice</span>
          <span className={styles.errorMessage}>{session.error}</span>
          <button
            type="button"
            onClick={session.clearError}
            className={styles.errorDismiss}
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </div>
      )}

      <nav className={styles.compactWorkspaceTabs} aria-label="Compact workspace view">
        <button
          type="button"
          aria-pressed={compactWorkspace === "interview"}
          onClick={() => setCompactWorkspace("interview")}
          className={
            compactWorkspace === "interview"
              ? styles.compactWorkspaceTabActive
              : styles.compactWorkspaceTab
          }
        >
          Interview
        </button>
        <button
          type="button"
          aria-pressed={compactWorkspace === "whiteboard"}
          onClick={() => setCompactWorkspace("whiteboard")}
          className={
            compactWorkspace === "whiteboard"
              ? styles.compactWorkspaceTabActive
              : styles.compactWorkspaceTab
          }
        >
          Whiteboard
        </button>
      </nav>

      {/* Main Split-Pane Workspace */}
      <main className={styles.workspace}>
        <section
          className={styles.reasoningPane}
          aria-label="Interview reasoning"
          data-compact-visible={String(compactWorkspace === "interview")}
        >
          {!session.isSessionStarted && (
            <div className={styles.sessionStart}>
              <div className={styles.sessionStartCopy}>
                <strong>Ready for an interview</strong>
                <span>Start a new session or recover an existing one.</span>
              </div>
              <div className={styles.sessionStartActions}>
                <button
                  type="button"
                  onClick={() => void handleStartSession()}
                  className={styles.primaryButton}
                  data-testid="start-session-btn"
                >
                  Start interview
                </button>
                <form
                  onSubmit={(event) => {
                    void handleManualRecover(event);
                  }}
                  className={styles.recoveryForm}
                >
                  <label className={styles.srOnly} htmlFor="recover-session-id">
                    Session ID
                  </label>
                  <input
                    id="recover-session-id"
                    type="text"
                    value={recoverySessionInput}
                    onChange={(event) => setRecoverySessionInput(event.target.value)}
                    placeholder="session_…"
                    className={styles.recoveryInput}
                  />
                  <button type="submit" className={styles.secondaryButton}>
                    Recover
                  </button>
                </form>
              </div>
            </div>
          )}

          <div className={styles.reasoningContent}>
            <div className={styles.problemRegion}>
              <ProblemCard problem={session.problem} />
            </div>
            <div className={styles.transcriptRegion}>
              <TranscriptFeed
                items={session.transcript}
                onRetry={session.retrySubmission}
              />
            </div>
          </div>

          <div className={styles.composerDock}>
            <VoiceControls
              state={session.voice}
              controls={session.voiceControls}
              disabled={!session.isSessionStarted || session.sessionStatus !== "ACTIVE"}
            />
            <StudentInputArea
              onSubmit={handleSubmitReasoning}
              disabled={
                !session.isSessionStarted
                || session.sessionStatus === "COMPLETED"
                || session.sessionStatus === "ARCHIVED"
              }
              placeholder={
                session.sessionStatus === "COMPLETED" || session.sessionStatus === "ARCHIVED"
                  ? `Session is ${session.sessionStatus.toLowerCase()}. Reasoning input is closed.`
                  : session.isSessionStarted
                    ? "Explain your next reasoning step…"
                    : "Start or recover a session to submit reasoning."
              }
            />
          </div>
        </section>

        <section
          className={styles.boardPane}
          aria-label="Interview workspace"
          data-compact-visible={String(compactWorkspace === "whiteboard")}
        >
          <div className={styles.boardHeader}>
            <div className={styles.tabs} role="tablist" aria-label="Workspace view">
              <button
                type="button"
                ref={whiteboardTabRef}
                id="workspace-tab-whiteboard"
                role="tab"
                aria-selected={activeTab === "whiteboard"}
                aria-controls="workspace-panel"
                tabIndex={activeTab === "whiteboard" ? 0 : -1}
                onClick={() => setActiveTab("whiteboard")}
                onKeyDown={handleWorkspaceTabKeyDown}
                className={
                  activeTab === "whiteboard"
                    ? styles.tabActive
                    : styles.tab
                }
                data-testid="tab-whiteboard"
              >
                Whiteboard
              </button>
              <button
                type="button"
                ref={detailsTabRef}
                id="workspace-tab-details"
                role="tab"
                aria-selected={activeTab === "formulation"}
                aria-controls="workspace-panel"
                tabIndex={activeTab === "formulation" ? 0 : -1}
                onClick={() => setActiveTab("formulation")}
                onKeyDown={handleWorkspaceTabKeyDown}
                className={
                  activeTab === "formulation"
                    ? styles.tabActive
                    : styles.tab
                }
                data-testid="tab-formulation"
              >
                Details
              </button>
            </div>

            <div className={styles.boardHeaderActions}>
              {activeTab === "whiteboard" && (
                <button
                  type="button"
                  onClick={() => void whiteboardAdapter.clearAiOverlay()}
                  className={styles.quietButton}
                >
                  Clear overlays
                </button>
              )}
              <span className={styles.protectedState}>
                <span className={styles.protectedDot} aria-hidden="true" />
                Protected overlays
              </span>
            </div>
          </div>

          <div
            id="workspace-panel"
            className={styles.boardContent}
            role="tabpanel"
            aria-labelledby={
              activeTab === "whiteboard"
                ? "workspace-tab-whiteboard"
                : "workspace-tab-details"
            }
          >
            {activeTab === "whiteboard" ? (
              <WhiteboardCanvas
                adapter={whiteboardAdapter}
                className={styles.whiteboardCanvas ?? ""}
              />
            ) : (
              <div className={styles.detailsPane}>
                <section className={styles.detailsSection}>
                  <div className={styles.detailsHeading}>
                    <h2>Session details</h2>
                    <p>Public problem identity and local runtime context.</p>
                  </div>

                  <dl className={styles.detailList}>
                    <div>
                      <dt>Status</dt>
                      <dd>{session.sessionStatus}</dd>
                    </div>
                    <div>
                      <dt>Connection</dt>
                      <dd>{session.isConnected ? "Connected" : "Disconnected"}</dd>
                    </div>
                    {session.sessionId !== null && (
                      <div>
                        <dt>Session ID</dt>
                        <dd><code>{session.sessionId}</code></dd>
                      </div>
                    )}
                    {session.sessionId !== null && (
                      <div>
                        <dt>Sequence</dt>
                        <dd><code>{session.sequence}</code></dd>
                      </div>
                    )}
                  </dl>
                </section>

                <section className={styles.detailsSection}>
                  <div className={styles.detailsHeading}>
                    <h2>Problem</h2>
                  </div>

                  {session.problem === null ? (
                    <p className={styles.emptyDetails}>
                      No Oxford Mathematics problem view is exposed for this session.
                    </p>
                  ) : (
                    <>
                      <dl className={styles.detailList}>
                        <div>
                          <dt>Problem ID</dt>
                          <dd><code>{session.problem.id}</code></dd>
                        </div>
                        <div>
                          <dt>Version</dt>
                          <dd><code>{session.problem.version}</code></dd>
                        </div>
                        <div>
                          <dt>Difficulty</dt>
                          <dd>{session.problem.difficulty}</dd>
                        </div>
                        <div>
                          <dt>Category</dt>
                          <dd>{session.problem.category}</dd>
                        </div>
                      </dl>

                      {session.problem.topics.length > 0 && (
                        <div className={styles.topicList} aria-label="Problem topics">
                          {session.problem.topics.map((topic) => (
                            <span key={topic}>{topic}</span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}
          </div>
        </section>
      </main>
      {reviewTarget !== null ? (
        <SessionReviewModal
          sessionId={reviewTarget.sessionId}
          initialTab={reviewTarget.tab}
          readEvaluation={session.readSessionEvaluation}
          readReplay={session.readSessionReplay}
          onClose={closeReview}
        />
      ) : null}
    </div>
  );
};
