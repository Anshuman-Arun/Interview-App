import type { EventDraft, SessionState } from "../../events/src/index.js";

export function invalidateUndeliveredPolicyOutput(
  state: Readonly<SessionState>,
  reason: string
): readonly EventDraft[] {
  const staleGenerationIds = new Set(
    Object.values(state.generations)
      .filter((generation) =>
        generation.status === "ACTIVE"
        || generation.status === "PROPOSAL_RECEIVED"
        || generation.status === "VALIDATED"
      )
      .map((generation) => generation.generationId)
  );

  const drafts: EventDraft[] = [];
  for (const generationId of staleGenerationIds) {
    drafts.push({
      source: "APPLICATION",
      type: "MODEL_GENERATION_SUPERSEDED",
      payload: { generationId, reason }
    });
  }

  for (const atom of Object.values(state.deliveries)) {
    if (!staleGenerationIds.has(atom.generationId)) continue;
    if (atom.status === "QUEUED") {
      drafts.push({
        source: "APPLICATION",
        type: "DELIVERY_CANCELLED",
        payload: { deliveryId: atom.deliveryId, reason }
      });
    } else if (atom.status === "DELIVERING") {
      drafts.push({
        source: "RECOVERY",
        type: "DELIVERY_POSSIBLY_EXPOSED",
        payload: {
          deliveryId: atom.deliveryId,
          reason: `${reason}; physical exposure was already in progress`
        }
      });
    }
  }

  return drafts;
}
