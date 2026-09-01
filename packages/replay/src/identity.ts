import type { EvidenceKey } from "../../domain/src/index.js";

function evidenceSubjectId(key: EvidenceKey): string {
  switch (key.subject.kind) {
    case "CLAIM":
      return key.subject.claimId;
    case "MILESTONE":
      return key.subject.milestoneId;
    case "SKILL":
      return key.subject.skillId;
    case "APPROACH":
      return key.subject.approachId;
  }
}

export function replayEvidenceIdentity(key: EvidenceKey): string {
  return JSON.stringify([
    key.problemId,
    key.subject.kind,
    evidenceSubjectId(key),
    key.dimension
  ]);
}

export function replayProblemIdentity(problemId: string, problemVersion: string): string {
  return JSON.stringify([problemId, problemVersion]);
}


/**
 * Deterministic UTF-16 code-unit ordering. Unlike localeCompare(), this does not
 * depend on host locale or ICU data and is therefore stable across replay hosts.
 */
export function compareReplayStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
