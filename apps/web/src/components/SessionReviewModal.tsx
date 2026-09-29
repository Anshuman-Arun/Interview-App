import React, { useEffect, useMemo, useState } from "react";
import type { SessionId } from "../../../../packages/domain/src/index.js";
import type {
  GroundedEvaluationReadModel,
  GroundedReadFailureReason,
  ReplayReadCategory,
  SessionEvaluationReadResponse,
  SessionReplayReadResponse
} from "../../../../packages/replay/src/index.js";

export type SessionReviewTab = "evaluation" | "replay";

export interface SessionReviewModalProps {
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
  readonly onClose: () => void;
}

const DIMENSION_LABELS = {
  technicalCorrectness: "Technical Correctness",
  rigor: "Rigor",
  independence: "Independence",
  communication: "Communication",
  hintResponsiveness: "Hint Responsiveness",
  errorRecovery: "Error Recovery"
} as const;

const REPLAY_FILTERS: readonly {
  readonly value: "ALL" | ReplayReadCategory;
  readonly label: string;
}[] = [
  { value: "ALL", label: "All" },
  { value: "STUDENT", label: "Student" },
  { value: "INTERVIEWER_DELIVERY", label: "Interviewer" },
  { value: "WHITEBOARD", label: "Whiteboard" },
  { value: "VERIFICATION", label: "Verification" },
  { value: "EVIDENCE", label: "Evidence" },
  { value: "LIFECYCLE", label: "Lifecycle" },
  { value: "RECOVERY", label: "Recovery" }
];

export function failureMessage(reason: GroundedReadFailureReason): string {
  switch (reason) {
    case "SESSION_NOT_TERMINAL":
      return "Evaluation is available after the session is completed or archived.";
    case "EXACT_PROBLEM_UNAVAILABLE":
      return "The original interview problem is no longer available for a safe review.";
    case "AUTHORITATIVE_HISTORY_UNAVAILABLE":
      return "The saved session history could not be reconstructed safely.";
    case "READ_LIMIT_EXCEEDED":
      return "This session is too large to display in full here.";
    case "EVALUATION_UNAVAILABLE":
      return "An evaluation could not be produced safely from the saved session.";
    case "REPLAY_UNAVAILABLE":
      return "The replay could not be reconstructed safely from the saved session.";
  }
}

function scoreLabel(score: number | null): string {
  return score === null ? "Not scored" : String(score);
}

function SupportBadge({
  support
}: {
  readonly support: "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
}) {
  const className = support === "STRONG"
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : support === "MODERATE"
      ? "bg-blue-50 text-blue-700 border-blue-200"
      : support === "WEAK"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full border text-[10px] font-semibold ${className}`}>
      {support}
    </span>
  );
}

export function EvaluationPanel({
  evaluation
}: {
  readonly evaluation: GroundedEvaluationReadModel;
}) {
  return (
    <div className="space-y-5" data-testid="grounded-evaluation-panel">
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-[11px] text-slate-500 font-semibold">Overall</p>
            <span className="text-3xl font-bold text-slate-900">
              {scoreLabel(evaluation.composite.score)}
            </span>
          </div>
          <SupportBadge support={evaluation.composite.supportLevel} />
        </div>
        <p className="mt-3 text-sm text-slate-700">{evaluation.summaryAssessment}</p>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-bold text-slate-900">Breakdown</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {evaluation.dimensions.map((dimension) => (
            <article
              key={dimension.name}
              className="rounded-lg border border-slate-200 bg-white p-3"
              data-testid={`evaluation-dimension-${dimension.name}`}
            >
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-xs font-semibold text-slate-900">
                  {DIMENSION_LABELS[dimension.name]}
                </h4>
                <span className={
                  dimension.score === null
                    ? "text-sm font-bold text-slate-500"
                    : "text-sm font-bold text-indigo-700"
                }>
                  {scoreLabel(dimension.score)}
                </span>
              </div>
              {dimension.notScoredReason !== undefined ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  {dimension.notScoredReason}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      {(evaluation.keyStrengths.length > 0 || evaluation.areasForImprovement.length > 0) ? (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-xs font-bold text-slate-900">What worked</h3>
            <ul className="mt-2 space-y-1 text-[11px] text-slate-700">
              {evaluation.keyStrengths.map((strength) => (
                <li key={strength}>• {strength}</li>
              ))}
              {evaluation.keyStrengths.length === 0 ? (
                <li className="text-slate-500">No supported strengths were recorded.</li>
              ) : null}
            </ul>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-xs font-bold text-slate-900">Next time</h3>
            <ul className="mt-2 space-y-1 text-[11px] text-slate-700">
              {evaluation.areasForImprovement.map((area) => (
                <li key={area}>• {area}</li>
              ))}
              {evaluation.areasForImprovement.length === 0 ? (
                <li className="text-slate-500">No supported improvement areas were recorded.</li>
              ) : null}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-200 pt-3 text-[11px] text-slate-500">
        <span>
          Milestones: {evaluation.milestoneSummary.achieved}/{evaluation.milestoneSummary.total}
        </span>
        <span>
          Unassisted: {evaluation.milestoneSummary.unassisted}
        </span>
        {evaluation.disclosedInterventions.length > 0 ? (
          <span>Assistance used: {evaluation.disclosedInterventions.length}</span>
        ) : null}
      </section>
    </div>
  );
}

export function ReplayPanel({
  response
}: {
  readonly response: Extract<SessionReplayReadResponse, { available: true }>;
}) {
  const [filter, setFilter] = useState<"ALL" | ReplayReadCategory>("ALL");
  const entries = useMemo(
    () => filter === "ALL"
      ? response.replay.entries
      : response.replay.entries.filter((entry) => entry.category === filter),
    [filter, response.replay.entries]
  );

  return (
    <div className="space-y-4" data-testid="session-replay-panel">
      {(!response.replay.complete || !response.replay.currentStateAvailable) ? (
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-[11px] text-slate-600">
            This replay is incomplete, so later state is intentionally not inferred.
          </p>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-1" role="group" aria-label="Replay category filter">
        {REPLAY_FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setFilter(item.value)}
            className={`px-2.5 py-1 rounded-md border text-[11px] font-semibold ${
              filter === item.value
                ? "bg-indigo-50 border-indigo-200 text-indigo-700"
                : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">
            Nothing in this view.
          </p>
        ) : (
          entries.map((entry) => (
            <article
              key={entry.eventId}
              className="rounded-lg border border-slate-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                    {entry.category}
                  </span>
                  <span className="text-xs font-semibold text-slate-900">
                    {entry.summary}
                  </span>
                </div>
                <time className="shrink-0 text-[10px] text-slate-400">
                  {new Date(entry.occurredAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </time>
              </div>

              {entry.text !== undefined ? (
                <div className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-800">
                  {entry.text.text}
                  {entry.text.truncated ? <span className="text-slate-400"> …</span> : null}
                </div>
              ) : null}

              {entry.delivery?.contentWithheld ? (
                <p className="mt-2 text-[11px] font-semibold text-amber-800">
                  Content with uncertain delivery status is omitted from replay.
                </p>
              ) : null}

              {entry.delivery?.boardAction !== undefined ? (
                <div className="mt-2 text-[11px] text-slate-600">
                  <span className="font-semibold">
                    Whiteboard {entry.delivery.boardAction.operation}
                  </span>
                  {entry.delivery.boardAction.content !== undefined ? (
                    <p className="mt-1 whitespace-pre-wrap">
                      {entry.delivery.boardAction.content.text}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {entry.verification?.resultStatus !== undefined ? (
                <p className="mt-2 text-[11px] text-slate-600">
                  Verification: <strong>{entry.verification.resultStatus}</strong>
                </p>
              ) : null}

              {entry.evidence !== undefined && entry.evidence.value !== undefined ? (
                <p className="mt-2 text-[11px] text-slate-600">
                  Evidence: {entry.evidence.value}
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

export const SessionReviewModal: React.FC<SessionReviewModalProps> = ({
  sessionId,
  initialTab = "evaluation",
  readEvaluation,
  readReplay,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<SessionReviewTab>(initialTab);
  const [evaluationResponse, setEvaluationResponse] =
    useState<SessionEvaluationReadResponse | null>(null);
  const [replayResponse, setReplayResponse] =
    useState<SessionReplayReadResponse | null>(null);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [replayLoading, setReplayLoading] = useState(false);

  useEffect(() => {
    setActiveTab(initialTab);
    setEvaluationResponse(null);
    setReplayResponse(null);
    setEvaluationError(null);
    setReplayError(null);
    setEvaluationLoading(false);
    setReplayLoading(false);
  }, [initialTab, sessionId]);

  useEffect(() => {
    if (
      activeTab !== "evaluation"
      || evaluationResponse !== null
      || evaluationError !== null
    ) {
      return;
    }
    const controller = new AbortController();
    setEvaluationLoading(true);
    void readEvaluation(sessionId, controller.signal)
      .then((evaluation) => {
        if (controller.signal.aborted) return;
        setEvaluationResponse(evaluation);
        setEvaluationLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setEvaluationError("The evaluation could not be loaded.");
        setEvaluationLoading(false);
      });
    return () => controller.abort();
  }, [
    activeTab,
    evaluationError,
    evaluationResponse,
    readEvaluation,
    sessionId
  ]);

  useEffect(() => {
    if (
      activeTab !== "replay"
      || replayResponse !== null
      || replayError !== null
    ) {
      return;
    }
    const controller = new AbortController();
    setReplayLoading(true);
    void readReplay(sessionId, controller.signal)
      .then((replay) => {
        if (controller.signal.aborted) return;
        setReplayResponse(replay);
        setReplayLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setReplayError("The replay could not be loaded.");
        setReplayLoading(false);
      });
    return () => controller.abort();
  }, [activeTab, readReplay, replayError, replayResponse, sessionId]);

  const evaluationAvailable =
    evaluationResponse?.available === true ? evaluationResponse.evaluation : null;
  const replayAvailable =
    replayResponse?.available === true ? replayResponse : null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-review-title"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <h2 id="session-review-title" className="text-base font-bold text-slate-900">
            Session Review
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm font-bold text-slate-500 hover:bg-slate-200 hover:text-slate-800"
            aria-label="Close session review"
          >
            ✕
          </button>
        </header>

        <div
          className="flex items-center gap-2 border-b border-slate-200 bg-white px-5 py-2"
          role="tablist"
          aria-label="Session review views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "evaluation"}
            onClick={() => setActiveTab("evaluation")}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              activeTab === "evaluation"
                ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            Evaluation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "replay"}
            onClick={() => setActiveTab("replay")}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              activeTab === "replay"
                ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            Replay timeline
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === "evaluation" ? (
            evaluationLoading ? (
              <p className="py-12 text-center text-sm text-slate-500">
                Loading evaluation…
              </p>
            ) : evaluationError !== null ? (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
                {evaluationError}
              </div>
            ) : evaluationAvailable !== null ? (
              <EvaluationPanel evaluation={evaluationAvailable} />
            ) : evaluationResponse?.available === false ? (
              <div
                className="rounded-lg border border-slate-200 bg-slate-50 p-4"
                data-testid="evaluation-unavailable"
              >
                <h3 className="text-sm font-bold text-slate-900">Evaluation not scored here</h3>
                <p className="mt-2 text-xs text-slate-600">
                  {failureMessage(evaluationResponse.reason)}
                </p>
              </div>
            ) : null
          ) : replayLoading ? (
            <p className="py-12 text-center text-sm text-slate-500">
              Loading replay…
            </p>
          ) : replayError !== null ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {replayError}
            </div>
          ) : replayAvailable !== null ? (
            <ReplayPanel response={replayAvailable} />
          ) : replayResponse?.available === false ? (
            <div
              className="rounded-lg border border-slate-200 bg-slate-50 p-4"
              data-testid="replay-unavailable"
            >
              <h3 className="text-sm font-bold text-slate-900">Replay unavailable</h3>
              <p className="mt-2 text-xs text-slate-600">
                {failureMessage(replayResponse.reason)}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
