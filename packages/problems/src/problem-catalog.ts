import type { InterviewProblem } from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";
import { sixPeopleProblem } from "./six-people.js";
import { hilbertHotelProblem } from "./hilbert-hotel.js";
import { prisonerHatsProblem } from "./prisoner-hats.js";
import { gamblersRuinProblem } from "./gamblers-ruin.js";
import { biasedCoinProblem } from "./biased-coin.js";

export function createProblemCatalog(
  problems: readonly InterviewProblem[]
): readonly InterviewProblem[] {
  const identities = new Set<string>();

  for (const problem of problems) {
    assertInterviewProblemIntegrity(problem);
    const identity = JSON.stringify([problem.id, problem.version]);
    if (identities.has(identity)) {
      throw new Error(
        `Duplicate problem catalog identity "${problem.id}" version "${problem.version}"`
      );
    }
    identities.add(identity);
  }

  return Object.freeze([...problems]);
}

export const ALL_PROBLEMS: readonly InterviewProblem[] = [
  sixPeopleProblem,
  hilbertHotelProblem,
  prisonerHatsProblem,
  gamblersRuinProblem,
  biasedCoinProblem
] as const;

export const problemCatalog = createProblemCatalog(ALL_PROBLEMS);

export function getProblemById(id: string): InterviewProblem | undefined {
  return problemCatalog.find((problem) => problem.id === id);
}

export function getProblemsByTopic(topic: string): readonly InterviewProblem[] {
  const normalized = topic.toLowerCase().trim();
  return problemCatalog.filter((problem) =>
    problem.interviewer.topics.some((t) => t.toLowerCase().includes(normalized))
  );
}

export function getProblemsByDifficulty(difficulty: string): readonly InterviewProblem[] {
  const normalized = difficulty.toLowerCase().trim();
  return problemCatalog.filter(
    (problem) => problem.interviewer.difficulty.toLowerCase() === normalized
  );
}
