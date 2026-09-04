import React, { useEffect, useRef, useState } from "react";
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
  readonly scrollContextKey?: string | null;
  readonly focused?: boolean;
  readonly onToggleFocus?: (() => void) | undefined;
}

export const TranscriptFeed: React.FC<TranscriptFeedProps> = ({
  items,
  onRetry,
  retryDisabled = false,
  className = "",
  scrollContextKey = null,
  focused = false,
  onToggleFocus
}) => {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const previousScrollContextKeyRef = useRef<string | null>(scrollContextKey);
  const [showJump, setShowJump] = useState(false);

  const scrollToLatest = (): void => {
    const node = messagesRef.current;
    if (node === null) return;
    followingRef.current = true;
    setShowJump(false);
    node.scrollTo({ top: node.scrollHeight });
  };

  useEffect(() => {
    const node = messagesRef.current;
    if (node === null) return;

    if (previousScrollContextKeyRef.current !== scrollContextKey) {
      previousScrollContextKeyRef.current = scrollContextKey;
      followingRef.current = true;
      setShowJump(false);
      node.scrollTo({ top: items.length === 0 ? 0 : node.scrollHeight });
      return;
    }

    if (items.length === 0) {
      followingRef.current = true;
      setShowJump(false);
      node.scrollTo({ top: 0 });
      return;
    }

    if (followingRef.current) {
      node.scrollTo({ top: node.scrollHeight });
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [items, scrollContextKey]);

  useEffect(() => {
    const node = messagesRef.current;
    if (node === null || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      if (!followingRef.current) return;
      node.scrollTo({ top: node.scrollHeight });
      setShowJump(false);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleScroll = (): void => {
    const node = messagesRef.current;
    if (node === null) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 36;
    followingRef.current = nearBottom;
    setShowJump(!nearBottom);
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className={`transcript-feed transcript-feed-container ${className}`} data-testid="transcript-feed">
      <header className="transcript-feed__header">
        <strong>Conversation</strong>
        <div className="transcript-feed__header-actions">
          <span className="transcript-feed__count">
            {items.length} {items.length === 1 ? "entry" : "entries"} · live transcript
          </span>
          {showJump && (
            <button type="button" className="transcript-feed__jump" onClick={scrollToLatest}>
              Jump to latest ↓
            </button>
          )}
          {onToggleFocus !== undefined && (
            <button
              type="button"
              className="transcript-feed__focus"
              onClick={onToggleFocus}
              aria-label={focused ? "Restore split view" : "Focus transcript"}
              title={focused ? "Restore split view" : "Focus transcript"}
            >
              {focused ? "↔" : "⤢"}
            </button>
          )}
        </div>
      </header>

      <div className="transcript-feed__messages" ref={messagesRef} onScroll={handleScroll}>
        {items.length === 0 ? (
          <div className="transcript-feed__empty">
            <span className="transcript-feed__empty-index">00</span>
            <div>
              <p>The interview dialogue has not started yet.</p>
              <span>Start the session, then explain the first thing you know rather than waiting for a perfect proof.</span>
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
                  <span
                    className="transcript-entry__speaker"
                    aria-label={isStudent ? "Student (You)" : "Socratic Interviewer"}
                  >
                    {isStudent ? "YOU" : "INTERVIEWER"}
                  </span>
                </div>
                <div className="transcript-entry__body">
                  <div className={isStudent ? "message-content student-math-bubble" : "message-content ai-math-bubble"}>
                    <MathText text={item.text} />
                    {!isStudent && item.status === "DELIVERING" && <span className="transcript-entry__streaming" aria-label="Responding">▌</span>}
                  </div>
                  <div className="transcript-entry__meta">
                    <time dateTime={new Date(item.timestamp).toISOString()}>{formatTimestamp(item.timestamp)}</time>
                    <DeliveryBadge status={item.status} />
                  </div>
                  {item.errorMessage !== undefined && (
                    <div className="transcript-entry__error" role="status">
                      <span>Error: {item.errorMessage}</span>
                      {onRetry !== undefined && <button type="button" disabled={retryDisabled} onClick={() => { if (!retryDisabled) void onRetry(item.id); }}>Retry</button>}
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
};
