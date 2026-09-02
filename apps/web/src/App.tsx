import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionIdSchema, type SessionId } from "../../../packages/domain/src/index.js";
import { ProblemCard } from "./components/ProblemCard.js";
import { TranscriptFeed } from "./components/TranscriptFeed.js";
import { StudentInputArea } from "./components/StudentInputArea.js";
import { WhiteboardCanvas } from "./components/WhiteboardCanvas.js";
import {
  TldrawWhiteboardAdapter,
  type TldrawEditor
} from "./tldraw-whiteboard-adapter.js";
import { useInterviewSession } from "./hooks/useInterviewSession.js";
import {
  SessionReviewModal,
  type SessionReviewTab
} from "./components/SessionReviewModal.js";
import type { SessionHistoryReadResponse } from "../../../packages/replay/src/index.js";
import { isSessionIdAddressableForRead } from "./session-read-client.js";
import "./styles/app.css";
import "./styles/transcript.css";

export const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [showSessionsModal, setShowSessionsModal] = useState(false);
  const [recoverySessionInput, setRecoverySessionInput] = useState("");
  const [activeTab, setActiveTab] = useState<"whiteboard" | "formulation">("whiteboard");
  const [reviewTarget, setReviewTarget] = useState<{
    readonly sessionId: SessionId;
    readonly tab: SessionReviewTab;
  } | null>(null);
  const [historyRead, setHistoryRead] = useState<SessionHistoryReadResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);

  const whiteboardAdapter = useMemo(() => {
    return new TldrawWhiteboardAdapter();
  }, []);

  const session = useInterviewSession({
    whiteboardAdapter
  });

  const [inputUrl, setInputUrl] = useState(session.baseUrl);

  const handleStartSession = async () => {
    try {
      await session.startSession();
      setShowSessionsModal(false);
    } catch {
      // Error handled in session.error
    }
  };

  const handleCompleteSession = async (): Promise<void> => {
    const targetSessionId = session.sessionId;
    if (targetSessionId === null) return;
    try {
      await session.completeSession();
      setReviewTarget({ sessionId: targetSessionId, tab: "evaluation" });
    } catch {
      // Error handled in session.error
    }
  };

  const openHistoricalReview = (
    targetSessionId: SessionId,
    tab: SessionReviewTab = "evaluation"
  ): void => {
    setShowSessionsModal(false);
    setReviewTarget({ sessionId: targetSessionId, tab });
  };

  const handleRecoverSession = async (targetSessionId: SessionId): Promise<void> => {
    try {
      await session.recoverSession(targetSessionId);
      setShowSessionsModal(false);
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

  const refreshStoredSessions = (): void => {
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
  };

  const openSessionsModal = (): void => {
    refreshStoredSessions();
    setShowSessionsModal(true);
  };

  useEffect(() => {
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    setHistoryRead(null);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [session.baseUrl]);

  useEffect(() => {
    return () => {
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
    };
  }, []);


  const handleWhiteboardEditorMount = useCallback((_editor: TldrawEditor): void => {
    void session.synchronizeWhiteboard().catch(() => {
      // The sync status remains fail-closed and is surfaced by the session hook.
    });
  }, [session.synchronizeWhiteboard]);

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

  return (
    <div className="interview-app-container flex flex-col h-screen w-screen bg-slate-100 font-sans text-slate-900 overflow-hidden">
      {/* Top Header Bar */}
      <header className="app-header bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between shadow-xs z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-xs text-sm">
            IV
          </div>
          <div>
            <h1 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <span>Technical Interview Runtime</span>
              <span className="text-xs font-normal text-slate-500 font-mono bg-slate-100 px-2 py-0.5 rounded border border-slate-200">
                Durable Runtime
              </span>
            </h1>
            <p className="text-xs text-slate-500">
              {session.problem?.title ?? "Application-owned interview session composition"}
            </p>
          </div>
        </div>

        {/* Status Indicators & Controls */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-medium ${
                session.isConnected
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-slate-100 text-slate-600 border border-slate-200"
              }`}
              data-testid="connection-status"
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  session.isConnected ? "bg-emerald-500" : "bg-slate-400"
                }`}
              />
              <span>{session.isConnected ? "Connected" : "Disconnected"}</span>
            </span>

            {session.isStreaming && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200 animate-pulse">
                <span>⚡ Stream Active</span>
              </span>
            )}
          </div>

          {session.sessionId !== null && (
            <div className="text-xs font-mono bg-slate-50 px-2.5 py-1 rounded border border-slate-200 flex items-center gap-2">
              <span className="text-slate-400">Session:</span>
              <span className="font-semibold text-slate-800">{session.sessionId}</span>
              <span className="text-slate-300">|</span>
              <span className={`px-1.5 py-0.2 rounded text-[10px] font-semibold border ${getStatusBadgeClass(session.sessionStatus)}`}>
                {session.sessionStatus}
              </span>
              <span className="text-slate-300">|</span>
              <span className="text-slate-400">Seq:</span>
              <span className="font-semibold text-slate-800">{session.sequence}</span>
            </div>
          )}

          {session.isSessionStarted && session.sessionStatus === "ACTIVE" && (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleCompleteSession()}
                className="text-xs font-medium text-emerald-700 hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1 rounded border border-emerald-200 transition-colors"
                title="Complete interview session"
              >
                ✓ Complete
              </button>
              <button
                type="button"
                onClick={() => void session.archiveSession()}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-2.5 py-1 rounded border border-slate-200 transition-colors"
                title="Archive interview session"
              >
                Archive
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={openSessionsModal}
            className="text-xs font-medium text-indigo-700 hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-md border border-indigo-200 transition-colors"
            data-testid="sessions-btn"
          >
            📋 Sessions
          </button>

          {!session.isTransportManaged && (
            <button
              type="button"
              onClick={() => setShowSettings((prev) => !prev)}
              className="text-xs font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-md border border-slate-200 transition-colors"
              data-testid="settings-btn"
            >
              ⚙️ Config
            </button>
          )}
        </div>
      </header>

      {/* Settings Modal / Drawer */}
      {showSettings && !session.isTransportManaged && (
        <div className="settings-drawer bg-slate-800 text-white px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-6 shrink-0 shadow-md">
          <form onSubmit={handleSaveSettings} className="flex flex-wrap items-center gap-4 flex-1">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                Loopback Command URL
              </label>
              <input
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white font-mono w-56 focus:outline-none focus:border-indigo-400"
                placeholder="http://127.0.0.1:43123"
              />
            </div>

            <div className="flex items-end gap-2 pt-4">
              <button
                type="submit"
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold"
              >
                Apply Config
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
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="text-base font-bold text-slate-900">Stored Interview Sessions</span>
                <span className="text-xs text-slate-500 font-mono">
                  ({session.availableSessions.length})
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowSessionsModal(false)}
                className="text-slate-400 hover:text-slate-600 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <button
                  type="button"
                  onClick={() => void handleStartSession()}
                  className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-md shadow-xs transition-colors"
                >
                  + Start New Interview Session
                </button>
                <button
                  type="button"
                  onClick={refreshStoredSessions}
                  className="text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  Refresh List
                </button>
              </div>

              {historyLoading && historyRead === null ? (
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                  Loading grounded history…
                </div>
              ) : historyError !== null && historyRead === null ? (
                <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  {historyError}
                </div>
              ) : null}

              {historyRead !== null ? (
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
                        <span>Problem: {s.problemId ?? "Configured session"}</span>
                        <span>•</span>
                        <span>Events: {s.eventCount}</span>
                        <span>•</span>
                        <span>Updated: {new Date(s.updatedAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={
                        s.status === "ACTIVE"
                          ? () => void handleRecoverSession(s.sessionId)
                          : (
                              (s.status === "COMPLETED" || s.status === "ARCHIVED")
                              && isSessionIdAddressableForRead(s.sessionId)
                            )
                            ? () => openHistoricalReview(s.sessionId)
                            : undefined
                      }
                      disabled={
                        s.status !== "ACTIVE"
                        && (
                          (s.status !== "COMPLETED" && s.status !== "ARCHIVED")
                          || !isSessionIdAddressableForRead(s.sessionId)
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
      <main className="flex-1 flex overflow-hidden">
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
                  className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-md shadow-sm transition-colors cursor-pointer"
                  data-testid="start-session-btn"
                >
                  Start Session
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
                    onChange={(e) => setRecoverySessionInput(e.target.value)}
                    placeholder="session_..."
                    className="w-28 px-2 py-1 text-xs border border-indigo-200 rounded bg-white font-mono"
                  />
                  <button
                    type="submit"
                    className="px-2.5 py-1 bg-white hover:bg-slate-50 text-indigo-700 border border-indigo-200 text-xs font-medium rounded"
                  >
                    Recover
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
                onRetry={session.retrySubmission}
                className="h-full"
              />
            </div>
          </div>

          {/* Bottom Reasoning Input Area */}
          <div className="p-4 border-t border-slate-200 bg-slate-50/50 shrink-0">
            <StudentInputArea
              onSubmit={(text) => session.submitTypedInput(text)}
              disabled={!session.isSessionStarted || session.sessionStatus === "COMPLETED" || session.sessionStatus === "ARCHIVED"}
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
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab("whiteboard")}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeTab === "whiteboard"
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid="tab-whiteboard"
              >
                🎨 Interactive tldraw Whiteboard
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("formulation")}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                  activeTab === "formulation"
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                data-testid="tab-formulation"
              >
                📊 Session Context
              </button>
            </div>

            <div className="text-[11px] text-slate-400 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-violet-400" />
              <span>AI Overlay Protected Layer</span>
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
                    readOnly={
                      !session.isSessionStarted
                      || session.sessionStatus !== "ACTIVE"
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

                {session.problem === null ? (
                  <div className="border border-slate-200 rounded-md p-4 bg-slate-50 text-sm text-slate-500">
                    This session does not expose an Oxford Mathematics problem view.
                  </div>
                ) : (
                  <>
                    <div className="border border-slate-200 rounded-md p-4 bg-slate-50">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                        <div>
                          <div className="font-semibold text-slate-500 uppercase tracking-wider">Problem ID</div>
                          <div className="font-mono text-slate-800 mt-1">{session.problem.id}</div>
                        </div>
                        <div>
                          <div className="font-semibold text-slate-500 uppercase tracking-wider">Version</div>
                          <div className="font-mono text-slate-800 mt-1">{session.problem.version}</div>
                        </div>
                        <div>
                          <div className="font-semibold text-slate-500 uppercase tracking-wider">Difficulty</div>
                          <div className="text-slate-800 mt-1">{session.problem.difficulty}</div>
                        </div>
                        <div>
                          <div className="font-semibold text-slate-500 uppercase tracking-wider">Category</div>
                          <div className="text-slate-800 mt-1">{session.problem.category}</div>
                        </div>
                      </div>
                    </div>

                    <div className="border border-slate-200 rounded-md p-4 bg-indigo-50/50">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-900 mb-2">
                        Topics
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {session.problem.topics.map((topic) => (
                          <span
                            key={topic}
                            className="text-xs bg-white border border-indigo-100 rounded px-2 py-1 text-slate-700"
                          >
                            {topic}
                          </span>
                        ))}
                      </div>
                    </div>
                  </>
                )}
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
          onClose={() => setReviewTarget(null)}
        />
      ) : null}
    </div>
  );
};
