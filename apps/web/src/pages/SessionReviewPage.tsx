import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SessionId } from "../../../../packages/domain/src/index.js";
import type {
  GroundedReadFailureReason,
  SessionEvaluationReadResponse,
  SessionReplayReadResponse
} from "../../../../packages/replay/src/index.js";
import {
  EvaluationPanel,
  ReplayPanel,
  type SessionReviewTab
} from "../components/SessionReviewModal.js";
import styles from "./SessionReviewPage.module.css";

export interface SessionReviewPageProps {
  readonly sessionId: SessionId;
  readonly initialTab?: SessionReviewTab;
  readonly readEvaluation: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionEvaluationReadResponse>;
  readonly readReplay: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionReplayReadResponse>;
  readonly onBack: () => void;
  readonly onTabChange?: ((tab: SessionReviewTab) => void) | undefined;
}

function failureMessage(reason: GroundedReadFailureReason): string {
  switch (reason) {
    case "SESSION_NOT_TERMINAL":
      return "Grounded evaluation is available after the session is completed or archived.";
    case "EXACT_PROBLEM_UNAVAILABLE":
      return "The exact session-bound problem definition cannot be reconstructed safely.";
    case "AUTHORITATIVE_HISTORY_UNAVAILABLE":
      return "The authoritative event history could not be reconstructed safely.";
    case "READ_LIMIT_EXCEEDED":
      return "This session exceeds the bounded product read limit.";
    case "EVALUATION_UNAVAILABLE":
      return "The grounded evaluator rejected the available authoritative context.";
    case "REPLAY_UNAVAILABLE":
      return "The replay projection rejected this history rather than guessing.";
  }
}

export const SessionReviewPage: React.FC<SessionReviewPageProps> = ({
  sessionId,
  initialTab = "evaluation",
  readEvaluation,
  readReplay,
  onBack,
  onTabChange
}) => {
  const [activeTab, setActiveTab] = useState<SessionReviewTab>(initialTab);
  const [evaluation, setEvaluation] =
    useState<SessionEvaluationReadResponse | null>(null);
  const [replay, setReplay] =
    useState<SessionReplayReadResponse | null>(null);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);
  const evaluationTabRef = useRef<HTMLButtonElement | null>(null);
  const replayTabRef = useRef<HTMLButtonElement | null>(null);

  const selectTab = useCallback((tab: SessionReviewTab): void => {
    setActiveTab(tab);
    onTabChange?.(tab);
  }, [onTabChange]);

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next: SessionReviewTab =
        event.currentTarget.id === "review-tab-evaluation"
          ? "replay"
          : "evaluation";
      selectTab(next);
      queueMicrotask(() => {
        if (next === "evaluation") {
          evaluationTabRef.current?.focus();
        } else {
          replayTabRef.current?.focus();
        }
      });
    },
    [selectTab]
  );

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, sessionId]);

  useEffect(() => {
    setEvaluation(null);
    setReplay(null);
    setEvaluationError(null);
    setReplayError(null);
  }, [sessionId]);

  useEffect(() => {
    if (
      activeTab !== "evaluation"
      || evaluation !== null
      || evaluationError !== null
    ) {
      return;
    }

    const controller = new AbortController();
    setEvaluationLoading(true);
    void readEvaluation(sessionId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setEvaluation(response);
        setEvaluationLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setEvaluationError("The bounded evaluation read could not be loaded.");
        setEvaluationLoading(false);
      });

    return () => controller.abort();
  }, [
    activeTab,
    evaluation,
    evaluationError,
    readEvaluation,
    sessionId
  ]);

  useEffect(() => {
    if (
      activeTab !== "replay"
      || replay !== null
      || replayError !== null
    ) {
      return;
    }

    const controller = new AbortController();
    setReplayLoading(true);
    void readReplay(sessionId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setReplay(response);
        setReplayLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setReplayError("The bounded replay read could not be loaded.");
        setReplayLoading(false);
      });

    return () => controller.abort();
  }, [activeTab, readReplay, replay, replayError, sessionId]);

  return (
    <div className={styles.review ?? ""}>
      <div className={styles.reviewHeader}>
        <button type="button" onClick={onBack} className={styles.backButton}>
          Back to sessions
        </button>
        <code>{sessionId}</code>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="Session review views">
        <button
          ref={evaluationTabRef}
          id="review-tab-evaluation"
          type="button"
          role="tab"
          aria-selected={activeTab === "evaluation"}
          aria-controls="review-tab-panel"
          tabIndex={activeTab === "evaluation" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          className={
            activeTab === "evaluation"
              ? (styles.tabActive ?? "")
              : (styles.tab ?? "")
          }
          onClick={() => selectTab("evaluation")}
        >
          Evaluation
        </button>
        <button
          ref={replayTabRef}
          id="review-tab-replay"
          type="button"
          role="tab"
          aria-selected={activeTab === "replay"}
          aria-controls="review-tab-panel"
          tabIndex={activeTab === "replay" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          className={
            activeTab === "replay"
              ? (styles.tabActive ?? "")
              : (styles.tab ?? "")
          }
          onClick={() => selectTab("replay")}
        >
          Replay
        </button>
      </div>

      <div
        id="review-tab-panel"
        className={styles.content}
        role="tabpanel"
        aria-labelledby={
          activeTab === "evaluation"
            ? "review-tab-evaluation"
            : "review-tab-replay"
        }
      >
        {activeTab === "evaluation" ? (
          evaluationLoading ? (
            <div className={styles.state} role="status" aria-live="polite">Loading bounded evaluation…</div>
          ) : evaluationError !== null ? (
            <div className={styles.error}>{evaluationError}</div>
          ) : evaluation?.available === true ? (
            <EvaluationPanel evaluation={evaluation.evaluation} />
          ) : evaluation?.available === false ? (
            <div className={styles.unavailable}>
              <h2>Evaluation unavailable</h2>
              <p>{failureMessage(evaluation.reason)}</p>
            </div>
          ) : null
        ) : replayLoading ? (
          <div className={styles.state} role="status" aria-live="polite">Loading bounded replay…</div>
        ) : replayError !== null ? (
          <div className={styles.error}>{replayError}</div>
        ) : replay?.available === true ? (
          <ReplayPanel response={replay} />
        ) : replay?.available === false ? (
          <div className={styles.unavailable}>
            <h2>Replay unavailable</h2>
            <p>{failureMessage(replay.reason)}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
};
