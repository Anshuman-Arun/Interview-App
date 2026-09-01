import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DeliveryIdSchema,
  DisclosureIdSchema,
  EventIdSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  TurnIdSchema,
  evidenceKeyToString,
  newSessionId,
  zeroBoardRevision,
  zeroContextEpoch,
  zeroPolicyRevision,
  zeroProblemStateRevision,
  zeroTranscriptRevision,
  type DeliveryAtom,
  type DisclosureId,
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
  validateFallibleQualitativeEvaluationProposal
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";

const chooseDisclosure = DisclosureIdSchema.parse("disclosure_choose_person_pigeonhole");
const triangleDisclosure = DisclosureIdSchema.parse("disclosure_complete_monochromatic_triangle");

describe("grounded session evaluator adversarial cases", () => {
  it("accepts a valid alternate reasoning branch without requiring the skipped branch", () => {
    let state = initialSessionState(newSessionId());
    state = complete(state, "model-relations", 10);
    state = complete(state, "choose-vertex", 20);
    state = complete(state, "complement-case", 30);
    state = complete(state, "verify", 40);

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);

    expect(findMilestone(evaluation, "model-relations").achieved).toBe(true);
    expect(findMilestone(evaluation, "choose-vertex").achieved).toBe(true);
    expect(findMilestone(evaluation, "complement-case").achieved).toBe(true);
    expect(findMilestone(evaluation, "verify").achieved).toBe(true);
    expect(findMilestone(evaluation, "close-triangle").achieved).toBe(false);
    expect(evaluation.scores.technicalCorrectness).toBe(100);
  });

  it("attributes multiple distinct hints only to milestones that reference them", () => {
    let state = initialSessionState(newSessionId());
    state = complete(state, "choose-vertex", 20);
    state = complete(state, "close-triangle", 40);
    state = addDelivery(state, chooseDisclosure, 2, "EXPOSED", 5, "choose");
    state = addDelivery(state, triangleDisclosure, 4, "EXPOSED", 25, "triangle");

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(findMilestone(evaluation, "choose-vertex").assistanceLevel).toBe(2);
    expect(findMilestone(evaluation, "close-triangle").assistanceLevel).toBe(4);
    expect(evaluation.assistedMilestoneCount).toBe(2);
    expect(evaluation.scores.independence).toBe(53);
  });

  it("does not penalize a milestone for an unrelated protected disclosure", () => {
    let state = complete(initialSessionState(newSessionId()), "choose-vertex", 20);
    state = addDelivery(state, triangleDisclosure, 4, "EXPOSED", 5, "unrelated");

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(findMilestone(evaluation, "choose-vertex").assistanceLevel).toBe(0);
    expect(evaluation.scores.independence).toBe(100);
  });

  it("degrades independence support when exposed assistance cannot be attributed to a milestone", () => {
    let state = complete(initialSessionState(newSessionId()), "choose-vertex", 20);
    state = addDelivery(
      state,
      DisclosureIdSchema.parse("unmapped_disclosure"),
      3,
      "EXPOSED",
      5,
      "unmapped"
    );

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.scores.independence).toBe(100);
    expect(evaluation.dimensionResults.independence.supportLevel).toBe("WEAK");
    expect(evaluation.dimensionResults.independence.evidenceRefs).toContainEqual({
      kind: "DELIVERY",
      id: "delivery_adv_unmapped"
    });
  });

  it("abstains on hint responsiveness when exposure ordering is not authoritative", () => {
    let apparentProgress = complete(initialSessionState(newSessionId()), "choose-vertex", 20);
    apparentProgress = addDelivery(
      apparentProgress,
      chooseDisclosure,
      2,
      "EXPOSED",
      5,
      "apparent-progress"
    );

    const evaluation = evaluateInterviewSession(apparentProgress, sixPeopleProblem);
    expect(evaluation.scores.hintResponsiveness).toBeNull();
    expect(evaluation.dimensionResults.hintResponsiveness.supportLevel).toBe("INSUFFICIENT");
    expect(evaluation.dimensionResults.hintResponsiveness.notScoredReason).toContain(
      "exposure ordering"
    );
  });

  it("recognizes stale evidence followed by a fresh supported replacement as recovery", () => {
    const key = milestoneKey("model-relations", "CORRECTNESS");
    let state = initialSessionState(newSessionId());
    state = setHistory(state, key, [
      { value: "CORRECT", sequence: 10, status: "STALE" },
      { value: "CORRECT", sequence: 20, status: "ACTIVE" }
    ]);

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.errorRecovery).toBe(100);
  });

  it("records incomplete and archived lifecycle context without completion-style prose", () => {
    const active: SessionState = {
      ...initialSessionState(newSessionId()),
      started: true,
      status: "ACTIVE"
    };
    const activeEvaluation = evaluateInterviewSession(active, sixPeopleProblem);
    expect(activeEvaluation.lifecycle.completionState).toBe("IN_PROGRESS");
    expect(activeEvaluation.summaryAssessment).toContain("incomplete");

    const archivedIncomplete: SessionState = {
      ...active,
      status: "ARCHIVED",
      archivedAt: "2026-08-31T20:00:00.000Z"
    };
    const archivedEvaluation = evaluateInterviewSession(archivedIncomplete, sixPeopleProblem);
    expect(archivedEvaluation.lifecycle.completionState).toBe("ARCHIVED_INCOMPLETE");
    expect(archivedEvaluation.summaryAssessment).toContain("without an authoritative completion");

    const completed: SessionState = {
      ...active,
      status: "COMPLETED",
      completedAt: "2026-08-31T20:01:00.000Z"
    };
    expect(evaluateInterviewSession(completed, sixPeopleProblem).lifecycle.completionState)
      .toBe("COMPLETED");

    const archivedCompleted: SessionState = {
      ...completed,
      status: "ARCHIVED",
      archivedAt: "2026-08-31T20:02:00.000Z"
    };
    expect(evaluateInterviewSession(archivedCompleted, sixPeopleProblem).lifecycle.completionState)
      .toBe("ARCHIVED_COMPLETED");
  });

  it("produces FULL composite metadata when all positively weighted dimensions are grounded", () => {
    let state = complete(initialSessionState(newSessionId()), "model-relations", 30);
    state = setHistory(state, milestoneKey("model-relations", "CORRECTNESS"), [
      { value: "LOCAL_ERROR", sequence: 10, status: "SUPERSEDED" },
      { value: "CORRECT", sequence: 20, status: "ACTIVE" }
    ]);
    state = setHistory(state, milestoneKey("model-relations", "JUSTIFICATION"), [
      { value: "JUSTIFIED", sequence: 31, status: "ACTIVE" }
    ]);

    const rubric: EvaluationRubric = {
      correctnessWeight: 0.25,
      rigorWeight: 0.25,
      independenceWeight: 0.25,
      communicationWeight: 0,
      errorRecoveryWeight: 0.25
    };
    const evaluation = evaluateInterviewSession(state, sixPeopleProblem, rubric);

    expect(evaluation.composite.status).toBe("FULL");
    expect(evaluation.composite.omittedDimensions).toEqual([]);
    expect(evaluation.scores.compositeScore).toBe(100);
  });

  it("rejects zero-sum rubrics and unknown rubric fields", () => {
    const state = initialSessionState(newSessionId());
    expect(() => evaluateInterviewSession(state, sixPeopleProblem, {
      correctnessWeight: 0,
      rigorWeight: 0,
      independenceWeight: 0,
      communicationWeight: 0,
      errorRecoveryWeight: 0
    })).toThrow("weights must sum to 1");

    const unknown = {
      correctnessWeight: 1,
      rigorWeight: 0,
      independenceWeight: 0,
      communicationWeight: 0,
      errorRecoveryWeight: 0,
      unknownWeight: 1
    } as unknown as Partial<EvaluationRubric>;
    expect(() => evaluateInterviewSession(state, sixPeopleProblem, unknown)).toThrow();
  });

  it("is invariant to map insertion order", () => {
    let state = complete(initialSessionState(newSessionId()), "model-relations", 30);
    state = setHistory(state, milestoneKey("model-relations", "CORRECTNESS"), [
      { value: "CORRECT", sequence: 20, status: "ACTIVE" }
    ]);
    state = setHistory(state, milestoneKey("model-relations", "JUSTIFICATION"), [
      { value: "JUSTIFIED", sequence: 21, status: "ACTIVE" }
    ]);

    const reordered: SessionState = {
      ...state,
      evidenceHistory: Object.fromEntries(Object.entries(state.evidenceHistory).reverse()),
      studentEvidence: Object.fromEntries(Object.entries(state.studentEvidence).reverse())
    };
    const evaluatedAt = "2026-08-31T20:00:00.000Z";

    expect(evaluateInterviewSession(reordered, sixPeopleProblem, {}, { evaluatedAt }))
      .toEqual(evaluateInterviewSession(state, sixPeopleProblem, {}, { evaluatedAt }));
  });

  it("keeps future qualitative model proposals fallible and provenance-bounded", () => {
    let state = initialSessionState(newSessionId());
    state = setHistory(state, milestoneKey("model-relations", "JUSTIFICATION"), [
      { value: "JUSTIFIED", sequence: 10, status: "ACTIVE" }
    ]);
    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    const allowed = evaluation.dimensionResults.rigor.evidenceRefs[0];
    if (allowed === undefined) throw new Error("Expected a grounded evidence reference");

    expect(validateFallibleQualitativeEvaluationProposal(
      { allowedEvidenceRefs: [allowed] },
      {
        dimension: "communication",
        score: 90,
        evidenceRefs: [allowed],
        rationale: "A fallible proposal whose provenance is grounded."
      }
    ).accepted).toBe(true);

    expect(validateFallibleQualitativeEvaluationProposal(
      { allowedEvidenceRefs: [allowed] },
      {
        dimension: "communication",
        score: 90,
        evidenceRefs: [{ kind: "TURN", id: "invented-turn" }],
        rationale: "Unsupported provenance."
      }
    )).toEqual({
      accepted: false,
      reason: "UNSUPPORTED_EVIDENCE_REFERENCE"
    });

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.communication).toBeNull();
  });

  it("never serializes protected fact text merely because its disclosure was exposed", () => {
    let state = complete(initialSessionState(newSessionId()), "choose-vertex", 20);
    state = addDelivery(state, chooseDisclosure, 2, "EXPOSED", 5, "private-fact");

    const serialized = JSON.stringify(evaluateInterviewSession(state, sixPeopleProblem));
    const protectedFact = sixPeopleProblem.interviewer.protectedDisclosures.find(
      (item) => item.id === chooseDisclosure
    )?.fact;
    if (protectedFact === undefined) throw new Error("Fixture disclosure is missing");
    expect(serialized).not.toContain(protectedFact);
  });

  it("fails structurally on a mismatched exact problem version", () => {
    const state: SessionState = {
      ...initialSessionState(newSessionId()),
      problem: {
        id: sixPeopleProblem.id,
        version: "different-version",
        prompt: sixPeopleProblem.public.prompt
      }
    };
    expect(() => evaluateInterviewSession(state, sixPeopleProblem)).toThrow(
      "problem identity does not match"
    );
  });

  it("rejects pathological turn volume instead of silently truncating", () => {
    const turns: Record<string, SessionState["turns"][string]> = {};
    for (let index = 0; index < 10_001; index += 1) {
      const turnId = TurnIdSchema.parse("turn_bound_" + String(index));
      turns[turnId] = {
        turnId,
        inputEpisodeId: InputEpisodeIdSchema.parse("episode_bound_" + String(index)),
        studentText: "bounded",
        committedSequence: index + 1
      };
    }
    const state: SessionState = {
      ...initialSessionState(newSessionId()),
      turns
    };
    expect(() => evaluateInterviewSession(state, sixPeopleProblem)).toThrow(
      "supported turn bound"
    );
  });

  it("property: arbitrary meaningless extra turns cannot improve grounded scores", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.string({ minLength: 1, maxLength: 200 }),
      (extraTurns, text) => {
        let state = complete(initialSessionState(newSessionId()), "model-relations", 10);
        state = setHistory(state, milestoneKey("model-relations", "JUSTIFICATION"), [
          { value: "INCOMPLETE", sequence: 11, status: "ACTIVE" }
        ]);

        const baseline = evaluateInterviewSession(state, sixPeopleProblem);
        const padded = evaluateInterviewSession(
          addTurns(state, extraTurns, text),
          sixPeopleProblem
        );

        expect(padded.scores).toEqual(baseline.scores);
        expect(padded.milestones).toEqual(baseline.milestones);
      }
    ), { numRuns: 50 });
  });
});

function findMilestone(
  evaluation: ReturnType<typeof evaluateInterviewSession>,
  milestoneId: string
) {
  const result = evaluation.milestones.find((item) => item.milestoneId === milestoneId);
  if (result === undefined) throw new Error("Expected milestone");
  return result;
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

function complete(
  state: SessionState,
  milestoneId: string,
  sequence: number
): SessionState {
  return setHistory(state, milestoneKey(milestoneId, "PROGRESS"), [
    { value: "COMPLETE", sequence, status: "ACTIVE" }
  ]);
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
  const subjectId =
    key.subject.kind === "CLAIM"
      ? key.subject.claimId
      : key.subject.kind === "MILESTONE"
        ? key.subject.milestoneId
        : key.subject.kind === "SKILL"
          ? key.subject.skillId
          : key.subject.approachId;
  const history: EvidenceRecordState[] = specs.map((spec, index) => ({
    evidenceEventId: EventIdSchema.parse(
      "eval_" + subjectId + "_" + key.dimension + "_" + String(spec.sequence) + "_" + String(index)
    ),
    key,
    value: {
      value: spec.value,
      inferenceConfidence: 0.95,
      evidenceEventIds: [
        EventIdSchema.parse(
          "support_" + subjectId + "_" + key.dimension + "_" + String(spec.sequence) + "_" + String(index)
        )
      ],
      lastUpdatedSequence: spec.sequence
    },
    status: spec.status,
    ...(spec.status === "STALE" ? { invalidationReason: "fixture invalidation" } : {})
  }));

  const active = history.find((record) => record.status === "ACTIVE");
  const studentEvidence = active === undefined
    ? Object.fromEntries(
        Object.entries(state.studentEvidence).filter(([candidate]) => candidate !== keyString)
      )
    : { ...state.studentEvidence, [keyString]: active.value };

  return {
    ...state,
    sequence: Math.max(state.sequence, ...specs.map((item) => item.sequence)),
    studentEvidence,
    evidenceHistory: {
      ...state.evidenceHistory,
      [keyString]: history
    }
  };
}

function addDelivery(
  state: SessionState,
  disclosureId: DisclosureId,
  level: 0 | 1 | 2 | 3 | 4 | 5,
  status: DeliveryAtom["status"],
  basisSequence: number,
  label: string
): SessionState {
  const generationId = GenerationIdSchema.parse("generation_adv_" + label);
  const deliveryId = DeliveryIdSchema.parse("delivery_adv_" + label);
  const turnId = TurnIdSchema.parse("turn_adv_" + label);
  const atom: DeliveryAtom = {
    deliveryId,
    generationId,
    content: { medium: "TEXT", text: "fixture assistance " + label },
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
    deliveries: {
      ...state.deliveries,
      [deliveryId]: atom
    }
  };
}

function addTurns(
  state: SessionState,
  count: number,
  text: string
): SessionState {
  const turns: Record<string, SessionState["turns"][string]> = { ...state.turns };
  for (let index = 0; index < count; index += 1) {
    const turnId = TurnIdSchema.parse("turn_property_" + String(index));
    turns[turnId] = {
      turnId,
      inputEpisodeId: InputEpisodeIdSchema.parse("episode_property_" + String(index)),
      studentText: text.length === 0 ? "meaningless" : text,
      committedSequence: 1000 + index
    };
  }
  return { ...state, turns };
}
