import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SessionIdSchema,
  type InterviewSessionConfiguration,
  type SessionId
} from "../../../packages/domain/src/index.js";
import { AppearanceDock } from "./components/AppearanceDock.js";
import { BrandMark } from "./components/BrandMark.js";
import { SessionDurationNotice } from "./components/SessionDurationNotice.js";
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

const QUANT_REATTACH_SESSION_KEY = "interview.quant.active-session";

function readQuantReattachSessionId(): SessionId | null {
  try {
    const value = globalThis.sessionStorage.getItem(QUANT_REATTACH_SESSION_KEY);
    if (value === null) return null;
    const parsed = SessionIdSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeQuantReattachSessionId(sessionId: SessionId): void {
  try {
    globalThis.sessionStorage.setItem(QUANT_REATTACH_SESSION_KEY, sessionId);
  } catch {
    // Reattachment is a convenience only; server authority never depends on browser storage.
  }
}

function clearQuantReattachSessionId(): void {
  try {
    globalThis.sessionStorage.removeItem(QUANT_REATTACH_SESSION_KEY);
  } catch {
    // Reattachment is a convenience only; server authority never depends on browser storage.
  }
}

export const App: React.FC = () => {
  const { resolvedTheme } = useAppearance();
  const [recoverySessionInput, setRecoverySessionInput] = useState("");
  const [compactPane, setCompactPane] =
    useState<"interview" | "whiteboard">("interview");
  const [splitPercent, setSplitPercent] = useState(38);
  const [paneFocus, setPaneFocus] =
    useState<"split" | "transcript" | "whiteboard">("split");
  const [endConfirmOpen, setEndConfirmOpen] = useState(false);
  const liveWorkspaceRef = useRef<HTMLElement | null>(null);
  const compactInterviewTabRef = useRef<HTMLButtonElement | null>(null);
  const compactWhiteboardTabRef = useRef<HTMLButtonElement | null>(null);
  const endControlRef = useRef<HTMLDivElement | null>(null);
  const endButtonRef = useRef<HTMLButtonElement | null>(null);
  const endCancelRef = useRef<HTMLButtonElement | null>(null);
  const [historyRead, setHistoryRead] = useState<SessionHistoryReadResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sessionAuthorityChecking, setSessionAuthorityChecking] = useState(true);
  const [sessionAuthorityUnavailable, setSessionAuthorityUnavailable] = useState(false);
  const sessionAuthorityCheckEpochRef = useRef(0);
  const historyAbortRef = useRef<AbortController | null>(null);
  const sessionEntryPendingRef = useRef(false);
  const sessionTerminalPendingRef = useRef(false);
  const [sessionEntryPending, setSessionEntryPending] = useState(false);
  const [sessionTerminalPending, setSessionTerminalPending] = useState(false);
  const [reloadQuantSessionId] = useState<SessionId | null>(() => readQuantReattachSessionId());
  const reloadQuantRecoveryAttemptedRef = useRef(false);

  const setSplitFromClientX = useCallback((clientX: number): void => {
    const workspace = liveWorkspaceRef.current;
    if (workspace === null) return;
    const rect = workspace.getBoundingClientRect();
    if (rect.width <= 0) return;
    const next = ((clientX - rect.left) / rect.width) * 100;
    setSplitPercent(Math.min(68, Math.max(26, next)));
  }, []);

  const whiteboardAdapter = useMemo(() => {
    return new TldrawWhiteboardAdapter();
  }, []);

  const session = useInterviewSession({
    whiteboardAdapter
  });
  const { route, navigate } = useProductNavigation();
  const routeRef = useRef(route);
  const reviewAutoUpgradeEpochRef = useRef(0);
  const reviewAutoUpgradePendingRef = useRef<{
    readonly epoch: number;
    readonly sessionId: SessionId;
    resolvedOxford: boolean | null;
  } | null>(null);
  routeRef.current = route;

  useEffect(() => {
    const pending = reviewAutoUpgradePendingRef.current;
    if (pending === null) return;
    if (reviewAutoUpgradeEpochRef.current !== pending.epoch) {
      reviewAutoUpgradePendingRef.current = null;
      return;
    }

    const atIntendedReplay =
      route.page === "review"
      && route.sessionId === pending.sessionId
      && route.view === "replay";
    if (!atIntendedReplay) {
      reviewAutoUpgradeEpochRef.current += 1;
      reviewAutoUpgradePendingRef.current = null;
      return;
    }
    if (pending.resolvedOxford !== true) return;

    reviewAutoUpgradePendingRef.current = null;
    navigate({
      page: "review",
      sessionId: pending.sessionId,
      view: "evaluation"
    }, { replace: true });
  }, [navigate, route]);

  const openDefaultReview = useCallback((targetSessionId: SessionId): void => {
    const autoUpgradeEpoch = reviewAutoUpgradeEpochRef.current + 1;
    reviewAutoUpgradeEpochRef.current = autoUpgradeEpoch;
    reviewAutoUpgradePendingRef.current = {
      epoch: autoUpgradeEpoch,
      sessionId: targetSessionId,
      resolvedOxford: null
    };
    navigate({
      page: "review",
      sessionId: targetSessionId,
      view: "replay"
    });

    void session.readSessionConfiguration(targetSessionId)
      .then((configuration) => {
        const pending = reviewAutoUpgradePendingRef.current;
        if (
          reviewAutoUpgradeEpochRef.current !== autoUpgradeEpoch
          || pending === null
          || pending.epoch !== autoUpgradeEpoch
          || pending.sessionId !== targetSessionId
        ) {
          return;
        }
        if (configuration.mode !== "OXFORD_MATHEMATICS") {
          reviewAutoUpgradePendingRef.current = null;
          return;
        }

        pending.resolvedOxford = true;
        const currentRoute = routeRef.current;
        if (
          currentRoute.page !== "review"
          || currentRoute.sessionId !== targetSessionId
          || currentRoute.view !== "replay"
        ) {
          return;
        }
        reviewAutoUpgradePendingRef.current = null;
        navigate({
          page: "review",
          sessionId: targetSessionId,
          view: "evaluation"
        }, { replace: true });
      })
      .catch(() => {
        const pending = reviewAutoUpgradePendingRef.current;
        if (pending?.epoch === autoUpgradeEpoch) {
          reviewAutoUpgradePendingRef.current = null;
        }
        // Replay is the conservative fallback for unknown or unreadable mode.
      });
  }, [navigate, session.readSessionConfiguration]);

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
      void session.fetchAvailableSessions();
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
      void session.fetchAvailableSessions();
      if (recoveredStatus === null) return;
      if (recoveredStatus === "ACTIVE") {
        navigate({ page: "interview" });
      } else {
        openDefaultReview(targetSessionId);
      }
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
      void session.fetchAvailableSessions();
      if (recoveredStatus === null) return;
      if (recoveredStatus === "ACTIVE") {
        navigate({ page: "interview" });
      } else {
        openDefaultReview(recoverySessionId);
      }
    } catch {
      // Error handled in session.error
    } finally {
      sessionEntryPendingRef.current = false;
      setSessionEntryPending(false);
    }
  };

  const beginSessionAuthorityCheck = useCallback((): (() => void) => {
    const checkEpoch = sessionAuthorityCheckEpochRef.current + 1;
    sessionAuthorityCheckEpochRef.current = checkEpoch;
    setSessionAuthorityChecking(true);
    setSessionAuthorityUnavailable(false);
    void session.verifyAvailableSessions()
      .then(() => {
        if (sessionAuthorityCheckEpochRef.current === checkEpoch) {
          setSessionAuthorityUnavailable(false);
        }
      })
      .catch(() => {
        if (sessionAuthorityCheckEpochRef.current === checkEpoch) {
          setSessionAuthorityUnavailable(true);
        }
      })
      .finally(() => {
        if (sessionAuthorityCheckEpochRef.current === checkEpoch) {
          setSessionAuthorityChecking(false);
        }
      });
    return () => {
      if (sessionAuthorityCheckEpochRef.current === checkEpoch) {
        sessionAuthorityCheckEpochRef.current += 1;
      }
    };
  }, [session.verifyAvailableSessions]);

  const refreshStoredSessions = useCallback((): (() => void) => {
    const cancelAuthorityCheck = beginSessionAuthorityCheck();
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
        setHistoryError("Session history could not be loaded.");
        setHistoryLoading(false);
      });
    return cancelAuthorityCheck;
  }, [beginSessionAuthorityCheck, session.readSessionHistory]);

  const navigateProductPage = useCallback((page: ProductPageId): void => {
    navigate({ page });
  }, [navigate]);

  useEffect(() => {
    reviewAutoUpgradeEpochRef.current += 1;
    reviewAutoUpgradePendingRef.current = null;
    historyAbortRef.current?.abort();
    historyAbortRef.current = null;
    setHistoryRead(null);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [session.baseUrl]);

  useEffect(() => {
    if (session.isSessionStarted && session.sessionStatus === "ACTIVE") {
      sessionAuthorityCheckEpochRef.current += 1;
      setSessionAuthorityChecking(false);
      setSessionAuthorityUnavailable(false);
      return;
    }
    if (route.page === "sessions") {
      return refreshStoredSessions();
    }
    return beginSessionAuthorityCheck();
  }, [
    beginSessionAuthorityCheck,
    refreshStoredSessions,
    route.page,
    session.isSessionStarted,
    session.sessionStatus
  ]);

  useEffect(() => {
    if (session.isSessionStarted && session.sessionStatus === "ACTIVE") return;
    if (
      route.page !== "home"
      && route.page !== "sessions"
      && route.page !== "review"
    ) {
      return;
    }
    void session.refreshProviderOptions().catch(() => undefined);
  }, [
    route.page,
    session.isSessionStarted,
    session.sessionStatus,
    session.refreshProviderOptions
  ]);

  useEffect(() => {
    return () => {
      sessionAuthorityCheckEpochRef.current += 1;
      historyAbortRef.current?.abort();
      historyAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (
      session.sessionId !== null
      && session.isSessionStarted
      && session.sessionStatus === "ACTIVE"
    ) {
      if (
        session.configuration?.mode === "QUANT_TRADING"
        || session.configuration?.mode === "QUANT_RESEARCH"
      ) {
        writeQuantReattachSessionId(session.sessionId);
      } else if (session.configuration?.mode === "OXFORD_MATHEMATICS") {
        clearQuantReattachSessionId();
      }
      return;
    }
    if (
      session.sessionStatus === "COMPLETED"
      || session.sessionStatus === "ARCHIVED"
    ) {
      clearQuantReattachSessionId();
    }
  }, [
    session.configuration?.mode,
    session.isSessionStarted,
    session.sessionId,
    session.sessionStatus
  ]);

  useEffect(() => {
    if (
      reloadQuantSessionId === null
      || route.page !== "interview"
      || session.isSessionStarted
      || sessionEntryPendingRef.current
      || sessionTerminalPendingRef.current
      || reloadQuantRecoveryAttemptedRef.current
    ) {
      return;
    }

    reloadQuantRecoveryAttemptedRef.current = true;
    sessionEntryPendingRef.current = true;
    setSessionEntryPending(true);
    void session.recoverSession(reloadQuantSessionId)
      .then((status) => {
        void session.fetchAvailableSessions();
        if (status === "ACTIVE") {
          navigate({ page: "interview" }, { replace: true });
          return;
        }
        clearQuantReattachSessionId();
        if (status === "COMPLETED" || status === "ARCHIVED") {
          navigate({
            page: "review",
            sessionId: reloadQuantSessionId,
            view: "replay"
          }, { replace: true });
          return;
        }
        navigate({ page: "home" }, { replace: true });
      })
      .catch(() => {
        clearQuantReattachSessionId();
        navigate({ page: "home" }, { replace: true });
      })
      .finally(() => {
        sessionEntryPendingRef.current = false;
        setSessionEntryPending(false);
      });
  }, [
    navigate,
    reloadQuantSessionId,
    route.page,
    session.isSessionStarted,
    session.recoverSession,
    session.fetchAvailableSessions
  ]);

  const handleWhiteboardEditorMount = useCallback((): void => {
    void session.synchronizeWhiteboard().catch(() => {
      // The sync status remains fail-closed and is surfaced by the session hook.
    });
  }, [session.synchronizeWhiteboard]);

  const hasActiveInterview =
    session.isSessionStarted && session.sessionStatus === "ACTIVE";
  const productSessions = session.availableSessions.filter(
    (storedSession) =>
      !(
        storedSession.status === "ACTIVE"
        && storedSession.sessionId === session.sessionId
        && (
          session.sessionStatus === "COMPLETED"
          || session.sessionStatus === "ARCHIVED"
        )
      )
  );
  const storedActiveSessions = productSessions.filter(
    (storedSession) => storedSession.status === "ACTIVE"
  );
  const storedActiveSession =
    storedActiveSessions.length === 1 ? storedActiveSessions[0] ?? null : null;
  const attachedActiveMissingFromStored =
    hasActiveInterview
    && session.sessionId !== null
    && !storedActiveSessions.some(
      (storedSession) => storedSession.sessionId === session.sessionId
    );
  const knownActiveSessionCount =
    storedActiveSessions.length + (attachedActiveMissingFromStored ? 1 : 0);
  const resumableActiveSessionId =
    hasActiveInterview && session.sessionId !== null
      ? session.sessionId
      : storedActiveSession?.sessionId ?? null;
  const displayRoute = routeForActiveInterview(
    route,
    hasActiveInterview,
    session.isPaused
  );
  const interviewBackgrounded = displayRoute.page !== "interview";
  const activeStoredSession = session.sessionId === null
    ? null
    : session.availableSessions.find(
        (storedSession) => storedSession.sessionId === session.sessionId
      ) ?? null;

  useEffect(() => {
    if (!endConfirmOpen) return;

    if (!hasActiveInterview || interviewBackgrounded || sessionTerminalPending) {
      setEndConfirmOpen(false);
      return;
    }

    const closeFromOutside = (event: PointerEvent): void => {
      const root = endControlRef.current;
      if (
        root === null
        || !(event.target instanceof Node)
        || root.contains(event.target)
      ) {
        return;
      }
      setEndConfirmOpen(false);
    };
    const closeFromEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setEndConfirmOpen(false);
      queueMicrotask(() => endButtonRef.current?.focus());
    };

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    queueMicrotask(() => endCancelRef.current?.focus());

    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [
    endConfirmOpen,
    hasActiveInterview,
    interviewBackgrounded,
    sessionTerminalPending
  ]);

  useEffect(() => {
    setEndConfirmOpen(false);
    setCompactPane("interview");
    setPaneFocus("split");
    setSplitPercent(38);
  }, [session.sessionId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const compact = window.matchMedia("(max-width: 960px)");
    const resetFocusForCompactLayout = (): void => {
      if (compact.matches) setPaneFocus("split");
    };
    resetFocusForCompactLayout();
    compact.addEventListener("change", resetFocusForCompactLayout);
    return () => compact.removeEventListener("change", resetFocusForCompactLayout);
  }, []);

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
        sessions={productSessions}
        activeSessionId={resumableActiveSessionId}
        activeSessionCount={knownActiveSessionCount}
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
        sessionAuthorityChecking={sessionAuthorityChecking}
        sessionAuthorityUnavailable={sessionAuthorityUnavailable}
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
          if (view === "evaluation" && options === undefined) {
            openDefaultReview(sessionId);
            return;
          }
          reviewAutoUpgradeEpochRef.current += 1;
          reviewAutoUpgradePendingRef.current = null;
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
            key={`${session.baseUrl}:${sessionId}`}
            sessionId={sessionId}
            view={view}
            readEvaluation={session.readSessionEvaluation}
            readReplay={session.readSessionReplay}
            readPerformance={session.readSessionPerformance}
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
        <SessionDurationNotice
          durationMinutes={session.configuration.durationMinutes}
          createdAt={activeStoredSession?.createdAt}
          visible={hasActiveInterview && !interviewBackgrounded}
        />
        <QuantSessionWorkspace
          configuration={session.configuration}
          quantState={session.quantState}
          quantStateLoading={session.quantStateLoading}
          quantActionPending={session.quantActionPending}
          connected={session.isConnected}
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
      <SessionDurationNotice
        durationMinutes={session.configuration?.durationMinutes}
        createdAt={activeStoredSession?.createdAt}
        visible={hasActiveInterview && !interviewBackgrounded}
      />
      <div
        aria-hidden={interviewBackgrounded}
        data-backgrounded={String(interviewBackgrounded)}
        className={
          interviewBackgrounded
            ? "interview-app-container interview-app-container--backgrounded flex flex-col h-screen w-screen bg-slate-100 font-sans text-slate-900 overflow-hidden"
            : "interview-app-container flex flex-col h-screen w-screen bg-slate-100 font-sans text-slate-900 overflow-hidden"
        }
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
            <strong>{hasActiveInterview ? activeModeLabel : "Interview"}</strong>
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

          {hasActiveInterview && (
            <span
              className="app-header__board-state"
              data-sync={session.whiteboardSync.status}
            >
              <span aria-hidden="true" />
              {session.whiteboardSync.status === "SYNCED"
                ? "Board synced"
                : session.whiteboardSync.status === "PENDING"
                  ? "Board saving"
                  : session.whiteboardSync.status === "UNSYNCHRONIZED"
                    ? "Board unavailable"
                    : "Board preparing"}
            </span>
          )}

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
              <div
                ref={endControlRef}
                className="live-end-control"
                data-open={String(endConfirmOpen)}
              >
                <button
                  ref={endButtonRef}
                  type="button"
                  onClick={() => setEndConfirmOpen((open) => !open)}
                  disabled={sessionTerminalPending || sessionEntryPending}
                  className="app-header__end"
                  aria-expanded={endConfirmOpen}
                  aria-haspopup="dialog"
                  aria-controls={endConfirmOpen ? "live-end-confirmation" : undefined}
                  aria-label={sessionTerminalPending ? "Ending interview" : "End interview"}
                >
                  {sessionTerminalPending
                    ? "Ending…"
                    : (
                        <>
                          <span className="app-header__end-short">End</span>
                          <span className="app-header__end-long"> interview</span>
                        </>
                      )}
                </button>
                {endConfirmOpen && (
                  <div
                    id="live-end-confirmation"
                    className="live-end-popover"
                    role="dialog"
                    aria-label="Confirm end interview"
                  >
                    <strong>End this interview?</strong>
                    <p>You’ll go straight to the grounded review.</p>
                    <div>
                      <button
                        ref={endCancelRef}
                        type="button"
                        onClick={() => {
                          setEndConfirmOpen(false);
                          queueMicrotask(() => endButtonRef.current?.focus());
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="live-end-popover__confirm"
                        onClick={() => {
                          setEndConfirmOpen(false);
                          void handleCompleteSession();
                        }}
                      >
                        End & review
                      </button>
                    </div>
                  </div>
                )}
              </div>
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
          ref={compactInterviewTabRef}
          id="compact-tab-interview"
          type="button"
          role="tab"
          aria-selected={compactPane === "interview"}
          aria-controls="compact-pane-interview"
          tabIndex={compactPane === "interview" ? 0 : -1}
          onClick={() => {
            setPaneFocus("split");
            setCompactPane("interview");
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "ArrowLeft"
              && event.key !== "ArrowRight"
              && event.key !== "ArrowUp"
              && event.key !== "ArrowDown"
              && event.key !== "End"
            ) return;
            event.preventDefault();
            setPaneFocus("split");
            setCompactPane("whiteboard");
            queueMicrotask(() => compactWhiteboardTabRef.current?.focus());
          }}
        >
          Interview
        </button>
        <button
          ref={compactWhiteboardTabRef}
          id="compact-tab-whiteboard"
          type="button"
          role="tab"
          aria-selected={compactPane === "whiteboard"}
          aria-controls="compact-pane-whiteboard"
          tabIndex={compactPane === "whiteboard" ? 0 : -1}
          onClick={() => {
            setPaneFocus("split");
            setCompactPane("whiteboard");
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "ArrowLeft"
              && event.key !== "ArrowRight"
              && event.key !== "ArrowUp"
              && event.key !== "ArrowDown"
              && event.key !== "Home"
            ) return;
            event.preventDefault();
            setPaneFocus("split");
            setCompactPane("interview");
            queueMicrotask(() => compactInterviewTabRef.current?.focus());
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
        ref={liveWorkspaceRef}
        className="live-main"
        data-compact-pane={compactPane}
        data-focus={paneFocus}
        style={
          paneFocus === "split"
            ? {
                gridTemplateColumns:
                  `minmax(0, ${String(splitPercent)}%) 7px minmax(0, 1fr)`
              }
            : undefined
        }
      >
        <section
          id="compact-pane-interview"
          className="left-panel reasoning-pane"
          aria-labelledby="compact-tab-interview"
        >
          {!session.isSessionStarted && (
            <div className="live-session-entry">
              <div>
                <strong>Ready to begin?</strong>
                <span>Start a configured interview or recover a local session.</span>
              </div>
              <div className="live-session-entry__actions">
                <button
                  type="button"
                  onClick={handleOpenNewInterview}
                  disabled={sessionEntryPending}
                  data-testid="start-session-btn"
                >
                  {sessionEntryPending ? "Opening…" : "New interview"}
                </button>
                <form
                  onSubmit={(event) => {
                    void handleManualRecover(event);
                  }}
                >
                  <input
                    type="text"
                    value={recoverySessionInput}
                    disabled={sessionEntryPending || sessionTerminalPending}
                    onChange={(event) => setRecoverySessionInput(event.target.value)}
                    aria-invalid={recoverySessionInputInvalid}
                    title={recoverySessionInputInvalid ? "Enter a valid session ID" : undefined}
                    placeholder="session_..."
                  />
                  <button
                    type="submit"
                    disabled={
                      sessionEntryPending
                      || sessionTerminalPending
                      || recoverySessionId === null
                    }
                  >
                    {sessionEntryPending ? "Opening…" : "Recover"}
                  </button>
                </form>
              </div>
            </div>
          )}

          <div className="problem-block">
            <div className="live-problem-meta">
              <span>Problem</span>
              <b>Oxford Mathematics</b>
            </div>
            <ProblemCard problem={session.problem} />
          </div>

          <div className="live-transcript-region">
            <TranscriptFeed
              items={session.transcript}
              onRetry={(itemId) => {
                if (
                  sessionEntryPendingRef.current
                  || sessionTerminalPendingRef.current
                ) return;
                void session.retrySubmission(itemId).catch(() => undefined);
              }}
              retryDisabled={sessionEntryPending || sessionTerminalPending}
              scrollContextKey={session.sessionId}
              focused={paneFocus === "transcript"}
              onToggleFocus={() => {
                setCompactPane("interview");
                setPaneFocus((focus) =>
                  focus === "transcript" ? "split" : "transcript"
                );
              }}
              className="h-full"
            />
          </div>

          <div className="input-dock">
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
              compact
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
                    ? "Type the next step in your reasoning…"
                    : "Start or recover a session above to submit reasoning."
              }
            />
          </div>
        </section>

        <div
          className="split-divider"
          role="separator"
          aria-label="Resize transcript and whiteboard"
          aria-orientation="vertical"
          aria-valuemin={26}
          aria-valuemax={68}
          aria-valuenow={Math.round(splitPercent)}
          tabIndex={0}
          onKeyDown={(event) => {
            if (
              event.key !== "ArrowLeft"
              && event.key !== "ArrowRight"
              && event.key !== "Home"
              && event.key !== "End"
            ) return;
            event.preventDefault();
            setPaneFocus("split");
            if (event.key === "Home") {
              setSplitPercent(26);
              return;
            }
            if (event.key === "End") {
              setSplitPercent(68);
              return;
            }
            setSplitPercent((current) =>
              Math.min(68, Math.max(26, current + (event.key === "ArrowRight" ? 2 : -2)))
            );
          }}
          onDoubleClick={() => {
            setPaneFocus("split");
            setSplitPercent(38);
          }}
          onPointerDown={(event) => {
            if (event.pointerType === "mouse" && event.button !== 0) return;
            setPaneFocus("split");
            event.currentTarget.setPointerCapture(event.pointerId);
            setSplitFromClientX(event.clientX);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            setSplitFromClientX(event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
        >
          <span aria-hidden="true" />
        </div>

        <section
          id="compact-pane-whiteboard"
          className="right-panel board-pane"
          aria-labelledby="compact-tab-whiteboard"
        >
          <div className="board-appbar">
            <div className="board-appbar__left">
              <strong data-testid="tab-whiteboard">Whiteboard</strong>
              <span className="board-sync">
                <i data-sync={session.whiteboardSync.status} aria-hidden="true" />
                {session.whiteboardSync.status === "SYNCED"
                  ? "Synced"
                  : session.whiteboardSync.status === "PENDING"
                    ? "Saving…"
                    : session.whiteboardSync.status === "UNSYNCHRONIZED"
                      ? "Needs reconnect"
                      : "Preparing…"}
              </span>
            </div>
            <div className="board-appbar__actions">
              {session.whiteboardSync.status === "UNSYNCHRONIZED" && (
                <button
                  type="button"
                  className="board-appbar__reconnect-action"
                  onClick={() => {
                    void session.synchronizeWhiteboard().catch(() => undefined);
                  }}
                >
                  Reconnect board
                </button>
              )}
              <button
                type="button"
                className="board-appbar__layout-action"
                aria-pressed={paneFocus === "whiteboard"}
                onClick={() => {
                  setCompactPane("whiteboard");
                  setPaneFocus((focus) =>
                    focus === "whiteboard" ? "split" : "whiteboard"
                  );
                }}
              >
                {paneFocus === "whiteboard" ? "Restore split" : "Focus whiteboard"}
              </button>
              <button
                type="button"
                className="board-appbar__clear-action"
                disabled={session.whiteboardSync.status === "UNINITIALIZED"}
                onClick={() => {
                  void whiteboardAdapter.clearAiOverlay().catch(() => undefined);
                }}
              >
                Clear AI marks
              </button>
            </div>
          </div>

          <div className="tldraw-wrap">
            <div className="whiteboard-wrapper tldraw-frame">
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
        </section>
      </main>
      </div>
    </>
  );
};
