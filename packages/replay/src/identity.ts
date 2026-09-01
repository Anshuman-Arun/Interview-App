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
