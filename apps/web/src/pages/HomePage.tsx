import React, { useMemo } from "react";
import type {
  SessionId,
  StoredSessionSummary
} from "../../../../packages/domain/src/index.js";
import { isSessionIdAddressableForRead } from "../session-read-client.js";
import styles from "./HomePage.module.css";

export interface HomePageProps {
  readonly activeSessionId: SessionId | null;
  readonly activeProblemTitle?: string | null;
  readonly sessions: readonly StoredSessionSummary[];
  readonly onStartInterview: () => void | Promise<void>;
  readonly onResumeInterview: (sessionId: SessionId) => void | Promise<void>;
  readonly onReviewSession: (sessionId: SessionId) => void;
  readonly onOpenSessions: () => void;
}

function newestFirst(
  sessions: readonly StoredSessionSummary[]
): readonly StoredSessionSummary[] {
  return [...sessions].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

export const HomePage: React.FC<HomePageProps> = ({
  activeSessionId,
  activeProblemTitle = null,
  sessions,
  onStartInterview,
  onResumeInterview,
  onReviewSession,
  onOpenSessions
}) => {
  const recentSessions = useMemo(
    () => newestFirst(sessions).slice(0, 5),
    [sessions]
  );

  const activeSummary = activeSessionId === null
    ? null
    : sessions.find((item) => item.sessionId === activeSessionId) ?? null;

  return (
    <div className={styles.home ?? ""}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>Interview practice</span>
          <h2>
            {activeSessionId === null
              ? "Start a focused technical interview."
              : "Your interview is still active."}
          </h2>
          <p>
            {activeSessionId === null
              ? "Work through the problem, explain your reasoning, and review grounded evidence when you finish."
              : activeProblemTitle ?? activeSummary?.problemId ?? "Return to the active interview workspace."}
          </p>
        </div>

        <div className={styles.heroActions}>
          {activeSessionId === null ? (
            <button
              type="button"
              className={styles.primaryAction}
              onClick={() => void onStartInterview()}
            >
              Start interview
            </button>
          ) : (
            <button
              type="button"
              className={styles.primaryAction}
              onClick={() => void onResumeInterview(activeSessionId)}
            >
              Resume interview
            </button>
          )}
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={onOpenSessions}
          >
            View sessions
          </button>
        </div>
      </section>

      <section className={styles.recent}>
        <header className={styles.sectionHeader}>
          <div>
            <h3>Recent sessions</h3>
            <p>Local interview history, newest first.</p>
          </div>
          {sessions.length > 5 && (
            <button type="button" onClick={onOpenSessions}>
              View all
            </button>
          )}
        </header>

        {recentSessions.length === 0 ? (
          <div className={styles.empty}>
            No interview sessions yet. Your completed and active sessions will appear here.
          </div>
        ) : (
          <div className={styles.sessionList}>
            {recentSessions.map((item) => {
              const canReview =
                (item.status === "COMPLETED" || item.status === "ARCHIVED")
                && isSessionIdAddressableForRead(item.sessionId);
              return (
                <article key={item.sessionId} className={styles.sessionRow}>
                  <div className={styles.sessionIdentity}>
                    <strong>{item.problemId ?? "Configured interview"}</strong>
                    <code>{item.sessionId}</code>
                  </div>
                  <span
                    className={styles.status}
                    data-status={item.status}
                  >
                    {item.status.toLowerCase()}
                  </span>
                  <span className={styles.events}>{item.eventCount} events</span>
                  <time dateTime={item.updatedAt}>
                    {new Date(item.updatedAt).toLocaleDateString([], {
                      month: "short",
                      day: "numeric"
                    })}
                  </time>
                  <button
                    type="button"
                    disabled={item.status !== "ACTIVE" && !canReview}
                    onClick={
                      item.status === "ACTIVE"
                        ? () => void onResumeInterview(item.sessionId)
                        : canReview
                          ? () => onReviewSession(item.sessionId)
                          : undefined
                    }
                  >
                    {item.status === "ACTIVE"
                      ? "Resume"
                      : canReview
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
