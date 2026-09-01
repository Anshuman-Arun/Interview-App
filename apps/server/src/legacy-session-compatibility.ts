import {
  InterviewSessionConfigurationSchema,
  type InterviewSessionConfiguration
} from "../../../packages/domain/src/index.js";
import {
  getProblemById,
  getProblemMetadataById
} from "../../../packages/problems/src/index.js";

/**
 * Compatibility for protocol-v1 callers that predate explicit session
 * configuration. This is intentionally the only production location that
 * selects the historical Ramsey demo implicitly.
 */
export function createLegacyDefaultSessionConfiguration(
  legacyProblemId?: string
): InterviewSessionConfiguration {
  const expectedId = "oxford-six-people";
  if (legacyProblemId !== undefined && legacyProblemId !== expectedId) {
    throw new Error("Legacy START_SESSION supports only the historical Ramsey problem");
  }
  const problem = getProblemById(expectedId);
  const metadata = getProblemMetadataById(expectedId);
  if (
    problem === undefined
    || metadata?.mode !== "OXFORD_MATHEMATICS"
    || metadata.reviewStatus !== "ready"
  ) {
    throw new Error("Legacy Ramsey problem is not available");
  }
  return InterviewSessionConfigurationSchema.parse({
    configurationVersion: 1,
    mode: "OXFORD_MATHEMATICS",
    problem: { id: problem.id, version: problem.version },
    difficulty: problem.interviewer.difficulty,
    interventionPolicy: "BALANCED"
  });
}
