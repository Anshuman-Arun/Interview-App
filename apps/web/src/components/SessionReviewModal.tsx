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
import styles from "./SessionReviewModal.module.css";

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

function supportClass(
  support: "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT"
): string {
  switch (support) {
    case "STRONG":
      return styles.supportStrong ?? "";
    case "MODERATE":
      return styles.supportModerate ?? "";
    case "WEAK":
      return styles.supportWeak ?? "";
    case "INSUFFICIENT":
      return styles.supportInsufficient ?? "";
  }
}

function SupportBadge({
  support
}: {
  readonly support: "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";
}) {
  return (
    <span className={`${styles.supportBadge ?? ""} ${supportClass(support)}`}>
      {support.toLowerCase()}
    </span>
  );
}

export function EvaluationPanel({
  evaluation
}: {
  readonly evaluation: GroundedEvaluationReadModel;
}) {
  return (
    <div className={styles.stack} data-testid="grounded-evaluation-panel">
      <section className={styles.composite}>
        <div className={styles.compositeHeader}>
          <div>
            <div className={styles.eyebrow}>Grounded evaluation</div>
            <div className={styles.compositeScoreRow}>
              <span className={styles.compositeScore}>
                {scoreLabel(evaluation.composite.score)}
              </span>
              <span className={styles.compositeStatus}>
                {evaluation.composite.status}
              </span>
            </div>
          </div>
          <SupportBadge support={evaluation.composite.supportLevel} />
        </div>

        <p className={styles.summaryAssessment}>
          {evaluation.summaryAssessment}
        </p>

        {evaluation.composite.omittedDimensions.length > 0 && (
          <p className={styles.footnote}>
            Unsupported weighted dimensions omitted from the composite:{" "}
            {evaluation.composite.omittedDimensions
              .map((name) => DIMENSION_LABELS[name])
              .join(", ")}.
          </p>
        )}
      </section>

      <section>
        <div className={styles.sectionHeadingRow}>
          <h3 className={styles.sectionTitle}>Evaluation dimensions</h3>
          <span className={styles.sectionMeta}>
            Score and support are separate signals
          </span>
        </div>

        <div className={styles.dimensionTable}>
          {evaluation.dimensions.map((dimension) => (
            <article
              key={dimension.name}
              className={styles.dimensionRow}
              data-testid={`evaluation-dimension-${dimension.name}`}
            >
              <div className={styles.dimensionMain}>
                <div>
                  <h4 className={styles.dimensionName}>
                    {DIMENSION_LABELS[dimension.name]}
                  </h4>
                  {dimension.notScoredReason !== undefined && (
                    <p className={styles.notScoredReason}>
                      {dimension.notScoredReason}
                    </p>
                  )}
                </div>
                <div className={styles.dimensionValue}>
                  <span
                    className={
                      dimension.score === null
                        ? styles.scoreMuted
                        : styles.score
                    }
                  >
                    {scoreLabel(dimension.score)}
                  </span>
                  <SupportBadge support={dimension.supportLevel} />
                </div>
              </div>

              <details className={styles.evidenceDetails}>
                <summary>Evidence</summary>
                <div className={styles.evidenceList}>
                  {dimension.evidenceRefs.length === 0 ? (
                    <p className={styles.mutedText}>
                      No grounded evidence references are available for this dimension.
                    </p>
                  ) : (
                    dimension.evidenceRefs.map((ref) => (
                      <code
                        key={`${ref.kind}:${ref.id}`}
                        className={styles.codeRow}
                      >
                        {ref.kind}: {ref.id}
                      </code>
                    ))
                  )}
                  {dimension.evidenceRefTruncation.truncated && (
                    <p className={styles.footnote}>
                      +{dimension.evidenceRefTruncation.remainingCount} additional references withheld by the display bound.
                    </p>
                  )}
                </div>
              </details>
            </article>
          ))}
        </div>
      </section>

      <section>
        <div className={styles.sectionHeadingRow}>
          <h3 className={styles.sectionTitle}>Milestones</h3>
          <span className={styles.sectionMeta}>
            {evaluation.milestoneSummary.achieved}/{evaluation.milestoneSummary.total} achieved ·{" "}
            {evaluation.milestoneSummary.unassisted} unassisted ·{" "}
            {evaluation.milestoneSummary.assisted} assisted
          </span>
        </div>

        <div className={styles.list}>
          {evaluation.milestones.map((milestone) => (
            <details key={milestone.milestoneId} className={styles.detailRow}>
              <summary className={styles.detailSummary}>
                <div className={styles.detailPrimary}>
                  <code>{milestone.milestoneId}</code>
                  <span
                    className={
                      milestone.achieved
                        ? styles.achieved
                        : styles.notEstablished
                    }
                  >
                    {milestone.achieved ? "Achieved" : "Not established"}
                  </span>
                </div>
                <div className={styles.detailSecondary}>
                  <span>Assistance {milestone.assistanceLevel}</span>
                  <SupportBadge support={milestone.supportLevel} />
                </div>
              </summary>
              <div className={styles.detailBody}>
                {milestone.achievedAtTurnId !== undefined && (
                  <p>
                    Established at turn{" "}
                    <code>{milestone.achievedAtTurnId}</code>
                  </p>
                )}
                <p>
                  Disclosure associations: {milestone.assistanceDisclosureCount}
                </p>
                {milestone.evidenceRefs.map((ref) => (
                  <code
                    key={`${ref.kind}:${ref.id}`}
                    className={styles.codeRow}
                  >
                    {ref.kind}: {ref.id}
                  </code>
                ))}
                {milestone.evidenceRefTruncation.truncated && (
                  <p className={styles.footnote}>
                    +{milestone.evidenceRefTruncation.remainingCount} additional milestone evidence reference(s) are outside the bounded display.
                  </p>
                )}
              </div>
            </details>
          ))}
          {evaluation.milestoneTruncation.truncated && (
            <p className={styles.footnote}>
              {evaluation.milestoneTruncation.remainingCount} additional milestones are outside the bounded display.
            </p>
          )}
        </div>
      </section>

      {evaluation.disclosedInterventions.length > 0 && (
        <section>
          <h3 className={styles.sectionTitle}>Delivered assistance</h3>
          <div className={styles.list}>
            {evaluation.disclosedInterventions.map((intervention) => (
              <article
                key={intervention.deliveryId}
                className={styles.assistanceRow}
              >
                <div className={styles.assistanceHeader}>
                  <code>{intervention.deliveryId}</code>
                  <span>
                    {intervention.deliveryStatus} · level {intervention.disclosureLevel}
                  </span>
                </div>
                <p className={styles.mutedText}>
                  {intervention.disclosureAssociationCount} protected disclosure association(s)
                  {intervention.relatedMilestoneIds.length > 0
                    ? ` · milestones: ${intervention.relatedMilestoneIds.join(", ")}`
                    : ""}
                </p>
                {intervention.relatedMilestoneTruncation.truncated && (
                  <p className={styles.footnote}>
                    +{intervention.relatedMilestoneTruncation.remainingCount} additional milestone association(s) are outside the bounded display.
                  </p>
                )}
                {intervention.deliveryStatus === "POSSIBLY_EXPOSED" && (
                  <p className={styles.exposureWarning}>
                    Exposure is uncertain. Content is intentionally not replayed.
                  </p>
                )}
              </article>
            ))}
            {evaluation.interventionTruncation.truncated && (
              <p className={styles.footnote}>
                {evaluation.interventionTruncation.remainingCount} additional delivered-assistance record(s) are outside the bounded display.
              </p>
            )}
          </div>
        </section>
      )}

      {(evaluation.keyStrengths.length > 0
        || evaluation.areasForImprovement.length > 0) && (
        <section className={styles.insightsGrid}>
          <div className={styles.insightColumn}>
            <h3 className={styles.sectionTitle}>Grounded strengths</h3>
            {evaluation.keyStrengths.length === 0 ? (
              <p className={styles.mutedText}>
                No supported strength statement was produced.
              </p>
            ) : (
              <ul>
                {evaluation.keyStrengths.map((strength) => (
                  <li key={strength}>{strength}</li>
                ))}
              </ul>
            )}
            {evaluation.strengthsTruncation.truncated && (
              <p className={styles.footnote}>
                +{evaluation.strengthsTruncation.remainingCount} additional grounded strength statement(s) are outside the bounded display.
              </p>
            )}
          </div>

          <div className={styles.insightColumn}>
            <h3 className={styles.sectionTitle}>Grounded improvement areas</h3>
            {evaluation.areasForImprovement.length === 0 ? (
              <p className={styles.mutedText}>
                No supported improvement statement was produced.
              </p>
            ) : (
              <ul>
                {evaluation.areasForImprovement.map((area) => (
                  <li key={area}>{area}</li>
                ))}
              </ul>
            )}
            {evaluation.improvementTruncation.truncated && (
              <p className={styles.footnote}>
                +{evaluation.improvementTruncation.remainingCount} additional grounded improvement statement(s) are outside the bounded display.
              </p>
            )}
          </div>
        </section>
      )}
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
    <div className={styles.stack} data-testid="session-replay-panel">
      <section className={styles.replaySummary}>
        <div>
          <span>
            {response.replay.totalEventCount} authoritative events
          </span>
          <span aria-hidden="true"> · </span>
          <span>
            validated through seq {response.replay.validatedThroughSequence}
          </span>
        </div>
        <strong>
          {response.replay.complete
            ? "Complete replay"
            : "Bounded / incomplete replay"}
        </strong>

        {!response.replay.currentStateAvailable && (
          <p className={styles.exposureWarning}>
            Current-state claims are unavailable beyond the validated replay boundary.
          </p>
        )}

        {response.replay.issues.length > 0 && (
          <div className={styles.issueList}>
            {response.replay.issues.map((issue, index) => (
              <code
                key={issue.code + ":" + (issue.sequence === undefined ? "none" : String(issue.sequence)) + ":" + String(index)}
                className={styles.issue}
              >
                {issue.code}
                {issue.sequence === undefined ? "" : " @ " + String(issue.sequence)}
              </code>
            ))}
          </div>
        )}
      </section>

      <div
        className={styles.filterBar}
        role="group"
        aria-label="Replay category filter"
      >
        {REPLAY_FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => setFilter(item.value)}
            className={
              filter === item.value
                ? styles.filterActive
                : styles.filterButton
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className={styles.timeline}>
        {entries.length === 0 ? (
          <p className={styles.emptyState}>
            No projected events match this filter.
          </p>
        ) : (
          entries.map((entry) => (
            <article key={entry.eventId} className={styles.timelineEntry}>
              <div className={styles.timelineRail}>
                <code>#{entry.sequence}</code>
              </div>

              <div className={styles.timelineContent}>
                <header className={styles.timelineHeader}>
                  <div className={styles.timelineTitleGroup}>
                    <span className={styles.category}>
                      {entry.category}
                    </span>
                    <strong>{entry.summary}</strong>
                  </div>
                  <time dateTime={entry.occurredAt}>
                    {new Date(entry.occurredAt).toLocaleTimeString()}
                  </time>
                </header>

                <code className={styles.eventId}>{entry.eventId}</code>

                {entry.text !== undefined && (
                  <div className={styles.payloadText}>
                    {entry.text.text}
                    {entry.text.truncated && (
                      <span className={styles.mutedText}> …</span>
                    )}
                  </div>
                )}

                {entry.delivery !== undefined && (
                  <div className={styles.payloadBox}>
                    <div className={styles.inlineMeta}>
                      <span>Status: {entry.delivery.status}</span>
                      <span>Presentation: {entry.delivery.presentationState}</span>
                      <span>Disclosure: {entry.delivery.effectiveDisclosureLevel}</span>
                      <span>Associations: {entry.delivery.disclosureIdCount}</span>
                    </div>

                    {entry.delivery.contentWithheld && (
                      <p className={styles.exposureWarning}>
                        {entry.delivery.presentationState === "POSSIBLY_PRESENTED"
                          ? "Possibly exposed content is intentionally withheld and is never re-delivered by replay."
                          : "Content is not repeated from this delivery lifecycle event."}
                      </p>
                    )}

                    {entry.delivery.boardAction !== undefined && (
                      <div className={styles.payloadSection}>
                        <strong>
                          Whiteboard {entry.delivery.boardAction.operation}
                        </strong>
                        {entry.delivery.boardAction.content !== undefined && (
                          <p>{entry.delivery.boardAction.content.text}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {entry.verification !== undefined && (
                  <div className={styles.payloadBox}>
                    <div className={styles.inlineMeta}>
                      <span>Phase: {entry.verification.phase}</span>
                      {entry.verification.resultStatus !== undefined && (
                        <strong>
                          Result: {entry.verification.resultStatus}
                        </strong>
                      )}
                      {entry.verification.verifier !== undefined && (
                        <span>Verifier: {entry.verification.verifier}</span>
                      )}
                    </div>
                    {entry.verification.evidenceKey !== undefined && (
                      <code className={styles.codeRow}>
                        {evidenceSubjectLabel(entry.verification.evidenceKey)}
                      </code>
                    )}
                  </div>
                )}

                {entry.evidence !== undefined && (
                  <div className={styles.payloadBox}>
                    <code className={styles.codeRow}>
                      {evidenceSubjectLabel(entry.evidence.key)}
                    </code>
                    <p>
                      {entry.evidence.transition}
                      {entry.evidence.value === undefined
                        ? ""
                        : ` · ${entry.evidence.value}`}
                      {entry.evidence.inferenceConfidence === undefined
                        ? ""
                        : " · recorded confidence " + String(entry.evidence.inferenceConfidence)}
                    </p>
                  </div>
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {response.replay.timelineTruncation.truncated && (
        <p className={styles.footnote}>
          {response.replay.timelineTruncation.remainingCount} timeline entries are outside the bounded display.
        </p>
      )}
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
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

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
    <div className={styles.overlay}>
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-review-title"
      >
        <header className={styles.modalHeader}>
          <div>
            <h2 id="session-review-title">Session review</h2>
            <code>{sessionId}</code>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={styles.closeButton}
            aria-label="Close session review"
          >
            ×
          </button>
        </header>

        <div
          className={styles.tabs}
          role="tablist"
          aria-label="Session review views"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "evaluation"}
            onClick={() => setActiveTab("evaluation")}
            className={
              activeTab === "evaluation"
                ? styles.tabActive
                : styles.tab
            }
          >
            Evaluation
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "replay"}
            onClick={() => setActiveTab("replay")}
            className={
              activeTab === "replay"
                ? styles.tabActive
                : styles.tab
            }
          >
            Replay timeline
          </button>
        </div>

        <div className={styles.modalBody}>
          {activeTab === "evaluation" ? (
            evaluationLoading ? (
              <p className={styles.loadingState}>
                Loading bounded evaluation…
              </p>
            ) : evaluationError !== null ? (
              <div className={styles.errorState}>{evaluationError}</div>
            ) : evaluationAvailable !== null ? (
              <EvaluationPanel evaluation={evaluationAvailable} />
            ) : evaluationResponse?.available === false ? (
              <div
                className={styles.unavailableState}
                data-testid="evaluation-unavailable"
              >
                <h3>Evaluation not scored here</h3>
                <p>{failureMessage(evaluationResponse.reason)}</p>
              </div>
            ) : null
          ) : replayLoading ? (
            <p className={styles.loadingState}>
              Loading bounded replay…
            </p>
          ) : replayError !== null ? (
            <div className={styles.errorState}>{replayError}</div>
          ) : replayAvailable !== null ? (
            <ReplayPanel response={replayAvailable} />
          ) : replayResponse?.available === false ? (
            <div
              className={styles.unavailableState}
              data-testid="replay-unavailable"
            >
              <h3>Replay unavailable</h3>
              <p>{failureMessage(replayResponse.reason)}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
