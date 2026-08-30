import React, { useEffect, useRef } from "react";
import type { DeliveryId, InputEpisodeId, TurnId } from "../../../../packages/domain/src/index.js";
import { MathText } from "./MathText.js";
import { DeliveryBadge, type MessageDeliveryStatus } from "./DeliveryBadge.js";

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
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
      className={`transcript-feed-container bg-slate-50/50 border border-slate-200 rounded-lg flex flex-col h-full overflow-hidden ${className}`}
      data-testid="transcript-feed"
    >
      <div className="transcript-feed-header px-4 py-2.5 bg-white border-b border-slate-200 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-2">
          <span>Interview Transcript</span>
          <span className="text-[11px] bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-mono">
            {items.length} {items.length === 1 ? "entry" : "entries"}
          </span>
        </span>
      </div>

      <div className="transcript-feed-messages flex-1 p-4 overflow-y-auto space-y-4">
        {items.length === 0 ? (
          <div className="empty-transcript-state text-center py-12 px-4 text-slate-400">
            <div className="text-3xl mb-2">💬</div>
            <p className="text-sm font-medium text-slate-600">The interview dialogue has not started yet.</p>
            <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
              Start the session or submit your initial reasoning step about Oxford Ramsey $R(3,3)$ below.
            </p>
          </div>
        ) : (
          items.map((item) => {
            const isStudent = item.role === "student";

            return (
              <div
                key={item.id}
                data-testid={`transcript-bubble-${item.id}`}
                className={`transcript-message flex flex-col ${
                  isStudent ? "items-end" : "items-start"
                }`}
              >
                <div className="flex items-center gap-2 mb-1 px-1">
                  <span className="text-[11px] font-semibold text-slate-600">
                    {isStudent ? "Student (You)" : "Socratic Interviewer"}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {formatTimestamp(item.timestamp)}
                  </span>
                  <DeliveryBadge status={item.status} />
                </div>

                <div
                  className={`message-bubble max-w-[85%] rounded-2xl px-4 py-3 shadow-xs text-sm leading-relaxed ${
                    isStudent
                      ? "bg-indigo-600 text-white rounded-br-xs"
                      : "bg-white text-slate-900 border border-slate-200 rounded-bl-xs"
                  }`}
                >
                  <div className={`message-content ${isStudent ? "student-math-bubble" : "ai-math-bubble"}`}>
                    <MathText text={item.text} />
                    {!isStudent && item.status === "DELIVERING" && (
                      <span className="inline-block w-2 h-4 ml-1 bg-indigo-500 animate-pulse align-middle" />
                    )}
                  </div>

                  {item.errorMessage !== undefined && (
                    <div className="mt-2 text-xs bg-rose-50 text-rose-700 p-2 rounded border border-rose-200 flex items-center justify-between gap-2">
                      <span>Error: {item.errorMessage}</span>
                      {onRetry !== undefined && (
                        <button
                          type="button"
                          onClick={() => void onRetry(item.id)}
                          className="px-2 py-0.5 bg-rose-600 text-white font-medium rounded text-[11px] hover:bg-rose-700 cursor-pointer"
                        >
                          Retry
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="metadata-bar mt-1 px-1 text-[10px] text-slate-400 font-mono flex items-center gap-2">
                  {item.turnId !== undefined && <span>Turn: {item.turnId}</span>}
                  {item.inputEpisodeId !== undefined && <span>Episode: {item.inputEpisodeId}</span>}
                  {item.deliveryId !== undefined && <span>Delivery: {item.deliveryId}</span>}
                </div>
              </div>
            );
          })
        )}
        <div ref={feedEndRef} />
      </div>
    </div>
  );
};
