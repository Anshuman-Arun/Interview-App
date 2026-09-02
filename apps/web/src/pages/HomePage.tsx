import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import "./HomePage.css";

export function HomePage({
  activeSessionId,
  activeProblemTitle,
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

  return (
    <div className="expressive-home">
      <section className="expressive-home__hero">
        <div className="expressive-home__hero-copy">
          <div className="expressive-home__coordinate">
            <span>ROOM 01</span>
            <span>THINK ALOUD</span>
          </div>

          <h2>
            Think on the page.
            <span>Talk through the proof.</span>
          </h2>

          <p>
            A focused interview room for mathematical proofs, market intuition,
            and research reasoning. Voice and whiteboard stay close; everything
            else gets out of the way.
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
                {sessionEntryPending ? "Opening room…" : "Enter interview"}
                <span aria-hidden="true">↗</span>
              </button>
            ) : (
              <button
                type="button"
                className="expressive-home__primary"
                onClick={() => onResumeInterview(activeSessionId)}
                disabled={sessionEntryPending}
              >
                {sessionEntryPending ? "Opening room…" : "Return to room"}
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

        <div className="expressive-home__studio" aria-label="Interview workspace preview">
          <div className="expressive-home__studio-top">
            <span>LIVE WORKSPACE</span>
            <span className="expressive-home__studio-dot" />
          </div>

          <div className="expressive-home__paper">
            <span className="expressive-home__paper-index">Q</span>
            <strong>Suppose the next step is not obvious.</strong>
            <p>Say what you know. Draw what you see. Let the interviewer push on the gap.</p>
          </div>

          <div className="expressive-home__scratch">
            <span className="expressive-home__scratch-line expressive-home__scratch-line--one" />
            <span className="expressive-home__scratch-line expressive-home__scratch-line--two" />
            <span className="expressive-home__scratch-node expressive-home__scratch-node--a" />
            <span className="expressive-home__scratch-node expressive-home__scratch-node--b" />
            <span className="expressive-home__scratch-node expressive-home__scratch-node--c" />
          </div>

          <div className="expressive-home__transcript-preview">
            <span>INTERVIEWER</span>
            <p>Why does that implication have to hold?</p>
          </div>
        </div>
      </section>

      {activeSessionId !== null && (
        <section className="expressive-home__active">
          <span className="expressive-home__active-index">NOW</span>
          <div>
            <strong>{activeProblemTitle ?? "Interview in progress"}</strong>
            <p>An active room already exists. Resume it before starting anything else.</p>
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
                      <strong>{session.problemId ?? "Configured interview"}</strong>
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
