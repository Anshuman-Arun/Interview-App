import type { Compatibility, GenerationBasis } from "../../domain/src/index.js";
import type { SessionState } from "../../events/src/index.js";
import { isGenerationBasisStillCompatible } from "./compatibility.js";

/**
 * Verification is strict by default and therefore depends on the full basis.
 * A narrowly authorized committed-turn text request may explicitly declare
 * board-revision independence. That exception ignores only boardRevision;
 * all text/config/problem/turn provenance remains fail-closed.
 */
export function isVerificationBasisStillCompatible(
  basis: GenerationBasis,
  current: Readonly<SessionState>,
  boardRevisionIndependent = false
): Compatibility {
  if (!boardRevisionIndependent) {
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
