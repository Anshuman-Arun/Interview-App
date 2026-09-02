import React, { useMemo, useState } from "react";
import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import type { SessionHistoryReadResponse } from "../../../../packages/replay/src/index.js";
import { isSessionIdAddressableForRead } from "../session-read-client.js";
import styles from "./SessionsPage.module.css";

type StatusFilter = "ALL" | "ACTIVE" | "COMPLETED" | "ARCHIVED";

export interface SessionsPageProps {
  readonly sessions: readonly StoredSessionSummary[];
  readonly currentSessionId: SessionId | null;
  readonly history: SessionHistoryReadResponse | null;
  readonly historyLoading: boolean;
  readonly historyError: string | null;
  readonly onRefresh: () => void;
  readonly canStartInterview: boolean;
  readonly onStartInterview: () => void | Promise<void>;
  readonly onResume: (sessionId: SessionId) => void | Promise<void>;
  readonly onReview: (sessionId: SessionId) => void;
}

const FILTERS: readonly StatusFilter[] = [
  "ALL",
  "ACTIVE",
  "COMPLETED",
  "ARCHIVED"
];

export const SessionsPage: React.FC<SessionsPageProps> = ({
  sessions,
  currentSessionId,
  history,
  historyLoading,
  historyError,
  onRefresh,
  canStartInterview,
  onStartInterview,
  onResume,
  onReview
}) => {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [query, setQuery] = useState("");

  const visibleSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...sessions]
      .filter((item) =>
        statusFilter === "ALL" || item.status === statusFilter
      )
      .filter((item) => {
        if (normalizedQuery.length === 0) return true;
        return item.sessionId.toLowerCase().includes(normalizedQuery)
          || (item.problemId?.toLowerCase().includes(normalizedQuery) ?? false);
      })
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      );
  }, [query, sessions, statusFilter]);

  return (
    <div className={styles.page ?? ""}>
      <section className={styles.controls}>
        <div className={styles.filters} role="group" aria-label="Session status">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={statusFilter === filter}
              className={
                statusFilter === filter
                  ? (styles.filterActive ?? "")
                  : (styles.filter ?? "")
              }
              onClick={() => setStatusFilter(filter)}
            >
              {filter === "ALL"
                ? "All"
                : filter.charAt(0) + filter.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        <div className={styles.searchGroup}>
          <label htmlFor="session-search">Search sessions</label>
          <input
            id="session-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Problem or session ID"
          />
        </div>

        <div className={styles.controlActions}>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canStartInterview}
            title={
              canStartInterview
                ? "Start a new interview"
                : "Finish or archive the active interview before starting another"
            }
            onClick={() => void onStartInterview()}
          >
            New interview
          </button>
        </div>
      </section>

      <section className={styles.history}>
        <header>
          <div>
            <h2>Grounded history</h2>
            <p>Only exact problem/version comparisons are aggregated.</p>
          </div>
          {history !== null && (
            <span>
              {history.longitudinal.includedSessionCount} bounded session
              {history.longitudinal.includedSessionCount === 1 ? "" : "s"}
            </span>
          )}
        </header>

        {historyLoading && history === null ? (
          <div className={styles.inlineState}>Loading grounded history…</div>
        ) : historyError !== null && history === null ? (
          <div className={styles.inlineError}>{historyError}</div>
        ) : history === null ? (
          <div className={styles.inlineState}>History has not been loaded yet.</div>
        ) : history.longitudinal.evaluationStatistics.some(
            (item) => item.average.compositeScore !== null
          ) ? (
          <div className={styles.metricRows}>
            {history.longitudinal.evaluationStatistics
              .filter((item) => item.average.compositeScore !== null)
              .map((item) => (
                <div
                  key={`${item.problemId}:${item.problemVersion}`}
                  className={styles.metricRow}
                >
                  <div>
                    <code>{item.problemId}</code>
                    <span>v{item.problemVersion}</span>
                  </div>
                  <strong>{item.average.compositeScore}</strong>
                  <span>
                    {item.scoredSessionCount["compositeScore"]} scored / {item.sessionCount}
                  </span>
                </div>
              ))}
          </div>
        ) : (
          <div className={styles.inlineState}>
            No supported cross-session score trend is currently grounded.
          </div>
        )}

        {history?.longitudinal.sessionTruncation.truncated === true && (
          <p className={styles.warning}>
            {history.longitudinal.sessionTruncation.remainingCount} additional session(s)
            are outside the current grounded aggregate coverage.
          </p>
        )}
      </section>

      <section className={styles.listSection}>
        <header>
          <h2>Local sessions</h2>
          <span>{visibleSessions.length} shown</span>
        </header>

        {visibleSessions.length === 0 ? (
          <div className={styles.empty}>
            No sessions match the current filters.
          </div>
        ) : (
          <div className={styles.table}>
            <div className={styles.tableHeader} aria-hidden="true">
              <span>Session</span>
              <span>Status</span>
              <span>Events</span>
              <span>Updated</span>
              <span />
            </div>

            {visibleSessions.map((item) => {
              const reviewable =
                (item.status === "COMPLETED" || item.status === "ARCHIVED")
                && isSessionIdAddressableForRead(item.sessionId);
              const actionable = item.status === "ACTIVE" || reviewable;

              return (
                <article key={item.sessionId} className={styles.row}>
                  <div className={styles.identity}>
                    <strong>{item.problemId ?? "Configured interview"}</strong>
                    <code>{item.sessionId}</code>
                  </div>
                  <span className={styles.status} data-status={item.status}>
                    {item.status.toLowerCase()}
                  </span>
                  <span className={styles.events}>{item.eventCount}</span>
                  <time dateTime={item.updatedAt}>
                    {new Date(item.updatedAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })}
                  </time>
                  <button
                    type="button"
                    disabled={!actionable}
                    onClick={
                      item.status === "ACTIVE"
                        ? () => void onResume(item.sessionId)
                        : reviewable
                          ? () => onReview(item.sessionId)
                          : undefined
                    }
                  >
                    {item.sessionId === currentSessionId && item.status === "ACTIVE"
                      ? "Current"
                      : item.status === "ACTIVE"
                        ? "Resume"
                        : reviewable
                          ? "Review"
                          : "Unavailable"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
