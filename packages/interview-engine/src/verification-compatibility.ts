import type { Compatibility, GenerationBasis } from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";

/**
 * Generation-bound verification depends on the full model basis. Direct
 * committed-turn verification is text-source work, so an unrelated board
 * revision does not invalidate it. New turns, transcript/config/problem
 * changes, and missing source provenance still fail closed.
 */
export function isVerificationBasisStillCompatible(
  basis: GenerationBasis,
  current: Readonly<SessionState>,
  sourceGenerationId?: string
): Compatibility {
  if (sourceGenerationId !== undefined) {
    return isGenerationBasisStillCompatible(basis, current);
  }

  const turn = current.turns[basis.turnId];
  if (turn === undefined || current.lastCommittedInputSequence === undefined) return "UNKNOWN";
  if (basis.inputEpisodeId === undefined) return "UNKNOWN";
  const episode = current.inputEpisodes[basis.inputEpisodeId];
  if (episode === undefined) return "UNKNOWN";
  if (turn.inputEpisodeId !== basis.inputEpisodeId) return "INCOMPATIBLE";

  if (
    basis.contextEpoch !== current.contextEpoch
    || basis.committedInputSequence !== current.lastCommittedInputSequence
    || basis.transcriptRevision !== current.transcriptRevision
    || basis.problemStateRevision !== current.problemStateRevision
    || basis.policyRevision !== current.policyRevision
  ) return "INCOMPATIBLE";

  return "COMPATIBLE";
}
