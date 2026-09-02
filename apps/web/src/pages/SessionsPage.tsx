import { useMemo, useState } from "react";
import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import type {
  SessionHistoryReadResponse
} from "../../../../packages/replay/src/index.js";
import "./SessionsPage.css";

type Filter = "ALL" | "ACTIVE" | "COMPLETED" | "ARCHIVED";

export function SessionsPage({
  sessions,
  currentSessionId,
  canReview,
  onResume,
  onReview,
  onRefresh,
  history,
  historyLoading,
  historyError
}: {
  readonly sessions: readonly StoredSessionSummary[];
  readonly currentSessionId: SessionId | null;
  readonly canReview: (session: StoredSessionSummary) => boolean;
  readonly onResume: (sessionId: SessionId) => void;
  readonly onReview: (sessionId: SessionId) => void;
  readonly onRefresh: () => void;
  readonly history: SessionHistoryReadResponse | null;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
}) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...sessions]
      .filter((session) => filter === "ALL" || session.status === filter)
      .filter((session) =>
        normalized.length === 0
        || session.sessionId.toLowerCase().includes(normalized)
        || (
          session.status !== "ACTIVE"
          && (session.problemId?.toLowerCase().includes(normalized) ?? false)
        )
      )
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [filter, query, sessions]);

  const activeCount = sessions.filter((session) => session.status === "ACTIVE").length;
  const completedCount = sessions.filter((session) => session.status === "COMPLETED").length;

  return (
    <div className="expressive-sessions">
      <section className="expressive-sessions__summary">
        <div>
          <span>ROOMS</span>
          <strong>{sessions.length}</strong>
          <small>stored locally</small>
        </div>
        <div>
          <span>OPEN</span>
          <strong>{activeCount}</strong>
          <small>active</small>
        </div>
        <div>
          <span>DONE</span>
          <strong>{completedCount}</strong>
          <small>completed</small>
        </div>
        <p>
          A ledger, not a dashboard. Resume work, inspect finished sessions,
          and keep exact problem/version history separate.
        </p>
      </section>

      <section className="expressive-sessions__history" data-testid="longitudinal-history-panel">
        <header>
          <span>GROUND TRUTH</span>
          <strong>Longitudinal read</strong>
          <small>
            {history === null
              ? historyLoading
                ? "reading…"
                : historyError ?? "no grounded aggregate yet"
              : `${String(history.longitudinal.includedSessionCount)} bounded session projection(s)`}
          </small>
        </header>

        {history !== null ? (
          <>
            <div className="expressive-sessions__history-stats">
              {history.longitudinal.evaluationStatistics
                .filter((item) => item.average.compositeScore !== null)
                .slice(0, 4)
                .map((item) => (
                  <article key={`${item.problemId}:${item.problemVersion}`}>
                    <code>{item.problemId} @ {item.problemVersion}</code>
                    <strong>{item.average.compositeScore}</strong>
                    <span>
                      {item.scoredSessionCount["compositeScore"]} scored / {item.sessionCount} evaluated
                    </span>
                  </article>
                ))}
            </div>

            {history.longitudinal.improvement.length > 0 && (
              <div className="expressive-sessions__improvement">
                {history.longitudinal.improvement.slice(0, 3).map((item) => (
                  <span key={`${item.fromSessionId}:${item.toSessionId}`}>
                    exact-problem Δ {item.compositeScoreDelta > 0 ? "+" : ""}
                    {item.compositeScoreDelta}
                  </span>
                ))}
              </div>
            )}

            {history.longitudinal.sessionTruncation.truncated && (
              <p>
                {history.longitudinal.sessionTruncation.remainingCount} session(s)
                sit outside this bounded aggregate.
              </p>
            )}
          </>
        ) : null}
      </section>

      <section className="expressive-sessions__toolbar">
        <div className="expressive-sessions__filters">
          {(["ALL", "ACTIVE", "COMPLETED", "ARCHIVED"] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={filter === item}
              onClick={() => setFilter(item)}
            >
              {item.toLowerCase()}
            </button>
          ))}
        </div>

        <label className="expressive-sessions__search">
          <span>Find</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Problem or session ID"
          />
        </label>

        <button
          type="button"
          className="expressive-sessions__refresh"
          onClick={onRefresh}
        >
          Refresh
        </button>
      </section>

      <section className="expressive-sessions__ledger">
        <div className="expressive-sessions__head" aria-hidden="true">
          <span>No.</span>
          <span>Session</span>
          <span>Status</span>
          <span>Events</span>
          <span>Updated</span>
          <span />
        </div>

        {visible.length === 0 ? (
          <div className="expressive-sessions__empty">
            Nothing matches this cut of the ledger.
          </div>
        ) : (
          visible.map((session, index) => {
            const reviewable = canReview(session);
            return (
              <article key={session.sessionId} className="expressive-sessions__row">
                <span className="expressive-sessions__number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="expressive-sessions__identity">
                  <strong>
                    {session.status === "ACTIVE"
                      ? "Active interview"
                      : session.problemId ?? "Configured interview"}
                  </strong>
                  <code>{session.sessionId}</code>
                </div>
                <span className="expressive-sessions__status" data-status={session.status}>
                  {session.status.toLowerCase()}
                </span>
                <span className="expressive-sessions__events">{session.eventCount}</span>
                <time dateTime={session.updatedAt}>
                  {new Date(session.updatedAt).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit"
                  })}
                </time>
                <button
                  type="button"
                  disabled={session.status !== "ACTIVE" && !reviewable}
                  onClick={
                    session.status === "ACTIVE"
                      ? () => onResume(session.sessionId)
                      : reviewable
                        ? () => onReview(session.sessionId)
                        : undefined
                  }
                >
                  {session.sessionId === currentSessionId && session.status === "ACTIVE"
                    ? "Current"
                    : session.status === "ACTIVE"
                      ? "Resume"
                      : reviewable
                        ? "Review"
                        : "—"}
                </button>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
