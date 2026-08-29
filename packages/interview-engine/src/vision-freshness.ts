import type { BoardObservation } from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";

export type VisionFreshness = "FRESH" | "STALE" | "UNKNOWN";

export function assessVisionFreshness(observation: BoardObservation, state: Readonly<SessionState>): VisionFreshness {
  if (observation.relevantShapeIds.length === 0) return "UNKNOWN";
  return observation.sourceBoardRevision === state.boardRevision ? "FRESH" : "STALE";
}
