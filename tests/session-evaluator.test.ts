import { describe, expect, it } from "vitest";
import {
  ContextEpochSchema,
  DeliveryIdSchema,
  DisclosureIdSchema,
  EventIdSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionEvaluationSchema,
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
  createProviderContextSpecFingerprintSync,
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
    const one = withTurns(boundState(), 1, "short");
    const many = withTurns(
      boundState(),
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
    let active = boundState();
    active = setHistory(active, milestoneKey("model-relations", "PROGRESS"), [
      { value: "COMPLETE", sequence: 10, status: "ACTIVE" }
    ]);
    expect(milestone(evaluateInterviewSession(active, sixPeopleProblem), "model-relations").achieved)
      .toBe(true);

    let stale = boundState();
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

  it("keeps a progress-complete milestone weak when active support is explicitly incomplete", () => {
    let state = setHistory(
      boundState(),
      milestoneKey("model-relations", "PROGRESS"),
      [{ value: "COMPLETE", sequence: 10, status: "ACTIVE" }]
    );
    state = setHistory(
      state,
      milestoneKey("model-relations", "JUSTIFICATION"),
      [{ value: "UNJUSTIFIED", sequence: 11, status: "ACTIVE" }]
    );

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(milestone(evaluation, "model-relations").achieved).toBe(true);
    expect(milestone(evaluation, "model-relations").supportLevel).toBe("WEAK");
    expect(evaluation.scores.technicalCorrectness).toBeNull();
    expect(evaluation.scores.rigor).toBe(0);
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
    let mixed = boundState();
    mixed = withVerification(mixed, verifiedKey, "VERIFIED", 10, "verified");
    mixed = withVerification(mixed, contradictedKey, "CONTRADICTED", 20, "contradicted");
    expect(evaluateInterviewSession(mixed, sixPeopleProblem).scores.technicalCorrectness).toBe(50);

    const unresolved = withVerification(
      boundState(),
      verifiedKey,
      "UNRESOLVED",
      10,
      "unresolved"
    );
    expect(evaluateInterviewSession(unresolved, sixPeopleProblem).scores.technicalCorrectness)
      .toBeNull();
  });

  it("does not invent acceptance chronology for conflicting standalone verification", () => {
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "changing-formalization" },
      dimension: "CORRECTNESS"
    };

    let firstOrder = withVerification(
      boundState(),
      key,
      "CONTRADICTED",
      10,
      "old-contradiction"
    );
    firstOrder = withVerification(
      firstOrder,
      key,
      "UNRESOLVED",
      10,
      "new-unresolved"
    );
    expect(evaluateInterviewSession(firstOrder, sixPeopleProblem).scores.technicalCorrectness)
      .toBeNull();

    let reverseOrder = withVerification(
      boundState(),
      key,
      "UNRESOLVED",
      10,
      "old-unresolved"
    );
    reverseOrder = withVerification(
      reverseOrder,
      key,
      "CONTRADICTED",
      10,
      "new-contradiction"
    );
    expect(evaluateInterviewSession(reverseOrder, sixPeopleProblem).scores.technicalCorrectness)
      .toBeNull();
  });

  it("does not let a current positive model inference silently override a deterministic contradiction", () => {
    const correctnessKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "conflicted-claim" },
      dimension: "CORRECTNESS"
    };
    const justificationKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "conflicted-claim" },
      dimension: "JUSTIFICATION"
    };

    let state = setHistory(boundState(), correctnessKey, [
      { value: "CORRECT", sequence: 10, status: "ACTIVE" }
    ]);
    state = setHistory(state, justificationKey, [
      { value: "JUSTIFIED", sequence: 11, status: "ACTIVE" }
    ]);
    state = withVerification(
      state,
      correctnessKey,
      "CONTRADICTED",
      10,
      "conflicting-deterministic"
    );

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.scores.technicalCorrectness).toBeNull();
    expect(evaluation.dimensionResults.technicalCorrectness.notScoredReason)
      .toContain("conflicting");
    expect(evaluation.scores.rigor).toBe(100);
    expect(evaluation.dimensionResults.rigor.supportLevel).toBe("WEAK");
  });

  it("does not force rigor to zero when deterministic correctness itself is unresolved", () => {
    const correctnessKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "ambiguous-rigor-claim" },
      dimension: "CORRECTNESS"
    };
    const justificationKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "ambiguous-rigor-claim" },
      dimension: "JUSTIFICATION"
    };

    let state = setHistory(boundState(), justificationKey, [
      { value: "JUSTIFIED", sequence: 10, status: "ACTIVE" }
    ]);
    state = withVerification(
      state,
      correctnessKey,
      "CONTRADICTED",
      10,
      "ambiguous-rigor-contradicted"
    );
    state = withVerification(
      state,
      correctnessKey,
      "UNRESOLVED",
      10,
      "ambiguous-rigor-unresolved"
    );

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.scores.technicalCorrectness).toBeNull();
    expect(evaluation.scores.rigor).toBe(100);
    expect(evaluation.dimensionResults.rigor.supportLevel).toBe("WEAK");
  });

  it("uses an unambiguous deterministic contradiction when model correctness is UNKNOWN", () => {
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "unknown-but-contradicted" },
      dimension: "CORRECTNESS"
    };
    let state = setHistory(boundState(), key, [
      { value: "UNKNOWN", sequence: 10, status: "ACTIVE" }
    ]);
    state = withVerification(
      state,
      key,
      "CONTRADICTED",
      10,
      "unknown-contradiction"
    );

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.technicalCorrectness)
      .toBe(0);
  });

  it("requires specific verifier provenance before upgrading correctness support", () => {
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "provenance-claim" },
      dimension: "CORRECTNESS"
    };
    const verified = withVerification(boundState(), key, "VERIFIED", 10, "provenance");
    const verifiedEvaluation = evaluateInterviewSession(verified, sixPeopleProblem);
    expect(verifiedEvaluation.scores.technicalCorrectness).toBe(100);
    expect(verifiedEvaluation.dimensionResults.technicalCorrectness.supportLevel)
      .toBe("MODERATE");
    expect(verifiedEvaluation.dimensionResults.technicalCorrectness.evidenceRefs)
      .toContainEqual({
        kind: "VERIFICATION_REQUEST",
        id: "verification_provenance"
      });

    const unlinked = setHistory(verified, key, [{
      value: "CORRECT",
      sequence: 20,
      status: "ACTIVE",
      evidenceEventIds: [EventIdSchema.parse("unrelated_support_event")]
    }]);
    const unlinkedEvaluation = evaluateInterviewSession(unlinked, sixPeopleProblem);
    expect(unlinkedEvaluation.scores.technicalCorrectness).toBe(100);
    expect(unlinkedEvaluation.dimensionResults.technicalCorrectness.supportLevel)
      .toBe("WEAK");
    expect(unlinkedEvaluation.dimensionResults.technicalCorrectness.evidenceRefs)
      .not.toContainEqual({
        kind: "VERIFICATION_REQUEST",
        id: "verification_provenance"
      });
  });

  it("does not resurrect invalidated verified evidence from historical verifier state", () => {
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "stale-verified-claim" },
      dimension: "CORRECTNESS"
    };
    let state = withVerification(boundState(), key, "VERIFIED", 10, "stale-verified");
    state = setHistory(state, key, [{
      value: "CORRECT",
      sequence: 12,
      status: "STALE",
      evidenceEventIds: [EventIdSchema.parse("verification_requested_stale-verified")]
    }]);

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.technicalCorrectness)
      .toBeNull();
  });

  it("does not treat a contradiction from a stale context epoch as current correctness", () => {
    const key: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "stale-contradiction" },
      dimension: "CORRECTNESS"
    };
    const contradicted = withVerification(
      boundState(),
      key,
      "CONTRADICTED",
      10,
      "stale-contradiction"
    );
    const state: SessionState = {
      ...contradicted,
      contextEpoch: ContextEpochSchema.parse(1)
    };

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.technicalCorrectness)
      .toBeNull();
  });

  it("downgrades otherwise strong correctness coverage when a current subject is unresolved", () => {
    let state = boundState();
    for (const [index, claimId] of ["verified-a", "verified-b", "verified-c"].entries()) {
      const key: EvidenceKey = {
        problemId: sixPeopleProblem.id,
        subject: { kind: "CLAIM", claimId },
        dimension: "CORRECTNESS"
      };
      state = withVerification(
        state,
        key,
        "VERIFIED",
        10 + index * 10,
        "coverage-" + claimId
      );
    }
    const unknownKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "current-unknown" },
      dimension: "CORRECTNESS"
    };
    state = setHistory(state, unknownKey, [
      { value: "UNKNOWN", sequence: 50, status: "ACTIVE" }
    ]);

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.scores.technicalCorrectness).toBe(100);
    expect(evaluation.dimensionResults.technicalCorrectness.supportLevel).toBe("MODERATE");
    expect(evaluation.summaryAssessment).toContain("1 current correctness subject");
  });

  it("rejects evidence provenance that is not present in authoritative event history", () => {
    const key = milestoneKey("model-relations", "JUSTIFICATION");
    const state = setHistory(boundState(), key, [
      { value: "JUSTIFIED", sequence: 10, status: "ACTIVE" }
    ]);
    const active = state.evidenceHistory[evidenceKeyToString(key)]?.[0];
    const supportEvent = active?.value.evidenceEventIds[0];
    if (supportEvent === undefined) throw new Error("Expected fixture support event");
    const corrupted: SessionState = {
      ...state,
      eventIds: state.eventIds.filter((eventId) => eventId !== supportEvent)
    };

    expect(() => evaluateInterviewSession(corrupted, sixPeopleProblem)).toThrow(
      "evidence provenance references an unknown authoritative event"
    );
  });

  it("scores rigor from justification evidence, not from verification-request count", () => {
    let rigorous = boundState();
    rigorous = setHistory(rigorous, milestoneKey("model-relations", "JUSTIFICATION"), [
      { value: "JUSTIFIED", sequence: 10, status: "ACTIVE" }
    ]);
    expect(evaluateInterviewSession(rigorous, sixPeopleProblem).scores.rigor).toBe(100);

    const pendingKey: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "CLAIM", claimId: "pending-rigor-control" },
      dimension: "CORRECTNESS"
    };
    const pending = withPendingVerification(
      withTurns(boundState(), 20, "not evidence"),
      pendingKey,
      30,
      "pending"
    );
    const evaluation = evaluateInterviewSession(pending, sixPeopleProblem);
    expect(evaluation.scores.rigor).toBeNull();
    expect(evaluation.scores.technicalCorrectness).toBeNull();
  });

  it("deduplicates repeated exposure and ignores queued or cancelled assistance", () => {
    let state = completeMilestone(boundState(), "choose-vertex", 20);
    state = withDelivery(state, chooseDisclosure, 2, "EXPOSED", 5, "first");
    state = withDelivery(state, chooseDisclosure, 2, "COMPLETED", 5, "repeat");
    state = withDelivery(state, chooseDisclosure, 4, "CANCELLED", 4, "cancelled");
    state = withDelivery(state, chooseDisclosure, 4, "QUEUED", 4, "queued");

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.disclosedInterventions).toHaveLength(2);
    expect(milestone(evaluation, "choose-vertex").assistanceDisclosureIds).toEqual([chooseDisclosure]);
    expect(evaluation.scores.independence).toBeNull();
    expect(evaluation.dimensionResults.independence.supportLevel).toBe("INSUFFICIENT");
    expect(evaluation.disclosedInterventions.map((item) => item.deliveryStatus))
      .toEqual(["EXPOSED", "COMPLETED"]);
  });

  it("treats POSSIBLY_EXPOSED conservatively and never mistakes generation basis for exposure time", () => {
    let uncertain = completeMilestone(boundState(), "choose-vertex", 20);
    uncertain = withDelivery(uncertain, chooseDisclosure, 2, "POSSIBLY_EXPOSED", 5, "possible");
    const uncertainEvaluation = evaluateInterviewSession(uncertain, sixPeopleProblem);
    expect(uncertainEvaluation.scores.independence).toBeNull();
    expect(uncertainEvaluation.dimensionResults.independence.supportLevel).toBe("INSUFFICIENT");
    expect(uncertainEvaluation.disclosedInterventions[0]?.deliveryStatus).toBe("POSSIBLY_EXPOSED");

    let laterBasis = completeMilestone(boundState(), "choose-vertex", 10);
    laterBasis = withDelivery(laterBasis, chooseDisclosure, 2, "EXPOSED", 20, "later-basis");
    const laterBasisEvaluation = evaluateInterviewSession(laterBasis, sixPeopleProblem);
    expect(laterBasisEvaluation.scores.independence).toBeNull();
    expect(laterBasisEvaluation.dimensionResults.independence.supportLevel).toBe("INSUFFICIENT");
  });

  it("scores error recovery only from actual evidence transitions", () => {
    const key = milestoneKey("model-relations", "CORRECTNESS");
    let recovered = boundState();
    recovered = setHistory(recovered, key, [
      { value: "LOCAL_ERROR", sequence: 10, status: "SUPERSEDED" },
      { value: "CORRECT", sequence: 20, status: "ACTIVE" }
    ]);
    expect(evaluateInterviewSession(recovered, sixPeopleProblem).scores.errorRecovery).toBe(100);

    let unresolved = boundState();
    unresolved = setHistory(unresolved, key, [
      { value: "LOCAL_ERROR", sequence: 10, status: "SUPERSEDED" },
      { value: "STRUCTURAL_ERROR", sequence: 20, status: "ACTIVE" }
    ]);
    expect(evaluateInterviewSession(unresolved, sixPeopleProblem).scores.errorRecovery).toBe(0);

    expect(evaluateInterviewSession(withTurns(boundState(), 40, "turn"), sixPeopleProblem)
      .scores.errorRecovery).toBeNull();
  });

  it("renormalizes partial composites and rejects malformed rubrics", () => {
    let state = boundState();
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

  it("rejects tampered composite metadata even when individual scores are schema-valid", () => {
    let state = boundState();
    state = setHistory(state, milestoneKey("model-relations", "CORRECTNESS"), [
      { value: "CORRECT", sequence: 10, status: "ACTIVE" }
    ]);
    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(() => SessionEvaluationSchema.parse({
      ...evaluation,
      composite: {
        ...evaluation.composite,
        status: "FULL",
        includedDimensions: ["technicalCorrectness", "communication"],
        omittedDimensions: []
      }
    })).toThrow();
  });

  it("is deterministic, timestamp-independent for scoring, and omits raw private content", () => {
    let state = completeMilestone(boundState(), "choose-vertex", 20);
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

function boundState(): SessionState {
  return {
    ...initialSessionState(newSessionId()),
    started: true,
    status: "ACTIVE",
    problem: {
      id: sixPeopleProblem.id,
      version: sixPeopleProblem.version,
      prompt: sixPeopleProblem.public.prompt,
      providerContextSpecSha256: createProviderContextSpecFingerprintSync(sixPeopleProblem)
    }
  };
}

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
    readonly evidenceEventIds?: readonly ReturnType<typeof EventIdSchema.parse>[];
    readonly confidence?: number;
  }[]
): SessionState {
  const keyString = evidenceKeyToString(key);
  const subjectId =
    key.subject.kind === "CLAIM"
      ? key.subject.claimId
      : key.subject.kind === "MILESTONE"
        ? key.subject.milestoneId
        : key.subject.kind === "SKILL"
          ? key.subject.skillId
          : key.subject.approachId;
  const recordIds = specs.map((spec, index) =>
    EventIdSchema.parse(
      "evidence_" +
      subjectId +
      "_" +
      key.dimension +
      "_" +
      String(spec.sequence) +
      "_" +
      String(index)
    )
  );
  const history: EvidenceRecordState[] = specs.map((spec, index) => {
    const evidenceEventId = recordIds[index];
    if (evidenceEventId === undefined) throw new Error("Fixture evidence ID is unavailable");
    const supersededByEventId = recordIds[index + 1];
    if (spec.status === "SUPERSEDED" && supersededByEventId === undefined) {
      throw new Error("Fixture superseded evidence requires a replacement");
    }
    return {
      evidenceEventId,
      key,
      value: {
        value: spec.value,
        inferenceConfidence: spec.confidence ?? 0.95,
        evidenceEventIds: spec.evidenceEventIds === undefined
          ? [EventIdSchema.parse(
              "support_" +
              subjectId +
              "_" +
              key.dimension +
              "_" +
              String(spec.sequence) +
              "_" +
              String(index)
            )]
          : [...spec.evidenceEventIds],
        lastUpdatedSequence: spec.sequence
      },
      status: spec.status,
      ...(spec.status === "SUPERSEDED" ? { supersededByEventId } : {}),
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

  const historyEventIds = history.flatMap((record) => [
    record.evidenceEventId,
    ...record.value.evidenceEventIds
  ]);
  return {
    ...state,
    sequence: Math.max(state.sequence, ...specs.map((spec) => spec.sequence)),
    eventIds: uniqueEventIds([...state.eventIds, ...historyEventIds]),
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
      inputEpisodeId: InputEpisodeIdSchema.parse("episode_eval_" + String(index)),
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
    deliveries: { ...state.deliveries, [deliveryId]: atom },
    disclosureLedger:
      status === "EXPOSED" || status === "COMPLETED" || status === "POSSIBLY_EXPOSED"
        ? Array.from(new Set([...state.disclosureLedger, disclosureId]))
        : state.disclosureLedger
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
  const requestedEventId = EventIdSchema.parse("verification_requested_" + label);
  const verificationSupportId = EventIdSchema.parse("verification_support_" + label);
  const next: SessionState = {
    ...state,
    eventIds: uniqueEventIds([...state.eventIds, verificationSupportId, requestedEventId]),
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
        evidenceEventIds: [verificationSupportId],
        requestedEventId,
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
  if (status !== "VERIFIED") return next;
  return setHistory(next, key, [{
    value: "CORRECT",
    sequence: basisSequence + 2,
    status: "ACTIVE",
    confidence,
    evidenceEventIds: [requestedEventId]
  }]);
}

function withPendingVerification(
  state: SessionState,
  key: EvidenceKey,
  basisSequence: number,
  label: string
): SessionState {
  const requestId = RequestIdSchema.parse("verification_" + label);
  const turnId = TurnIdSchema.parse("turn_verification_" + label);
  const verificationSupportId = EventIdSchema.parse("verification_support_" + label);
  const requestedEventId = EventIdSchema.parse("verification_requested_" + label);
  return {
    ...state,
    eventIds: uniqueEventIds([...state.eventIds, verificationSupportId, requestedEventId]),
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
        evidenceEventIds: [verificationSupportId],
        requestedEventId,
        status: "PENDING"
      }
    }
  };
}

function uniqueEventIds(
  eventIds: readonly ReturnType<typeof EventIdSchema.parse>[]
): ReturnType<typeof EventIdSchema.parse>[] {
  return Array.from(new Set(eventIds));
}
