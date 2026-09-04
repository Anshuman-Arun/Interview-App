import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import "./HomePage.css";

export function HomePage({
  activeSessionId,
  activeProblemTitle,
  activeSessionPaused,
  sessions,
  onStartInterview,
  onResumeInterview,
  onOpenSessions,
  onOpenSettings,
  canReview,
  onReview,
  sessionEntryPending
}: {
  readonly activeSessionId: SessionId | null;
  readonly activeProblemTitle?: string | null;
  readonly activeSessionPaused?: boolean;
  readonly sessions: readonly StoredSessionSummary[];
  readonly onStartInterview: () => void;
  readonly onResumeInterview: (sessionId: SessionId) => void;
  readonly onOpenSessions: () => void;
  readonly onOpenSettings: () => void;
  readonly canReview: (session: StoredSessionSummary) => boolean;
  readonly onReview: (sessionId: SessionId) => void;
  readonly sessionEntryPending: boolean;
}) {
  const recent = [...sessions]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, 5);
  const completedCount = sessions.filter(
    (session) => session.status === "COMPLETED" || session.status === "ARCHIVED"
  ).length;
  const latestReviewable = recent.find(canReview) ?? null;

  return (
    <div className="expressive-home">
      <section className="expressive-home__hero">
        <div className="expressive-home__hero-copy">
          <div className="expressive-home__coordinate">
            <span>01 / BEGIN</span>
          </div>

          <h2>A room for thinking out loud.</h2>

          <p>
            Practice difficult technical conversations with a responsive
            interviewer and a whiteboard that stays central.
          </p>

          <div className="expressive-home__hero-actions">
            {activeSessionId === null ? (
              <button
                type="button"
                className="expressive-home__primary"
                onClick={onStartInterview}
                disabled={sessionEntryPending}
                data-testid="start-session-btn"
              >
                {sessionEntryPending ? "Opening room…" : "New interview"}
                <span aria-hidden="true">↗</span>
              </button>
            ) : (
              <button
                type="button"
                className="expressive-home__primary"
                onClick={() => onResumeInterview(activeSessionId)}
                disabled={sessionEntryPending}
              >
                {sessionEntryPending
                  ? "Opening room…"
                  : activeSessionPaused
                    ? "Resume interview"
                    : "Return to room"}
                <span aria-hidden="true">↗</span>
              </button>
            )}

            <button
              type="button"
              className="expressive-home__secondary"
              onClick={onOpenSessions}
            >
              Session ledger
            </button>
          </div>
        </div>

        <aside className="expressive-home__summary" aria-label="Practice summary">
          <section className="expressive-home__summary-card expressive-home__summary-card--ink">
            <span>LAST SESSION</span>
            <strong>
              {latestReviewable?.problemId ?? "Your first review awaits"}
            </strong>
            <p>
              {latestReviewable === null
                ? "Complete an interview to build your review trail."
                : "Return to the review while the reasoning is still fresh."}
            </p>
          </section>
          <section className="expressive-home__summary-card">
            <span>PRACTICE</span>
            <strong>{completedCount} finished</strong>
            <p>Completed and archived interviews in your local ledger.</p>
          </section>
        </aside>
      </section>

      {activeSessionId !== null && (
        <section className="expressive-home__active">
          <span className="expressive-home__active-index">NOW</span>
          <div>
            <strong>{activeProblemTitle ?? "Interview in progress"}</strong>
            <p>
              {activeSessionPaused
                ? "Paused. Resume when you are ready; nothing was ended or archived."
                : "An active room already exists. Resume it before starting anything else."}
            </p>
          </div>
          <button
            type="button"
            disabled={sessionEntryPending}
            onClick={() => onResumeInterview(activeSessionId)}
          >
            {sessionEntryPending ? "Opening…" : "Resume"}
          </button>
        </section>
      )}

      <section className="expressive-home__lower">
        <div className="expressive-home__ledger">
          <header>
            <div>
              <span>02 / HISTORY</span>
              <h3>Recent rooms</h3>
            </div>
            <button type="button" onClick={onOpenSessions}>See all</button>
          </header>

          {recent.length === 0 ? (
            <div className="expressive-home__empty">
              Your first completed interview will leave a trail here.
            </div>
          ) : (
            <div className="expressive-home__rows">
              {recent.map((session, index) => {
                const reviewable = canReview(session);
                return (
                  <article key={session.sessionId} className="expressive-home__row">
                    <span className="expressive-home__row-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="expressive-home__row-main">
                      <strong>
                        {session.status === "ACTIVE"
                          ? "Active interview"
                          : session.problemId ?? "Configured interview"}
                      </strong>
                      <code>{session.sessionId}</code>
                    </div>
                    <span
                      className="expressive-home__row-status"
                      data-status={session.status}
                    >
                      {session.status.toLowerCase()}
                    </span>
                    <time dateTime={session.updatedAt}>
                      {new Date(session.updatedAt).toLocaleDateString([], {
                        month: "short",
                        day: "numeric"
                      })}
                    </time>
                    <button
                      type="button"
                      disabled={session.status !== "ACTIVE" && !reviewable}
                      onClick={
                        session.status === "ACTIVE"
                          ? () => onResumeInterview(session.sessionId)
                          : reviewable
                            ? () => onReview(session.sessionId)
                            : undefined
                      }
                    >
                      {session.status === "ACTIVE" ? "Resume" : reviewable ? "Review" : "—"}
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </div>

        <aside className="expressive-home__manifesto">
          <div className="expressive-home__manifesto-count">
            <strong>{completedCount}</strong>
            <span>finished</span>
          </div>
          <div className="expressive-home__manifesto-copy">
            <span>03 / TOOLKIT</span>
            <p>
              Voice for the argument.
              <br />
              Whiteboard for the structure.
              <br />
              Replay for the parts you missed.
            </p>
          </div>
          <button type="button" onClick={onOpenSettings}>
            Tune the room
          </button>
        </aside>
      </section>
    </div>
  );
}
