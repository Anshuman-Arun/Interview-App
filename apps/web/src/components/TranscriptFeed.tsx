import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DeliveryId, InputEpisodeId, TurnId } from "../../../../packages/domain/src/index.js";
import { MathText } from "./MathText.js";
import { DeliveryBadge, type MessageDeliveryStatus } from "./DeliveryBadge.js";
import "./TranscriptFeed.css";

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
  readonly retryDisabled?: boolean;
  readonly className?: string;
}

export const TranscriptFeed: React.FC<TranscriptFeedProps> = ({
  items,
  onRetry,
  retryDisabled = false,
  className = ""
}) => {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [showJumpLatest, setShowJumpLatest] = useState(false);

  const updateFollowState = useCallback((): void => {
    const viewport = messagesRef.current;
    if (viewport === null) return;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const nearBottom = distanceFromBottom <= 48;
    setFollowLatest(nearBottom);
    setShowJumpLatest(distanceFromBottom > 88);
  }, []);

  const jumpToLatest = useCallback((): void => {
    const viewport = messagesRef.current;
    if (viewport !== null) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      feedEndRef.current?.scrollIntoView({ block: "end" });
    }
    setFollowLatest(true);
    setShowJumpLatest(false);
  }, []);

  useEffect(() => {
    if (!followLatest) return;
    jumpToLatest();
  }, [followLatest, items, jumpToLatest]);

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div
      className={`transcript-feed transcript-feed-container ${className}`}
      data-testid="transcript-feed"
    >
      <header className="transcript-feed__header">
        <strong>Transcript</strong>
        <div className="transcript-feed__header-actions">
          {showJumpLatest && (
            <button type="button" onClick={jumpToLatest}>
              Jump to latest
            </button>
          )}
          <span className="transcript-feed__count">
            {items.length} {items.length === 1 ? "entry" : "entries"}
          </span>
        </div>
      </header>

      <div
        ref={messagesRef}
        className="transcript-feed__messages"
        onScroll={updateFollowState}
      >
        {items.length === 0 ? (
          <div className="transcript-feed__empty">
            <span className="transcript-feed__empty-index">00</span>
            <div>
              <p>The interview dialogue has not started yet.</p>
              <span>
                Start the session, then explain the first thing you know rather than
                waiting for a perfect proof.
              </span>
            </div>
          </div>
        ) : (
          items.map((item) => {
            const isStudent = item.role === "student";

            return (
              <article
                key={item.id}
                data-testid={`transcript-bubble-${item.id}`}
                className="transcript-entry transcript-message"
                data-role={item.role}
              >
                <div className="transcript-entry__rail">
                  <span className="transcript-entry__speaker">
                    {isStudent ? "Student (You)" : "Socratic Interviewer"}
                  </span>
                  <time dateTime={new Date(item.timestamp).toISOString()}>
                    {formatTimestamp(item.timestamp)}
                  </time>
                  <DeliveryBadge status={item.status} />
                </div>

                <div className="transcript-entry__body">
                  <div
                    className={
                      isStudent
                        ? "message-content student-math-bubble"
                        : "message-content ai-math-bubble"
                    }
                  >
                    <MathText text={item.text} />
                    {!isStudent && item.status === "DELIVERING" && (
                      <span className="transcript-entry__streaming" aria-label="Responding">
                        ▌
                      </span>
                    )}
                  </div>

                  {item.errorMessage !== undefined && (
                    <div className="transcript-entry__error" role="status">
                      <span>Error: {item.errorMessage}</span>
                      {onRetry !== undefined && (
                        <button
                          type="button"
                          disabled={retryDisabled}
                          onClick={() => {
                            if (!retryDisabled) void onRetry(item.id);
                          }}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
        <div ref={feedEndRef} />
      </div>
    </div>
  );
};
