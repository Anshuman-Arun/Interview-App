import React, { useEffect, useRef } from "react";
import type {
  DeliveryId,
  InputEpisodeId,
  TurnId
} from "../../../../packages/domain/src/index.js";
import { MathText } from "./MathText.js";
import { DeliveryBadge, type MessageDeliveryStatus } from "./DeliveryBadge.js";
import styles from "./TranscriptFeed.module.css";

export interface TranscriptItem {
  readonly id: string;
  readonly role: "student" | "interviewer";
  readonly text: string;
  readonly status: MessageDeliveryStatus;
  readonly timestamp: number;
  readonly turnId?: TurnId;
  readonly inputEpisodeId?: InputEpisodeId;
  readonly deliveryId?: DeliveryId;
  readonly errorMessage?: string | undefined;
}

export interface TranscriptFeedProps {
  readonly items: readonly TranscriptItem[];
  readonly onRetry?: (itemId: string) => void | Promise<void>;
  readonly className?: string;
}

const STICKY_BOTTOM_THRESHOLD_PX = 80;

function isNormalDeliveryStatus(status: MessageDeliveryStatus): boolean {
  return status === "COMPLETED"
    || status === "ACKNOWLEDGED"
    || status === "VALIDATED"
    || status === "EXPOSED";
}

export const TranscriptFeed: React.FC<TranscriptFeedProps> = ({
  items,
  onRetry,
  className = ""
}) => {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  };

  const handleScroll = (): void => {
    const element = feedRef.current;
    if (element === null) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldStickToBottomRef.current =
      distanceFromBottom <= STICKY_BOTTOM_THRESHOLD_PX;
  };

  return (
    <section
      className={`${styles.transcript ?? ""} ${className}`}
      data-testid="transcript-feed"
      aria-label="Interview transcript"
    >
      <header className={styles.header}>
        <h2 className={styles.heading}>Transcript</h2>
        <span className={styles.count}>
          {items.length} {items.length === 1 ? "entry" : "entries"}
        </span>
      </header>

      <div
        ref={feedRef}
        className={styles.messages}
        onScroll={handleScroll}
      >
        {items.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>The interview dialogue has not started yet.</p>
            <p className={styles.emptyBody}>
              Start the session or submit your initial reasoning step below.
            </p>
          </div>
        ) : (
          items.map((item) => {
            const isStudent = item.role === "student";
            const hasMetadata =
              item.turnId !== undefined
              || item.inputEpisodeId !== undefined
              || item.deliveryId !== undefined;

            return (
              <article
                key={item.id}
                data-testid={`transcript-bubble-${item.id}`}
                className={`${styles.message ?? ""} ${isStudent ? (styles.student ?? "") : (styles.interviewer ?? "")}`}
              >
                <div className={styles.messageHeader}>
                  <span className={styles.speaker}>
                    {isStudent ? "You" : "Interviewer"}
                  </span>
                  <time
                    className={styles.timestamp}
                    dateTime={new Date(item.timestamp).toISOString()}
                  >
                    {formatTimestamp(item.timestamp)}
                  </time>
                  {!isNormalDeliveryStatus(item.status) && (
                    <DeliveryBadge status={item.status} />
                  )}
                </div>

                <div className={styles.messageBody}>
                  <div className={styles.messageContent}>
                    <MathText text={item.text} />
                    {!isStudent && item.status === "DELIVERING" && (
                      <span
                        className={styles.streamingCursor}
                        aria-label="Response streaming"
                      />
                    )}
                  </div>

                  {item.errorMessage !== undefined && (
                    <div className={styles.errorRow} role="status">
                      <span>{item.errorMessage}</span>
                      {onRetry !== undefined && (
                        <button
                          type="button"
                          onClick={() => void onRetry(item.id)}
                          className={styles.retryButton}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {hasMetadata && (
                  <details className={styles.details}>
                    <summary>Details</summary>
                    <div className={styles.metadata}>
                      <span>Status: {item.status}</span>
                      {item.turnId !== undefined && (
                        <span>Turn: {item.turnId}</span>
                      )}
                      {item.inputEpisodeId !== undefined && (
                        <span>Episode: {item.inputEpisodeId}</span>
                      )}
                      {item.deliveryId !== undefined && (
                        <span>Delivery: {item.deliveryId}</span>
                      )}
                    </div>
                  </details>
                )}
              </article>
            );
          })
        )}
        <div ref={feedEndRef} aria-hidden="true" />
      </div>
    </section>
  );
};
