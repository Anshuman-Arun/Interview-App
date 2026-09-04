import { useEffect, useState, type ReactNode } from "react";
import type { SessionId } from "../../../../packages/domain/src/index.js";
import type { SessionPerformanceReadResponse } from "../../../../packages/diagnostics/src/index.js";
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
  readReplay,
  readPerformance
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
  readonly readPerformance: (
    sessionId: SessionId,
    signal?: AbortSignal
  ) => Promise<SessionPerformanceReadResponse>;
}) {
  const [evaluation, setEvaluation] =
    useState<SessionEvaluationReadResponse | null>(null);
  const [replay, setReplay] =
    useState<SessionReplayReadResponse | null>(null);
  const [performance, setPerformance] =
    useState<SessionPerformanceReadResponse | null>(null);
  const [performanceError, setPerformanceError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setEvaluation(null);
    setReplay(null);
    setPerformance(null);
    setPerformanceError(false);
    setError(null);
  }, [sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    setPerformanceError(false);
    void readPerformance(sessionId, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setPerformance(response);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPerformanceError(true);
      });
    return () => controller.abort();
  }, [readPerformance, sessionId]);

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
            ? "The bounded evaluation read could not be loaded."
            : "The bounded replay read could not be loaded."
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
            ? "Loading bounded evaluation…"
            : "Loading bounded replay…"}
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

  let primary: ReactNode;
  if (view === "evaluation") {
    if (evaluation === null) return null;
    primary = !evaluation.available
      ? (
          <div className="review-read-state" data-testid="evaluation-unavailable">
            <span>NOT SCORED</span>
            <p>{failureMessage(evaluation.reason)}</p>
          </div>
        )
      : <EvaluationPanel evaluation={evaluation.evaluation} />;
  } else {
    if (replay === null) return null;
    primary = !replay.available
      ? (
          <div className="review-read-state" data-testid="replay-unavailable">
            <span>UNAVAILABLE</span>
            <p>{failureMessage(replay.reason)}</p>
          </div>
        )
      : <ReplayPanel response={replay} />;
  }

  return (
    <>
      {primary}
      <PerformancePanel
        response={performance}
        readFailed={performanceError}
      />
    </>
  );
}

function PerformancePanel({
  response,
  readFailed
}: {
  readonly response: SessionPerformanceReadResponse | null;
  readonly readFailed: boolean;
}) {
  if (readFailed) {
    return (
      <section className="session-performance-card" data-testid="session-performance-partial">
        <div className="session-performance-card__heading">
          <div>
            <span>USAGE & LATENCY</span>
            <h3>Performance</h3>
          </div>
          <small>Partial metrics available</small>
        </div>
        <p className="session-performance-card__note">
          Observability data could not be read. Interview Review remains available because metrics are non-authoritative.
        </p>
      </section>
    );
  }
  if (response === null) return null;
  if (!response.available || response.summary === undefined) {
    return (
      <section className="session-performance-card" data-testid="session-performance-unavailable">
        <div className="session-performance-card__heading">
          <div>
            <span>USAGE & LATENCY</span>
            <h3>Performance</h3>
          </div>
          {response.partial ? <small>Partial metrics available</small> : null}
        </div>
        <p className="session-performance-card__note">
          No measured performance data is available for this session.
        </p>
      </section>
    );
  }

  const summary = response.summary;
  const failures =
    summary.remote.outcomes.TIMEOUT
    + summary.remote.outcomes.CANCELLED
    + summary.remote.outcomes.POLICY_DENIED
    + summary.remote.outcomes.PROVIDER_UNAVAILABLE
    + summary.remote.outcomes.MALFORMED
    + summary.remote.outcomes.FAILED;

  return (
    <section className="session-performance-card" data-testid="session-performance">
      <div className="session-performance-card__heading">
        <div>
          <span>USAGE & LATENCY</span>
          <h3>Performance</h3>
        </div>
        <small>{summary.partial ? "Partial metrics available" : "Measured by Interview App"}</small>
      </div>

      <div className="session-performance-grid">
        <MetricGroup title="Remote AI">
          <Metric label="Interviewer calls" value={summary.remote.interviewerCalls} />
          <Metric label="Formal interpretation" value={summary.remote.formalInterpretationCalls} />
          <Metric label="Total remote calls" value={summary.remote.totalCalls} />
          <Metric
            label="Interviewer median"
            value={formatLatency(summary.remote.interviewerLatency.medianMs)}
          />
          <Metric
            label="Interviewer slowest"
            value={formatLatency(summary.remote.interviewerLatency.slowestMs)}
          />
          <Metric
            label="Formal median"
            value={formatLatency(summary.remote.formalInterpretationLatency.medianMs)}
          />
        </MetricGroup>

        <MetricGroup title="Formal interpretation">
          <Metric label="Attempts" value={summary.formalInterpretation.attempts} />
          <Metric label="Accepted" value={summary.formalInterpretation.accepted} />
          <Metric label="Abstained" value={summary.formalInterpretation.abstentions} />
          <Metric label="Timed out" value={summary.formalInterpretation.timeouts} />
          <Metric label="Cancelled" value={summary.formalInterpretation.cancelled} />
          <Metric label="Failed / malformed" value={summary.formalInterpretation.failedOrMalformed} />
        </MetricGroup>

        <MetricGroup title="Local compute">
          <Metric label="STT finalizations" value={summary.local.stt.finalizations} />
          <Metric label="TTS syntheses" value={summary.local.tts.successes} />
          <Metric label="Vision inferences" value={summary.local.vision.inferenceCompletions} />
          <Metric label="TTS barge-in interrupts" value={summary.local.tts.bargeInInterruptions} />
          <Metric label="Stale vision rejected" value={summary.local.vision.staleRejections} />
          <Metric label="Remote issues" value={failures} />
        </MetricGroup>

        <MetricGroup title="Application-measured size">
          <Metric label="Provider request bytes" value={formatBytes(summary.remote.requestBytes)} />
          <Metric label="Compiled context bytes" value={formatBytes(summary.remote.compiledContextBytes)} />
          <Metric label="Structured response bytes" value={formatBytes(summary.remote.responseBytes)} />
          <Metric label="Candidate substantive turns" value={summary.candidateSubstantiveTurns} />
        </MetricGroup>
      </div>

      <p className="session-performance-card__note">
        These are application measurements, not provider billing data. Antigravity/Gemini token use, subscription quota consumption, and billing impact are not shown because the current provider interface does not expose authoritative values.
      </p>
    </section>
  );
}

function MetricGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="session-performance-group">
      <h4>{title}</h4>
      <dl>{children}</dl>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatLatency(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000
    ? `${(value / 1000).toFixed(2)} s`
    : `${Math.round(value)} ms`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
