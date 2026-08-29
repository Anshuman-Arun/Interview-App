import type { InterviewProblem } from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";
import { sixPeopleProblem } from "./six-people.js";

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

export const problemCatalog = createProblemCatalog([sixPeopleProblem]);
