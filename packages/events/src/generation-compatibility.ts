import type { Compatibility, GenerationBasis } from "../../domain/src/index.js";
import type { SessionState } from "./state.js";

export function isGenerationBasisStillCompatible(
  basis: GenerationBasis,
  current: Readonly<SessionState>
): Compatibility {
  const turn = current.turns[basis.turnId];
  if (turn === undefined || current.lastCommittedInputSequence === undefined) return "UNKNOWN";
  if (basis.inputEpisodeId !== undefined) {
    const episode = current.inputEpisodes[basis.inputEpisodeId];
    if (episode === undefined) return "UNKNOWN";
    if (turn.inputEpisodeId !== basis.inputEpisodeId) return "INCOMPATIBLE";
  }
  if (
    basis.contextEpoch !== current.contextEpoch
    || basis.committedInputSequence !== current.lastCommittedInputSequence
    || basis.transcriptRevision !== current.transcriptRevision
    || basis.boardRevision !== current.boardRevision
    || basis.problemStateRevision !== current.problemStateRevision
    || basis.policyRevision !== current.policyRevision
  ) return "INCOMPATIBLE";
  return "COMPATIBLE";
}
