import React, { useState } from "react";
import type { InterviewProblem } from "../../../../packages/domain/src/index.js";
import { sixPeopleProblem } from "../../../../packages/problems/src/index.js";
import { MathText } from "./MathText.js";

export interface ProblemCardProps {
  readonly problem?: InterviewProblem | null;
  readonly className?: string;
}

export const ProblemCard: React.FC<ProblemCardProps> = ({
  problem = sixPeopleProblem,
  className = ""
}) => {
  const [showApproaches, setShowApproaches] = useState(false);
  const activeProblem = problem ?? sixPeopleProblem;

  const tags = [
    { label: "Ramsey Theory", math: "$R(3,3) = 6$" },
    { label: "Complete Graph", math: "$K_6$" },
    { label: "Vertex Count", math: "$|V| = 6$" },
    { label: "Degree", math: "$\\deg(v) = 5$" },
    { label: "Pigeonhole Principle", math: "$\\lceil 5/2 \\rceil = 3$" }
  ];

  return (
    <div
      className={`problem-card-container bg-white border border-slate-200 rounded-lg p-5 shadow-sm ${className}`}
      data-testid="problem-card"
    >
      <div className="problem-header mb-3 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
            {activeProblem.interviewer.difficulty}
          </span>
          <h2 className="text-xl font-bold text-slate-900 mt-2">
            Oxford Mathematics: Ramsey Theorem <MathText text="$R(3,3) = 6$" />
          </h2>
        </div>
        <div className="text-xs text-slate-500 font-mono">
          ID: {activeProblem.id}
        </div>
      </div>

      <div className="problem-statement mb-4 bg-slate-50 p-4 rounded-md border border-slate-100 text-slate-800 leading-relaxed">
        <p className="font-medium text-slate-900 mb-1">Problem Statement:</p>
        <div className="text-base">
          <MathText text={activeProblem.public.prompt} />
        </div>
      </div>

      {activeProblem.public.givenInformation.length > 0 && (
        <div className="given-information mb-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Given Information
          </h3>
          <ul className="list-disc list-inside text-sm text-slate-700 space-y-1 bg-amber-50/50 p-3 rounded border border-amber-100/80">
            {activeProblem.public.givenInformation.map((info, idx) => (
              <li key={idx}>
                <MathText text={info} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="problem-tags mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
          Mathematical Formulations & Concepts
        </h3>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1.5 text-xs bg-slate-100 text-slate-800 px-2.5 py-1 rounded-md border border-slate-200"
            >
              <span className="font-medium">{tag.label}:</span>
              <MathText text={tag.math} />
            </span>
          ))}
          {activeProblem.interviewer.topics.map((topic, idx) => (
            <span
              key={`topic-${String(idx)}`}
              className="inline-flex items-center text-xs bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md border border-indigo-100 capitalize"
            >
              {topic}
            </span>
          ))}
        </div>
      </div>

      {activeProblem.interviewer.reasoningGraph.approaches.length > 0 && (
        <div className="approaches-drawer mt-3 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={() => setShowApproaches((prev) => !prev)}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 focus:outline-none"
            data-testid="toggle-approaches-btn"
          >
            <span>{showApproaches ? "▼ Hide Formulation Approaches" : "▶ View Formulation Approaches"}</span>
            <span className="text-slate-400 font-normal">
              ({activeProblem.interviewer.reasoningGraph.approaches.length} canonical approaches)
            </span>
          </button>

          {showApproaches && (
            <div className="mt-2 text-xs text-slate-600 space-y-1 bg-slate-50 p-2.5 rounded border border-slate-200" data-testid="approaches-list">
              {activeProblem.interviewer.reasoningGraph.approaches.map((app) => (
                <div key={app.id} className="flex items-center gap-2">
                  <span className="font-mono text-indigo-700 font-semibold">• {app.label}</span>
                  <span className="text-slate-400 font-mono text-[10px]">({app.id})</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
