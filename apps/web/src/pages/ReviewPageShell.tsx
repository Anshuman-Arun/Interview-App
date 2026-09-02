import { useRef, type KeyboardEvent, type ReactNode } from "react";
import type { SessionId } from "../../../../packages/domain/src/index.js";
import "./ReviewPageShell.css";

export type ReviewView = "evaluation" | "replay";

export function ReviewPageShell({
  sessionId,
  view,
  onViewChange,
  onBack,
  evaluation,
  replay
}: {
  readonly sessionId: SessionId;
  readonly view: ReviewView;
  readonly onViewChange: (view: ReviewView) => void;
  readonly onBack: () => void;
  readonly evaluation: ReactNode;
  readonly replay: ReactNode;
}) {
  const evaluationRef = useRef<HTMLButtonElement | null>(null);
  const replayRef = useRef<HTMLButtonElement | null>(null);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: ReviewView = view === "evaluation" ? "replay" : "evaluation";
    onViewChange(next);
    queueMicrotask(() => {
      if (next === "evaluation") evaluationRef.current?.focus();
      else replayRef.current?.focus();
    });
  };

  return (
    <div className="expressive-review">
      <header className="expressive-review__hero">
        <button type="button" onClick={onBack}>← Sessions</button>
        <div>
          <span>POST-INTERVIEW</span>
          <h2>Review the reasoning, not just the score.</h2>
        </div>
        <code>{sessionId}</code>
      </header>

      <div className="expressive-review__tabs" role="tablist" aria-label="Review view">
        <button
          ref={evaluationRef}
          id="review-tab-evaluation"
          type="button"
          role="tab"
          aria-selected={view === "evaluation"}
          aria-controls="review-panel"
          tabIndex={view === "evaluation" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => onViewChange("evaluation")}
        >
          <span>01</span>
          Evaluation
        </button>
        <button
          ref={replayRef}
          id="review-tab-replay"
          type="button"
          role="tab"
          aria-selected={view === "replay"}
          aria-controls="review-panel"
          tabIndex={view === "replay" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => onViewChange("replay")}
        >
          <span>02</span>
          Replay
        </button>
      </div>

      <section
        id="review-panel"
        className="expressive-review__content"
        role="tabpanel"
        aria-labelledby={
          view === "evaluation" ? "review-tab-evaluation" : "review-tab-replay"
        }
      >
        {view === "evaluation" ? evaluation : replay}
      </section>
    </div>
  );
}
