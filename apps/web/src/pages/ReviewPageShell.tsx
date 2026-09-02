import type { ReactNode } from "react";
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
          type="button"
          role="tab"
          aria-selected={view === "evaluation"}
          onClick={() => onViewChange("evaluation")}
        >
          <span>01</span>
          Evaluation
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "replay"}
          onClick={() => onViewChange("replay")}
        >
          <span>02</span>
          Replay
        </button>
      </div>

      <section className="expressive-review__content" role="tabpanel">
        {view === "evaluation" ? evaluation : replay}
      </section>
    </div>
  );
}
