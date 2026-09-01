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
    <div
      className={`problem-card-container bg-white border border-slate-200 rounded-lg p-5 shadow-sm ${className}`}
      data-testid="problem-card"
    >
      <div className="problem-header mb-3 flex items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
              {problem.difficulty}
            </span>
            <span className="text-xs font-medium text-slate-600 bg-slate-100 px-2.5 py-1 rounded-full">
              {problem.category}
            </span>
          </div>
          <h2 className="text-xl font-bold text-slate-900 mt-2">
            {problem.title}
          </h2>
        </div>
        <div className="text-xs text-slate-500 font-mono text-right">
          <div>ID: {problem.id}</div>
          <div>v{problem.version}</div>
        </div>
      </div>

      <div className="problem-statement mb-4 bg-slate-50 p-4 rounded-md border border-slate-100 text-slate-800 leading-relaxed">
        <p className="font-medium text-slate-900 mb-1">Problem Statement:</p>
        <div className="text-base">
          <MathText text={problem.prompt} />
        </div>
      </div>

      {problem.givenInformation.length > 0 && (
        <div className="given-information mb-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Given Information
          </h3>
          <ul className="list-disc list-inside text-sm text-slate-700 space-y-1 bg-amber-50/50 p-3 rounded border border-amber-100/80">
            {problem.givenInformation.map((info, idx) => (
              <li key={idx}>
                <MathText text={info} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {problem.topics.length > 0 && (
        <div className="problem-tags">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Topics
          </h3>
          <div className="flex flex-wrap gap-2">
            {problem.topics.map((topic, idx) => (
              <span
                key={`topic-${String(idx)}`}
                className="inline-flex items-center text-xs bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md border border-indigo-100 capitalize"
              >
                {topic}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
