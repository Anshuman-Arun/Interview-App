import { describe, expect, it } from "vitest";
import {
  DeliveryIdSchema,
  DisclosureIdSchema,
  EventIdSchema,
  GenerationIdSchema,
  RequestIdSchema,
  TurnIdSchema,
  evidenceKeyToString,
  newSessionId,
  zeroBoardRevision,
  zeroContextEpoch,
  zeroPolicyRevision,
  zeroProblemStateRevision,
  zeroTranscriptRevision,
  type DeliveryAtom,
  type EvidenceKey,
  type EvidenceRating,
  type EvaluationRubric
} from "../packages/domain/src/index.js";
import {
  initialSessionState,
  type EvidenceRecordState,
  type SessionState
} from "../packages/events/src/index.js";
import {
  evaluateInterviewSession,
  generateEvaluationMarkdown
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";

const chooseDisclosure = DisclosureIdSchema.parse("disclosure_choose_person_pigeonhole");

describe("grounded session evaluator", () => {
  it("abstains for an empty session instead of fabricating a score", () => {
    const evaluation = evaluateInterviewSession(
      initialSessionState(newSessionId()),
      sixPeopleProblem,
      {},
      { evaluatedAt: "2026-08-31T20:00:00.000Z" }
    );

    expect(evaluation.scores.compositeScore).toBeNull();
    expect(evaluation.scores.technicalCorrectness).toBeNull();
    expect(evaluation.scores.rigor).toBeNull();
    expect(evaluation.scores.communication).toBeNull();
    expect(evaluation.lifecycle.completionState).toBe("NOT_STARTED");
    expect(evaluation.milestones.every((item) => !item.achieved)).toBe(true);
    expect(evaluation.keyStrengths).toEqual([]);
  });

  it("regression: turn count and word count do not create achievement, rigor, or communication evidence", () => {
    const one = withTurns(initialSessionState(newSessionId()), 1, "short");
    const many = withTurns(
      initialSessionState(newSessionId()),
      25,
      Array.from({ length: 100 }, () => "word").join(" ")
    );

    const first = evaluateInterviewSession(one, sixPeopleProblem);
    const second = evaluateInterviewSession(many, sixPeopleProblem);

    expect(first.milestones.every((item) => !item.achieved)).toBe(true);
    expect(second.milestones.every((item) => !item.achieved)).toBe(true);
    expect(first.scores.rigor).toBeNull();
    expect(second.scores.rigor).toBeNull();
    expect(first.scores.communication).toBeNull();
    expect(second.scores.communication).toBeNull();
  });

  it("uses only active scoped evidence for milestone achievement", () => {
    let active = initialSessionState(newSessionId());
    active = setHistory(active, milestoneKey("model-relations", "PROGRESS"), [
      { value: "COMPLETE", sequence: 10, status: "ACTIVE" }
    ]);
    expect(milestone(evaluateInterviewSession(active, sixPeopleProblem), "model-relations").achieved)
      .toBe(true);

    let stale = initialSessionState(newSessionId());
    stale = setHistory(stale, milestoneKey("model-relations", "PROGRESS"), [
      { value: "COMPLETE", sequence: 5, status: "STALE" }
    ]);
    expect(milestone(evaluateInterviewSession(stale, sixPeopleProblem), "model-relations").achieved)
      .toBe(false);

    let contradicted = active;
    contradicted = setHistory(contradicted, milestoneKey("model-relations", "CORRECTNESS"), [
      { value: "STRUCTURAL_ERROR", sequence: 11, status: "ACTIVE" }
    ]);
    expect(milestone(evaluateInterviewSession(contradicted, sixPeopleProblem), "model-relations").achieved)
      .toBe(false);
  });

  it("grounds correctness in accepted verifier results and abstains on unresolved verification", () => {
    const verifiedKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "verified-claim" },
      dimension: "CORRECTNESS"
    };
    const contradictedKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "contradicted-claim" },
      dimension: "CORRECTNESS"
    };
    let mixed = initialSessionState(newSessionId());
    mixed = withVerification(mixed, verifiedKey, "VERIFIED", 10, "verified");
    mixed = withVerification(mixed, contradictedKey, "CONTRADICTED", 20, "contradicted");
    expect(evaluateInterviewSession(mixed, sixPeopleProblem).scores.technicalCorrectness).toBe(50);

    const unresolved = withVerification(
      initialSessionState(newSessionId()),
      verifiedKey,
      "UNRESOLVED",
      10,
      "unresolved"
    );
    expect(evaluateInterviewSession(unresolved, sixPeopleProblem).scores.technicalCorrectness)
      .toBeNull();
  });

  it("scores rigor from justification evidence, not from verification-request count", () => {
    let rigorous = initialSessionState(newSessionId());
    rigorous = setHistory(rigorous, milestoneKey("model-relations", "JUSTIFICATION"), [
      { value: "JUSTIFIED", sequence: 10, status: "ACTIVE" }
    ]);
    expect(evaluateInterviewSession(rigorous, sixPeopleProblem).scores.rigor).toBe(100);

    const pending = withPendingVerification(
      withTurns(initialSessionState(newSessionId()), 20, "not evidence"),
      milestoneKey("model-relations", "CORRECTNESS"),
      30,
      "pending"
    );
    const evaluation = evaluateInterviewSession(pending, sixPeopleProblem);
    expect(evaluation.scores.rigor).toBeNull();
    expect(evaluation.scores.technicalCorrectness).toBeNull();
  });

  it("deduplicates repeated exposure and ignores queued or cancelled assistance", () => {
    let state = completeMilestone(initialSessionState(newSessionId()), "choose-vertex", 20);
    state = withDelivery(state, chooseDisclosure, 2, "EXPOSED", 5, "first");
    state = withDelivery(state, chooseDisclosure, 2, "COMPLETED", 5, "repeat");
    state = withDelivery(state, chooseDisclosure, 4, "CANCELLED", 4, "cancelled");
    state = withDelivery(state, chooseDisclosure, 4, "QUEUED", 4, "queued");

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.disclosedInterventions).toHaveLength(2);
    expect(milestone(evaluation, "choose-vertex").assistanceDisclosureIds).toEqual([chooseDisclosure]);
    expect(evaluation.scores.independence).toBe(75);
  });

  it("treats POSSIBLY_EXPOSED assistance conservatively and does not penalize provably later hints", () => {
    let uncertain = completeMilestone(initialSessionState(newSessionId()), "choose-vertex", 20);
    uncertain = withDelivery(uncertain, chooseDisclosure, 2, "POSSIBLY_EXPOSED", 5, "possible");
    const uncertainEvaluation = evaluateInterviewSession(uncertain, sixPeopleProblem);
    expect(uncertainEvaluation.scores.independence).toBe(75);
    expect(uncertainEvaluation.disclosedInterventions[0]?.deliveryStatus).toBe("POSSIBLY_EXPOSED");

    let late = completeMilestone(initialSessionState(newSessionId()), "choose-vertex", 10);
    late = withDelivery(late, chooseDisclosure, 2, "EXPOSED", 20, "late");
    expect(evaluateInterviewSession(late, sixPeopleProblem).scores.independence).toBe(100);
  });

  it("scores error recovery only from actual evidence transitions", () => {
    const key = milestoneKey("model-relations", "CORRECTNESS");
    let recovered = initialSessionState(newSessionId());
    recovered = setHistory(recovered, key, [
      { value: "LOCAL_ERROR", sequence: 10, status: "SUPERSEDED" },
      { value: "CORRECT", sequence: 20, status: "ACTIVE" }
    ]);
    expect(evaluateInterviewSession(recovered, sixPeopleProblem).scores.errorRecovery).toBe(100);

    let unresolved = initialSessionState(newSessionId());
    unresolved = setHistory(unresolved, key, [
      { value: "LOCAL_ERROR", sequence: 10, status: "SUPERSEDED" },
      { value: "STRUCTURAL_ERROR", sequence: 20, status: "ACTIVE" }
    ]);
    expect(evaluateInterviewSession(unresolved, sixPeopleProblem).scores.errorRecovery).toBe(0);

    expect(evaluateInterviewSession(withTurns(initialSessionState(newSessionId()), 40, "turn"), sixPeopleProblem)
      .scores.errorRecovery).toBeNull();
  });

  it("renormalizes partial composites and rejects malformed rubrics", () => {
    let state = initialSessionState(newSessionId());
    state = setHistory(state, milestoneKey("model-relations", "CORRECTNESS"), [
      { value: "CORRECT", sequence: 10, status: "ACTIVE" }
    ]);
    const rubric: EvaluationRubric = {
      correctnessWeight: 0.5,
      rigorWeight: 0,
      independenceWeight: 0,
      communicationWeight: 0.5,
      errorRecoveryWeight: 0
    };
    const evaluation = evaluateInterviewSession(state, sixPeopleProblem, rubric);
    expect(evaluation.scores.technicalCorrectness).toBe(100);
    expect(evaluation.scores.communication).toBeNull();
    expect(evaluation.scores.compositeScore).toBe(100);
    expect(evaluation.composite.status).toBe("PARTIAL");

    expect(() => evaluateInterviewSession(state, sixPeopleProblem, {
      correctnessWeight: 1,
      rigorWeight: 1,
      independenceWeight: 0,
      communicationWeight: 0,
      errorRecoveryWeight: 0
    })).toThrow("weights must sum to 1");
  });

  it("is deterministic, timestamp-independent for scoring, and omits raw private content", () => {
    let state = completeMilestone(initialSessionState(newSessionId()), "choose-vertex", 20);
    state = withTurns(state, 1, "PRIVATE_TRANSCRIPT_SENTINEL");
    state = withDelivery(
      state,
      chooseDisclosure,
      2,
      "EXPOSED",
      5,
      "privacy",
      "PRIVATE_HINT_SENTINEL"
    );
    const before = JSON.stringify(state);
    const first = evaluateInterviewSession(state, sixPeopleProblem, {}, {
      evaluatedAt: "2026-08-31T20:00:00.000Z"
    });
    const second = evaluateInterviewSession(state, sixPeopleProblem, {}, {
      evaluatedAt: "2026-08-31T21:00:00.000Z"
    });

    expect({ ...first, evaluatedAt: "ignored" }).toEqual({ ...second, evaluatedAt: "ignored" });
    expect(JSON.stringify(state)).toBe(before);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(sixPeopleProblem.private.canonicalSolution);
    expect(serialized).not.toContain("PRIVATE_TRANSCRIPT_SENTINEL");
    expect(serialized).not.toContain("PRIVATE_HINT_SENTINEL");

    const markdown = generateEvaluationMarkdown(first);
    expect(markdown).toContain("Support");
    expect(markdown).not.toContain("PRIVATE_HINT_SENTINEL");
  });
});

function milestone(
  evaluation: ReturnType<typeof evaluateInterviewSession>,
  milestoneId: string
) {
  const item = evaluation.milestones.find((candidate) => candidate.milestoneId === milestoneId);
  if (item === undefined) throw new Error("Expected milestone evaluation");
  return item;
}

function milestoneKey(
  milestoneId: string,
  dimension: EvidenceKey["dimension"]
): EvidenceKey {
  return {
    problemId: sixPeopleProblem.id,
    subject: { kind: "MILESTONE", milestoneId },
    dimension
  };
}

function setHistory(
  state: SessionState,
  key: EvidenceKey,
  specs: readonly {
    readonly value: EvidenceRating;
    readonly sequence: number;
    readonly status: EvidenceRecordState["status"];
  }[]
): SessionState {
  const keyString = evidenceKeyToString(key);
  const history: EvidenceRecordState[] = specs.map((spec, index) => {
    const evidenceEventId = EventIdSchema.parse(
      "evidence_" + String(spec.sequence) + "_" + String(index) + "_" + key.subject.kind
    );
    return {
      evidenceEventId,
      key,
      value: {
        value: spec.value,
        inferenceConfidence: 0.95,
        evidenceEventIds: [EventIdSchema.parse("support_" + String(spec.sequence) + "_" + String(index))],
        lastUpdatedSequence: spec.sequence
      },
      status: spec.status,
      ...(spec.status === "STALE" ? { invalidationReason: "stale evidence" } : {})
    };
  });
  const active = history.find((record) => record.status === "ACTIVE");
  const studentEvidence =
    active === undefined
      ? Object.fromEntries(
          Object.entries(state.studentEvidence).filter(([candidate]) => candidate !== keyString)
        )
      : { ...state.studentEvidence, [keyString]: active.value };

  return {
    ...state,
    sequence: Math.max(state.sequence, ...specs.map((spec) => spec.sequence)),
    studentEvidence,
    evidenceHistory: { ...state.evidenceHistory, [keyString]: history }
  };
}

function completeMilestone(
  state: SessionState,
  milestoneId: string,
  sequence: number
): SessionState {
  return setHistory(state, milestoneKey(milestoneId, "PROGRESS"), [
    { value: "COMPLETE", sequence, status: "ACTIVE" }
  ]);
}

function withTurns(
  state: SessionState,
  count: number,
  text: string
): SessionState {
  const turns: Record<string, SessionState["turns"][string]> = {};
  for (let index = 0; index < count; index += 1) {
    const turnId = TurnIdSchema.parse("turn_eval_" + String(index));
    turns[turnId] = {
      turnId,
      inputEpisodeId: ("episode_eval_" + String(index)) as SessionState["turns"][string]["inputEpisodeId"],
      studentText: text,
      committedSequence: index + 1
    };
  }
  return { ...state, turns };
}

function withDelivery(
  state: SessionState,
  disclosureId: typeof chooseDisclosure,
  level: 0 | 1 | 2 | 3 | 4 | 5,
  status: DeliveryAtom["status"],
  basisSequence: number,
  label: string,
  text = "fixture assistance"
): SessionState {
  const generationId = GenerationIdSchema.parse("generation_" + label);
  const deliveryId = DeliveryIdSchema.parse("delivery_" + label);
  const turnId = TurnIdSchema.parse("turn_" + label);
  const atom: DeliveryAtom = {
    deliveryId,
    generationId,
    content: { medium: "TEXT", text },
    disclosureIds: [disclosureId],
    effectiveDisclosureLevel: level,
    status
  };

  return {
    ...state,
    generations: {
      ...state.generations,
      [generationId]: {
        generationId,
        basis: {
          contextEpoch: zeroContextEpoch,
          committedInputSequence: basisSequence,
          transcriptRevision: zeroTranscriptRevision,
          boardRevision: zeroBoardRevision,
          problemStateRevision: zeroProblemStateRevision,
          policyRevision: zeroPolicyRevision,
          turnId
        },
        provider: "fixture-provider",
        status: "VALIDATED"
      }
    },
    deliveries: { ...state.deliveries, [deliveryId]: atom }
  };
}

function withVerification(
  state: SessionState,
  key: EvidenceKey,
  status: "VERIFIED" | "CONTRADICTED" | "UNRESOLVED",
  basisSequence: number,
  label: string
): SessionState {
  const requestId = RequestIdSchema.parse("verification_" + label);
  const turnId = TurnIdSchema.parse("turn_verification_" + label);
  const confidence = status === "UNRESOLVED" ? 0.7 : 1;
  return {
    ...state,
    verificationRequests: {
      ...state.verificationRequests,
      [requestId]: {
        verificationRequestId: requestId,
        verifier: "fixture-verifier",
        basis: {
          contextEpoch: zeroContextEpoch,
          committedInputSequence: basisSequence,
          transcriptRevision: zeroTranscriptRevision,
          boardRevision: zeroBoardRevision,
          problemStateRevision: zeroProblemStateRevision,
          policyRevision: zeroPolicyRevision,
          turnId
        },
        candidateFormalInterpretation: "fixture",
        interpretationConfidence: confidence,
        evidenceKey: key,
        evidenceEventIds: [EventIdSchema.parse("verification_support_" + label)],
        requestedEventId: EventIdSchema.parse("verification_requested_" + label),
        status: "ACCEPTED",
        result: {
          status,
          interpretationConfidence: confidence,
          verifier: "fixture-verifier",
          reason: "fixture result"
        }
      }
    }
  };
}

function withPendingVerification(
  state: SessionState,
  key: EvidenceKey,
  basisSequence: number,
  label: string
): SessionState {
  const requestId = RequestIdSchema.parse("verification_" + label);
  const turnId = TurnIdSchema.parse("turn_verification_" + label);
  return {
    ...state,
    verificationRequests: {
      ...state.verificationRequests,
      [requestId]: {
        verificationRequestId: requestId,
        verifier: "fixture-verifier",
        basis: {
          contextEpoch: zeroContextEpoch,
          committedInputSequence: basisSequence,
          transcriptRevision: zeroTranscriptRevision,
          boardRevision: zeroBoardRevision,
          problemStateRevision: zeroProblemStateRevision,
          policyRevision: zeroPolicyRevision,
          turnId
        },
        candidateFormalInterpretation: "fixture",
        interpretationConfidence: 1,
        evidenceKey: key,
        evidenceEventIds: [EventIdSchema.parse("verification_support_" + label)],
        requestedEventId: EventIdSchema.parse("verification_requested_" + label),
        status: "PENDING"
      }
    }
  };
}
