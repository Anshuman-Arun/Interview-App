import React from "react";
import type { InterviewProblemPublicView } from "../../../../packages/domain/src/index.js";
import { MathText } from "./MathText.js";

export interface ProblemCardProps {
  readonly problem?: InterviewProblemPublicView | null;
  readonly className?: string;
}

export const ProblemCard: React.FC<ProblemCardProps> = ({
  problem = null,
  className = ""
}) => {
  if (problem === null) {
    return (
      <div
        className={`problem-card-container bg-white border border-slate-200 rounded-lg p-5 shadow-sm ${className}`}
        data-testid="problem-card"
      >
        <div className="text-sm text-slate-500">
          No Oxford Mathematics problem is bound to this session.
        </div>
      </div>
    );
  }

  return (
    <article
      className={`problem-card-container bg-white border border-slate-200 rounded-lg p-5 shadow-sm ${className}`}
      data-testid="problem-card"
    >
      <header className="problem-header">
        <div className="problem-header__eyebrow">
          <span>Interview problem</span>
          <span>{problem.difficulty}</span>
        </div>
        <h2>{problem.title}</h2>
      </header>

      <div className="problem-statement">
        <MathText text={problem.prompt} />
      </div>

      {problem.givenInformation.length > 0 && (
        <section className="given-information">
          <h3>Given information</h3>
          <ul>
            {problem.givenInformation.map((info, index) => (
              <li key={`given-${String(index)}`}>
                <MathText text={info} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
};
