import React, { useEffect, useMemo, useState } from "react";
import type {
  EvidenceKey,
  SessionId
} from "../../../../packages/domain/src/index.js";
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

function evidenceSubjectLabel(key: EvidenceKey): string {
  const subject = key.subject;
  const id = subject.kind === "CLAIM"
    ? subject.claimId
    : subject.kind === "MILESTONE"
      ? subject.milestoneId
      : subject.kind === "SKILL"
        ? subject.skillId
        : subject.approachId;
  return `${key.dimension} · ${subject.kind} · ${id}`;
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
              Grounded composite
            </p>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-slate-900">
                {scoreLabel(evaluation.composite.score)}
              </span>
              <span className="text-xs text-slate-500">{evaluation.composite.status}</span>
            </div>
          </div>
          <SupportBadge support={evaluation.composite.supportLevel} />
        </div>
        <p className="mt-3 text-sm text-slate-700">{evaluation.summaryAssessment}</p>
        {evaluation.composite.omittedDimensions.length > 0 ? (
          <p className="mt-2 text-[11px] text-slate-500">
            Unsupported weighted dimensions omitted from the composite:{" "}
            {evaluation.composite.omittedDimensions
              .map((name) => DIMENSION_LABELS[name])
              .join(", ")}.
          </p>
        ) : null}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-slate-900">Evaluation dimensions</h3>
          <span className="text-[11px] text-slate-500">
            Score and support are separate signals
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {evaluation.dimensions.map((dimension) => (
            <article
              key={dimension.name}
              className="rounded-lg border border-slate-200 bg-white p-3"
              data-testid={`evaluation-dimension-${dimension.name}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-xs font-semibold text-slate-900">
                    {DIMENSION_LABELS[dimension.name]}
                  </h4>
                  <p
                    className={`mt-1 text-xl font-bold ${
                      dimension.score === null ? "text-slate-500" : "text-indigo-700"
                    }`}
                  >
                    {scoreLabel(dimension.score)}
                  </p>
                </div>
                <SupportBadge support={dimension.supportLevel} />
              </div>

              {dimension.notScoredReason !== undefined ? (
                <p className="mt-2 rounded bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">
                  {dimension.notScoredReason}
                </p>
              ) : null}

              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] font-semibold text-indigo-700">
                  Why? Evidence
                </summary>
                <div className="mt-2 space-y-1.5">
                  {dimension.evidenceRefs.length === 0 ? (
                    <p className="text-[11px] text-slate-500">
                      No grounded evidence references are available for this dimension.
                    </p>
                  ) : (
                    dimension.evidenceRefs.map((ref) => (
                      <div
                        key={`${ref.kind}:${ref.id}`}
                        className="rounded bg-slate-50 px-2 py-1 font-mono text-[10px] text-slate-600 break-all"
                      >
                        {ref.kind}: {ref.id}
                      </div>
                    ))
                  )}
                  {dimension.evidenceRefTruncation.truncated ? (
                    <p className="text-[10px] text-slate-500">
                      +{dimension.evidenceRefTruncation.remainingCount} additional references withheld by the display bound.
                    </p>
                  ) : null}
                </div>
              </details>
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-slate-900">Milestones</h3>
          <span className="text-xs text-slate-600">
            {evaluation.milestoneSummary.achieved}/{evaluation.milestoneSummary.total} achieved ·{" "}
            {evaluation.milestoneSummary.unassisted} unassisted ·{" "}
            {evaluation.milestoneSummary.assisted} assisted
          </span>
        </div>
        <div className="space-y-2">
          {evaluation.milestones.map((milestone) => (
            <details
              key={milestone.milestoneId}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-indigo-700">
                      {milestone.milestoneId}
                    </span>
                    <span className={`text-[10px] font-semibold ${
                      milestone.achieved ? "text-emerald-700" : "text-slate-500"
                    }`}>
                      {milestone.achieved ? "ACHIEVED" : "NOT ESTABLISHED"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">
                      Assistance level {milestone.assistanceLevel}
                    </span>
                    <SupportBadge support={milestone.supportLevel} />
                  </div>
                </div>
              </summary>
              <div className="mt-2 border-t border-slate-100 pt-2 space-y-1.5">
                {milestone.achievedAtTurnId !== undefined ? (
                  <p className="text-[11px] text-slate-600">
                    Established at turn <span className="font-mono">{milestone.achievedAtTurnId}</span>
                  </p>
                ) : null}
                <p className="text-[11px] text-slate-600">
                  Disclosure associations: {milestone.assistanceDisclosureCount}
                </p>
                {milestone.evidenceRefs.map((ref) => (
                  <div
                    key={`${ref.kind}:${ref.id}`}
                    className="font-mono text-[10px] text-slate-500 break-all"
                  >
                    {ref.kind}: {ref.id}
                  </div>
                ))}
                {milestone.evidenceRefTruncation.truncated ? (
                  <p className="text-[10px] text-slate-500">
                    +{milestone.evidenceRefTruncation.remainingCount} additional milestone evidence reference(s) are outside the bounded display.
                  </p>
                ) : null}
              </div>
            </details>
          ))}
          {evaluation.milestoneTruncation.truncated ? (
            <p className="text-[11px] text-slate-500">
              {evaluation.milestoneTruncation.remainingCount} additional milestones are outside the bounded display.
            </p>
          ) : null}
        </div>
      </section>

      {evaluation.disclosedInterventions.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-bold text-slate-900">
            Delivered assistance associations
          </h3>
          <div className="space-y-2">
            {evaluation.disclosedInterventions.map((intervention) => (
              <div
                key={intervention.deliveryId}
                className="rounded-lg border border-slate-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-slate-700 break-all">
                    {intervention.deliveryId}
                  </span>
                  <span className="text-[10px] font-semibold text-slate-600">
                    {intervention.deliveryStatus} · level {intervention.disclosureLevel}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  {intervention.disclosureAssociationCount} protected disclosure association(s)
                  {intervention.relatedMilestoneIds.length > 0
                    ? ` · milestones: ${intervention.relatedMilestoneIds.join(", ")}`
                    : ""}
                </p>
                {intervention.relatedMilestoneTruncation.truncated ? (
                  <p className="mt-1 text-[10px] text-slate-500">
                    +{intervention.relatedMilestoneTruncation.remainingCount} additional milestone association(s) are outside the bounded display.
                  </p>
                ) : null}
                {intervention.deliveryStatus === "POSSIBLY_EXPOSED" ? (
                  <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                    Exposure is uncertain. Content is intentionally not replayed.
                  </p>
                ) : null}
              </div>
            ))}
            {evaluation.interventionTruncation.truncated ? (
              <p className="text-[11px] text-slate-500">
                {evaluation.interventionTruncation.remainingCount} additional delivered-assistance record(s) are outside the bounded display.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {evaluation.keyStrengths.length > 0 || evaluation.areasForImprovement.length > 0 ? (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-xs font-bold text-slate-900">Grounded strengths</h3>
            {evaluation.keyStrengths.length === 0 ? (
              <p className="mt-2 text-[11px] text-slate-500">No supported strength statement was produced.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-[11px] text-slate-700">
                {evaluation.keyStrengths.map((strength) => (
                  <li key={strength}>• {strength}</li>
                ))}
              </ul>
            )}
            {evaluation.strengthsTruncation.truncated ? (
              <p className="mt-2 text-[10px] text-slate-500">
                +{evaluation.strengthsTruncation.remainingCount} additional grounded strength statement(s) are outside the bounded display.
              </p>
            ) : null}
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <h3 className="text-xs font-bold text-slate-900">Grounded improvement areas</h3>
            {evaluation.areasForImprovement.length === 0 ? (
              <p className="mt-2 text-[11px] text-slate-500">No supported improvement statement was produced.</p>
            ) : (
              <ul className="mt-2 space-y-1 text-[11px] text-slate-700">
                {evaluation.areasForImprovement.map((area) => (
                  <li key={area}>• {area}</li>
                ))}
              </ul>
            )}
            {evaluation.improvementTruncation.truncated ? (
              <p className="mt-2 text-[10px] text-slate-500">
                +{evaluation.improvementTruncation.remainingCount} additional grounded improvement statement(s) are outside the bounded display.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
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
      <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
          <span>
            {response.replay.totalEventCount} authoritative events · validated through seq{" "}
            {response.replay.validatedThroughSequence}
          </span>
          <span className="font-semibold">
            {response.replay.complete ? "Complete replay" : "Bounded/incomplete replay"}
          </span>
        </div>
        {!response.replay.currentStateAvailable ? (
          <p className="mt-2 text-[11px] text-amber-800">
            Current-state claims are unavailable beyond the validated replay boundary.
          </p>
        ) : null}
        {response.replay.issues.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {response.replay.issues.map((issue, index) => (
              <span
                key={issue.code + ":" + (issue.sequence === undefined ? "none" : String(issue.sequence)) + ":" + String(index)}
                className="rounded bg-white border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600"
              >
                {issue.code}
                {issue.sequence === undefined ? "" : " @ " + String(issue.sequence)}
              </span>
            ))}
          </div>
        ) : null}
      </section>

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
            No projected events match this filter.
          </p>
        ) : (
          entries.map((entry) => (
            <article
              key={entry.eventId}
              className="rounded-lg border border-slate-200 bg-white p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] text-slate-400">
                      #{entry.sequence}
                    </span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                      {entry.category}
                    </span>
                    <span className="text-xs font-semibold text-slate-900">
                      {entry.summary}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-slate-400 break-all">
                    {entry.eventId}
                  </p>
                </div>
                <span className="text-[10px] text-slate-400">
                  {new Date(entry.occurredAt).toLocaleTimeString()}
                </span>
              </div>

              {entry.text !== undefined ? (
                <div className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-800">
                  {entry.text.text}
                  {entry.text.truncated ? (
                    <span className="text-slate-400"> …</span>
                  ) : null}
                </div>
              ) : null}

              {entry.delivery !== undefined ? (
                <div className="mt-2 rounded border border-slate-100 bg-slate-50 p-2 text-[11px] text-slate-600">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <span>Status: {entry.delivery.status}</span>
                    <span>Presentation: {entry.delivery.presentationState}</span>
                    <span>Disclosure level: {entry.delivery.effectiveDisclosureLevel}</span>
                    <span>Associations: {entry.delivery.disclosureIdCount}</span>
                  </div>
                  {entry.delivery.contentWithheld ? (
                    <p className="mt-1 font-semibold text-amber-800">
                      {entry.delivery.presentationState === "POSSIBLY_PRESENTED"
                        ? "Possibly exposed content is intentionally withheld and is never re-delivered by replay."
                        : "Content is not repeated from this delivery lifecycle event."}
                    </p>
                  ) : null}
                  {entry.delivery.boardAction !== undefined ? (
                    <div className="mt-2">
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
                </div>
              ) : null}

              {entry.verification !== undefined ? (
                <div className="mt-2 rounded border border-slate-100 bg-slate-50 p-2 text-[11px] text-slate-600">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    <span>Phase: {entry.verification.phase}</span>
                    {entry.verification.resultStatus !== undefined ? (
                      <span className="font-semibold">
                        Result: {entry.verification.resultStatus}
                      </span>
                    ) : null}
                    {entry.verification.verifier !== undefined ? (
                      <span>Verifier: {entry.verification.verifier}</span>
                    ) : null}
                  </div>
                  {entry.verification.evidenceKey !== undefined ? (
                    <p className="mt-1 font-mono text-[10px] break-all">
                      {evidenceSubjectLabel(entry.verification.evidenceKey)}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {entry.evidence !== undefined ? (
                <div className="mt-2 rounded border border-slate-100 bg-slate-50 p-2 text-[11px] text-slate-600">
                  <p className="font-mono text-[10px] break-all">
                    {evidenceSubjectLabel(entry.evidence.key)}
                  </p>
                  <p className="mt-1">
                    {entry.evidence.transition}
                    {entry.evidence.value === undefined ? "" : ` · ${entry.evidence.value}`}
                    {entry.evidence.inferenceConfidence === undefined
                      ? ""
                      : " · recorded confidence " + String(entry.evidence.inferenceConfidence)}
                  </p>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>

      {response.replay.timelineTruncation.truncated ? (
        <p className="text-[11px] text-slate-500">
          {response.replay.timelineTruncation.remainingCount} timeline entries are outside the bounded display.
        </p>
      ) : null}
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
        setEvaluationError("The bounded evaluation read could not be loaded.");
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
        setReplayError("The bounded replay read could not be loaded.");
        setReplayLoading(false);
      });
    return () => controller.abort();
  }, [activeTab, readReplay, replayError, replayResponse, sessionId]);

  const evaluationAvailable =
    evaluationResponse?.available === true ? evaluationResponse.evaluation : null;
  const replayAvailable =
    replayResponse?.available === true ? replayResponse : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-review-title"
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
          <div>
            <h2 id="session-review-title" className="text-base font-bold text-slate-900">
              Session Review
            </h2>
            <p className="mt-0.5 font-mono text-[10px] text-slate-500 break-all">
              {sessionId}
            </p>
          </div>
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
                Loading bounded evaluation…
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
              Loading bounded replay…
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
