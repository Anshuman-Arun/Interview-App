import React, { useEffect, useRef } from "react";
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
  readonly className?: string;
}

export const TranscriptFeed: React.FC<TranscriptFeedProps> = ({
  items,
  onRetry,
  className = ""
}) => {
  const feedEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  };

  return (
    <div
      className={`transcript-feed transcript-feed-container ${className}`}
      data-testid="transcript-feed"
    >
      <header className="transcript-feed__header">
        <div>
          <span className="transcript-feed__index">02 / DIALOGUE</span>
          <strong>Interview transcript</strong>
        </div>
        <span className="transcript-feed__count">
          {items.length} {items.length === 1 ? "entry" : "entries"}
        </span>
      </header>

      <div className="transcript-feed__messages">
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
          items.map((item, index) => {
            const isStudent = item.role === "student";

            return (
              <article
                key={item.id}
                data-testid={`transcript-bubble-${item.id}`}
                className="transcript-entry transcript-message"
                data-role={item.role}
              >
                <div className="transcript-entry__rail">
                  <span className="transcript-entry__number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
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
                          onClick={() => void onRetry(item.id)}
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}

                  <div className="metadata-bar transcript-entry__meta">
                    {item.turnId !== undefined && <span>Turn: {item.turnId}</span>}
                    {item.inputEpisodeId !== undefined && <span>Episode: {item.inputEpisodeId}</span>}
                    {item.deliveryId !== undefined && <span>Delivery: {item.deliveryId}</span>}
                  </div>
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
