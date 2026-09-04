import { useEffect, useState } from "react";
import type { SessionId } from "../../../../packages/domain/src/index.js";
import type {
  SessionEvaluationReadResponse,
  SessionReplayReadResponse
} from "../../../../packages/replay/src/index.js";
import {
  EvaluationPanel,
  ReplayPanel,
  failureMessage
} from "../components/SessionReviewModal.js";
import type { ReviewView } from "./ReviewPageShell.js";
import "./ReviewReadPanel.css";

export function ReviewReadPanel({
  sessionId,
  view,
  readEvaluation,
  readReplay
}: {
  readonly sessionId: SessionId;
  readonly view: ReviewView;
  readonly readEvaluation: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionEvaluationReadResponse>;
  readonly readReplay: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionReplayReadResponse>;
}) {
  const [evaluation, setEvaluation] =
    useState<SessionEvaluationReadResponse | null>(null);
  const [replay, setReplay] =
    useState<SessionReplayReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setEvaluation(null);
    setReplay(null);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    if (view === "evaluation" && evaluation !== null) {
      setLoading(false);
      return;
    }
    if (view === "replay" && replay !== null) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setError(null);
    setLoading(true);

    const pending = view === "evaluation"
      ? readEvaluation(sessionId, controller.signal)
          .then((response) => {
            if (controller.signal.aborted) return;
            setEvaluation(response);
          })
      : readReplay(sessionId, controller.signal)
          .then((response) => {
            if (controller.signal.aborted) return;
            setReplay(response);
          });

    void pending
      .then(() => {
        if (!controller.signal.aborted) setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setError(
          view === "evaluation"
            ? "The evaluation could not be loaded."
            : "The replay could not be loaded."
        );
        setLoading(false);
      });

    return () => controller.abort();
  }, [
    evaluation,
    readEvaluation,
    readReplay,
    replay,
    sessionId,
    view
  ]);

  if (loading) {
    return (
      <div className="review-read-state" role="status">
        <span>READING</span>
        <p>
          {view === "evaluation"
            ? "Loading evaluation…"
            : "Loading replay…"}
        </p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="review-read-state review-read-state--error" role="status">
        <span>READ ERROR</span>
        <p>{error}</p>
      </div>
    );
  }

  if (view === "evaluation") {
    if (evaluation === null) return null;
    if (!evaluation.available) {
      return (
        <div className="review-read-state" data-testid="evaluation-unavailable">
          <span>NOT SCORED</span>
          <p>{failureMessage(evaluation.reason)}</p>
        </div>
      );
    }
    return <EvaluationPanel evaluation={evaluation.evaluation} />;
  }

  if (replay === null) return null;
  if (!replay.available) {
    return (
      <div className="review-read-state" data-testid="replay-unavailable">
        <span>UNAVAILABLE</span>
        <p>{failureMessage(replay.reason)}</p>
      </div>
    );
  }
  return <ReplayPanel response={replay} />;
}
