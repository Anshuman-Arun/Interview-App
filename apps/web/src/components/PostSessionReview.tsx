import React, { useMemo, useState } from "react";
import type {
  GroundedEvaluationDimension,
  SessionEvaluationReadResponse,
  SessionHistoryReadResponse,
  SessionReplayReadResponse
} from "../../../packages/replay/src/index.js";

export type PostSessionReviewTab = "evaluation" | "replay" | "history";

export interface PostSessionReviewProps {
  readonly sessionId: string;
  readonly evaluation: SessionEvaluationReadResponse | null;
  readonly replay: SessionReplayReadResponse | null;
  readonly history: SessionHistoryReadResponse | null;
  readonly loading: boolean;
  readonly initialTab?: PostSessionReviewTab;
  readonly onClose: () => void;
}

const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  technicalCorrectness: "Technical Correctness",
  rigor: "Rigor",
  independence: "Independence",
  communication: "Communication",
  hintResponsiveness: "Hint Responsiveness",
  errorRecovery: "Error Recovery"
};

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  SESSION_NOT_TERMINAL: "Evaluation is available only after the session is terminal.",
  EXACT_PROBLEM_UNAVAILABLE:
    "The exact session-bound problem definition cannot be reconstructed safely.",
  AUTHORITATIVE_HISTORY_UNAVAILABLE:
    "Authoritative session history could not be reconstructed safely.",
  READ_LIMIT_EXCEEDED:
    "This history exceeds the bounded product read limit.",
  EVALUATION_UNAVAILABLE:
    "Grounded evaluation is unavailable for this session.",
  REPLAY_UNAVAILABLE:
    "Replay is unavailable because the history could not be projected safely."
};

function scoreText(score: number | null): string {
  return score === null ? "Not scored" : String(score);
}

function supportClass(support: string): string {
  return `review-support review-support--${support.toLowerCase()}`;
}

function failureText(reason: string): string {
  return FAILURE_LABELS[reason] ?? "This read model is unavailable.";
}

function dimensionWhy(dimension: GroundedEvaluationDimension): string {
  if (dimension.notScoredReason !== undefined) return dimension.notScoredReason;
  const count = dimension.evidenceRefs.length;
  return `Grounded from ${String(count)} bounded evidence reference${count === 1 ? "" : "s"} with ${dimension.supportLevel.toLowerCase()} support.`;
}

export const PostSessionReview: React.FC<PostSessionReviewProps> = ({
  sessionId,
  evaluation,
  replay,
  history,
  loading,
  initialTab = "evaluation",
  onClose
}) => {
  const [tab, setTab] = useState<PostSessionReviewTab>(initialTab);
  const [whyDimension, setWhyDimension] = useState<string | null>(null);
  const [evidenceDimension, setEvidenceDimension] = useState<string | null>(null);

  const evaluationModel =
    evaluation?.available === true ? evaluation.evaluation : null;
  const replayModel = replay?.available === true ? replay.replay : null;

  const replayEntries = useMemo(
    () => replayModel?.entries ?? [],
    [replayModel]
  );

  return (
    <div
      className="post-session-review-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Post-session review"
      data-testid="post-session-review"
    >
      <section className="post-session-review">
        <header className="post-session-review__header">
          <div>
            <p className="post-session-review__eyebrow">Interview Complete / Session Review</p>
            <h2>Grounded Evaluation & Replay</h2>
            <p className="post-session-review__session">{sessionId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="post-session-review__close"
            aria-label="Close session review"
          >
            ×
          </button>
        </header>

        <nav className="post-session-review__tabs" aria-label="Review sections">
          {(["evaluation", "replay", "history"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={tab === value ? "is-active" : ""}
              data-testid={`review-tab-${value}`}
            >
              {value === "evaluation"
                ? "Evaluation"
                : value === "replay"
                  ? "Replay"
                  : "History"}
            </button>
          ))}
        </nav>

        <div className="post-session-review__body">
          {loading && (
            <div className="review-empty" data-testid="review-loading">
              Loading bounded read models…
            </div>
          )}

          {!loading && tab === "evaluation" && (
            evaluationModel === null ? (
              <div className="review-empty">
                <strong>Evaluation unavailable</strong>
                <span>
                  {evaluation === null
                    ? "No evaluation response was loaded."
                    : failureText(evaluation.reason)}
                </span>
              </div>
            ) : (
              <div className="review-stack" data-testid="evaluation-panel">
                <section className="review-summary-card">
                  <div>
                    <p className="review-kicker">Grounded composite</p>
                    <div className="review-composite">
                      <span data-testid="composite-score">
                        {scoreText(evaluationModel.composite.score)}
                      </span>
                      {evaluationModel.composite.score !== null && <small>/100</small>}
                    </div>
                  </div>
                  <div className="review-summary-meta">
                    <span className={supportClass(evaluationModel.composite.supportLevel)}>
                      {evaluationModel.composite.supportLevel} support
                    </span>
                    <span>{evaluationModel.composite.status}</span>
                    <span>
                      Milestones {evaluationModel.milestoneSummary.achieved}/
                      {evaluationModel.milestoneSummary.total}
                    </span>
                  </div>
                  <p>{evaluationModel.summaryAssessment}</p>
                </section>

                <section>
                  <h3>Performance dimensions</h3>
                  <div className="review-dimension-grid">
                    {evaluationModel.dimensions.map((dimension) => (
                      <article
                        key={dimension.name}
                        className="review-dimension"
                        data-testid={`dimension-${dimension.name}`}
                      >
                        <div className="review-dimension__top">
                          <div>
                            <h4>{DIMENSION_LABELS[dimension.name] ?? dimension.name}</h4>
                            <div className="review-dimension__score">
                              {scoreText(dimension.score)}
                            </div>
                          </div>
                          <span className={supportClass(dimension.supportLevel)}>
                            {dimension.supportLevel}
                          </span>
                        </div>
                        <div className="review-dimension__actions">
                          <button
                            type="button"
                            onClick={() =>
                              setWhyDimension((current) =>
                                current === dimension.name ? null : dimension.name
                              )}
                          >
                            Why?
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setEvidenceDimension((current) =>
                                current === dimension.name ? null : dimension.name
                              )}
                          >
                            Evidence ({dimension.evidenceRefs.length})
                          </button>
                        </div>
                        {whyDimension === dimension.name && (
                          <p className="review-explanation">{dimensionWhy(dimension)}</p>
                        )}
                        {evidenceDimension === dimension.name && (
                          <div className="review-evidence-list">
                            {dimension.evidenceRefs.length === 0 ? (
                              <span>No grounded evidence references are exposed for this dimension.</span>
                            ) : (
                              dimension.evidenceRefs.map((ref) => (
                                <code key={`${ref.kind}:${ref.id}`}>
                                  {ref.kind}: {ref.id}
                                </code>
                              ))
                            )}
                            {dimension.evidenceRefTruncation.truncated && (
                              <span>
                                +{dimension.evidenceRefTruncation.remainingCount} bounded reference(s) omitted
                              </span>
                            )}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>

                <section className="review-two-column">
                  <div>
                    <h3>Milestones</h3>
                    <div className="review-list">
                      {evaluationModel.milestones.map((milestone) => (
                        <div key={milestone.milestoneId} className="review-list-row">
                          <div>
                            <strong>{milestone.milestoneId}</strong>
                            <span>
                              {milestone.achieved ? "Achieved" : "Incomplete"}
                              {" · "}assistance level {milestone.assistanceLevel}
                            </span>
                          </div>
                          <span className={supportClass(milestone.supportLevel)}>
                            {milestone.supportLevel}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3>Disclosure associations</h3>
                    <div className="review-list">
                      {evaluationModel.disclosedInterventions.length === 0 ? (
                        <div className="review-list-row">
                          <span>No exposed protected assistance was recorded.</span>
                        </div>
                      ) : (
                        evaluationModel.disclosedInterventions.map((item) => (
                          <div key={item.deliveryId} className="review-list-row">
                            <div>
                              <strong>{item.deliveryStatus}</strong>
                              <span>
                                Level {item.disclosureLevel}
                                {" · "}
                                {item.relatedMilestoneIds.length} milestone association(s)
                              </span>
                              {item.deliveryStatus === "POSSIBLY_EXPOSED" && (
                                <em>
                                  Content is not replayed because prior exposure is uncertain.
                                </em>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )
          )}

          {!loading && tab === "replay" && (
            replayModel === null ? (
              <div className="review-empty">
                <strong>Replay unavailable</strong>
                <span>
                  {replay === null
                    ? "No replay response was loaded."
                    : failureText(replay.reason)}
                </span>
              </div>
            ) : (
              <div className="review-stack" data-testid="replay-panel">
                <section className="review-summary-card review-summary-card--compact">
                  <div>
                    <p className="review-kicker">Read-only timeline</p>
                    <h3>{replayModel.entries.length} projected entries</h3>
                  </div>
                  <div className="review-summary-meta">
                    <span>{replayModel.lifecycle.status}</span>
                    <span>
                      {replayModel.complete ? "Complete projection" : "Incomplete projection"}
                    </span>
                    <span>{replayModel.totalEventCount} authoritative event(s)</span>
                  </div>
                </section>

                {replayModel.issues.length > 0 && (
                  <div className="review-warning">
                    Replay is bounded or semantically incomplete. Current-state claims are shown
                    only where the replay package validated them.
                  </div>
                )}

                <div className="review-timeline" data-testid="replay-timeline">
                  {replayEntries.map((entry) => (
                    <article
                      key={entry.eventId}
                      className="review-timeline-entry"
                      data-testid={`replay-entry-${entry.sequence}`}
                    >
                      <div className="review-timeline-entry__rail">
                        <span>{entry.sequence}</span>
                      </div>
                      <div className="review-timeline-entry__content">
                        <div className="review-timeline-entry__top">
                          <strong>{entry.summary}</strong>
                          <span>{entry.category}</span>
                        </div>
                        {entry.text !== undefined && (
                          <p className="review-replay-text">{entry.text.text}</p>
                        )}
                        {entry.delivery?.status === "POSSIBLY_EXPOSED" && (
                          <p className="review-withheld" data-testid="possibly-exposed-withheld">
                            Possibly exposed delivery — content withheld; replay does not
                            re-deliver or acknowledge it.
                          </p>
                        )}
                        {entry.delivery !== undefined
                          && entry.delivery.contentWithheld
                          && entry.delivery.status !== "POSSIBLY_EXPOSED"
                          && entry.text === undefined && (
                            <p className="review-withheld">Content is intentionally not repeated at this lifecycle event.</p>
                          )}
                        {entry.verification !== undefined && (
                          <p>
                            Verification {entry.verification.phase.toLowerCase()}
                            {entry.verification.resultStatus === undefined
                              ? ""
                              : ` · ${entry.verification.resultStatus}`}
                          </p>
                        )}
                        {entry.evidence !== undefined && (
                          <p>
                            Evidence {entry.evidence.key.dimension.toLowerCase()}
                            {entry.evidence.value === undefined ? "" : ` · ${entry.evidence.value}`}
                          </p>
                        )}
                        <small>
                          {entry.stateValidation} · {new Date(entry.occurredAt).toLocaleString()}
                        </small>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            )
          )}

          {!loading && tab === "history" && (
            history === null ? (
              <div className="review-empty">
                <strong>Longitudinal history unavailable</strong>
                <span>No bounded longitudinal history response was loaded.</span>
              </div>
            ) : (
              <div className="review-stack" data-testid="history-panel">
                <section className="review-summary-card review-summary-card--compact">
                  <div>
                    <p className="review-kicker">Grounded longitudinal view</p>
                    <h3>{history.longitudinal.completedSessions} completed session(s)</h3>
                  </div>
                  <div className="review-summary-meta">
                    <span>{history.longitudinal.problemsAttempted} exact problem/version(s)</span>
                    <span>
                      {history.longitudinal.comparability.skillTaxonomyAvailable
                        ? "Skill taxonomy available"
                        : "No fabricated skill taxonomy"}
                    </span>
                  </div>
                </section>

                <section>
                  <h3>Exact-problem evaluation history</h3>
                  <div className="review-list">
                    {history.longitudinal.evaluationStatistics.length === 0 ? (
                      <div className="review-list-row">
                        <span>No supported cross-session evaluation statistics yet.</span>
                      </div>
                    ) : (
                      history.longitudinal.evaluationStatistics.map((stat) => (
                        <div
                          key={`${stat.problemId}:${stat.problemVersion}`}
                          className="review-list-row"
                        >
                          <div>
                            <strong>{stat.problemId} · v{stat.problemVersion}</strong>
                            <span>{stat.sessionCount} evaluated session(s)</span>
                          </div>
                          <span>
                            Composite avg: {stat.average.compositeScore === null
                              ? "Not scored"
                              : stat.average.compositeScore.toFixed(1)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <h3>Grounded change between repeated attempts</h3>
                  <div className="review-list">
                    {history.longitudinal.improvement.length === 0 ? (
                      <div className="review-list-row">
                        <span>
                          No exact-problem composite deltas are currently supported.
                        </span>
                      </div>
                    ) : (
                      history.longitudinal.improvement.map((item) => (
                        <div
                          key={`${item.fromSessionId}:${item.toSessionId}`}
                          className="review-list-row"
                        >
                          <div>
                            <strong>{item.problemId} · v{item.problemVersion}</strong>
                            <span>
                              {item.fromSessionId} → {item.toSessionId}
                            </span>
                          </div>
                          <span>
                            {item.compositeScoreDelta > 0 ? "+" : ""}
                            {item.compositeScoreDelta}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  {history.longitudinal.improvementComparisonsSkipped > 0 && (
                    <p className="review-muted">
                      {history.longitudinal.improvementComparisonsSkipped} comparison(s)
                      were omitted because grounded comparable scores were unavailable.
                    </p>
                  )}
                </section>
              </div>
            )
          )}
        </div>
      </section>
    </div>
  );
};
