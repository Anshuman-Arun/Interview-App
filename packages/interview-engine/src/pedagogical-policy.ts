import type { RealizationRequest } from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";

export function selectPedagogicalAction(state: Readonly<SessionState>, turnId: string): RealizationRequest {
  const turn = state.turns[turnId];
  if (turn === undefined) throw new Error(`Unknown turn ${turnId}`);
  return {
    requiredAction: "PROBE_JUSTIFICATION",
    target: "the student's most recent asserted step",
    maximumDisclosure: 0
  };
}

