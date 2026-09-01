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
  type EvaluationRubric,
  type InterviewProblem
} from "../packages/domain/src/index.js";
import {
  initialSessionState,
  type EvidenceRecordState,
  type SessionState
} from "../packages/events/src/index.js";
import {
  createProviderContextSpecFingerprintSync,
  evaluateInterviewSession,
  validateFallibleQualitativeEvaluationProposal
} from "../packages/interview-engine/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";

const chooseDisclosure = DisclosureIdSchema.parse("disclosure_choose_person_pigeonhole");
const triangleDisclosure = DisclosureIdSchema.parse("disclosure_complete_monochromatic_triangle");

describe("grounded session evaluator adversarial cases", () => {
  it("accepts a valid alternate reasoning branch without requiring the skipped branch", () => {
    let state = boundState();
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
    expect(evaluation.scores.technicalCorrectness).toBeNull();
  });

  it("attributes multiple distinct hints only to milestones that reference them", () => {
    let state = boundState();
    state = complete(state, "choose-vertex", 20);
    state = complete(state, "close-triangle", 40);
    state = addDelivery(state, chooseDisclosure, 2, "EXPOSED", 5, "choose");
    state = addDelivery(state, triangleDisclosure, 4, "EXPOSED", 25, "triangle");

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(findMilestone(evaluation, "choose-vertex").assistanceLevel).toBe(2);
    expect(findMilestone(evaluation, "close-triangle").assistanceLevel).toBe(4);
    expect(evaluation.assistedMilestoneCount).toBe(2);
    expect(evaluation.scores.independence).toBeNull();
    expect(evaluation.dimensionResults.independence.supportLevel).toBe("INSUFFICIENT");
  });

  it("does not treat a level-zero protected disclosure as assistance uncertainty", () => {
    const targetMilestone = sixPeopleProblem.interviewer.reasoningGraph.milestones.find(
      (milestone) => milestone.protectedDisclosureIds.length > 0
    );
    if (targetMilestone === undefined) throw new Error("Expected protected milestone");
    const disclosureId = targetMilestone.protectedDisclosureIds[0];
    if (disclosureId === undefined) throw new Error("Expected protected disclosure");
    const zeroProblem: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures.map(
          (disclosure) => disclosure.id === disclosureId
            ? { ...disclosure, minimumDisclosureLevel: 0 as const }
            : disclosure
        )
      }
    };
    let state = complete(boundStateFor(zeroProblem), targetMilestone.id, 10);
    state = addDelivery(
      state,
      disclosureId,
      0,
      "EXPOSED",
      5,
      "zero-level-protected"
    );

    const evaluation = evaluateInterviewSession(state, zeroProblem);
    expect(findMilestone(evaluation, targetMilestone.id).assistanceLevel).toBe(0);
    expect(findMilestone(evaluation, targetMilestone.id).assistanceDisclosureIds).toEqual([]);
    expect(evaluation.scores.independence).toBe(100);
  });

  it("does not lose residual positive assistance behind a level-zero mapped disclosure", () => {
    const targetMilestone = sixPeopleProblem.interviewer.reasoningGraph.milestones.find(
      (milestone) => milestone.protectedDisclosureIds.length > 0
    );
    if (targetMilestone === undefined) throw new Error("Expected protected milestone");
    const disclosureId = targetMilestone.protectedDisclosureIds[0];
    if (disclosureId === undefined) throw new Error("Expected protected disclosure");
    const zeroProblem: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures.map(
          (disclosure) => disclosure.id === disclosureId
            ? { ...disclosure, minimumDisclosureLevel: 0 as const }
            : disclosure
        )
      }
    };
    let state = complete(boundStateFor(zeroProblem), targetMilestone.id, 10);
    state = addDelivery(
      state,
      disclosureId,
      3,
      "EXPOSED",
      5,
      "residual-positive-assistance"
    );

    const evaluation = evaluateInterviewSession(state, zeroProblem);
    expect(findMilestone(evaluation, targetMilestone.id).assistanceLevel).toBe(0);
    expect(evaluation.scores.independence).toBeNull();
    expect(evaluation.dimensionResults.independence.evidenceRefs)
      .toContainEqual({
        kind: "DELIVERY",
        id: "delivery_adv_residual-positive-assistance"
      });
  });

  it("keeps milestone achievement support separate from assistance-timing uncertainty", () => {
    let state = complete(boundState(), "model-relations", 10);
    state = complete(state, "choose-vertex", 20);
    state = setHistory(state, milestoneKey("choose-vertex", "CORRECTNESS"), [
      { value: "CORRECT", sequence: 21, status: "ACTIVE" }
    ]);
    state = setHistory(state, milestoneKey("choose-vertex", "JUSTIFICATION"), [
      { value: "JUSTIFIED", sequence: 22, status: "ACTIVE" }
    ]);

    const before = evaluateInterviewSession(state, sixPeopleProblem);
    expect(findMilestone(before, "choose-vertex").supportLevel).toBe("MODERATE");

    const exposed = addDelivery(
      state,
      chooseDisclosure,
      2,
      "EXPOSED",
      5,
      "support-separation"
    );
    const after = evaluateInterviewSession(exposed, sixPeopleProblem);
    expect(findMilestone(after, "choose-vertex").supportLevel).toBe("MODERATE");
    expect(after.scores.independence).toBeNull();
  });

  it("attributes a multi-disclosure delivery at each disclosure's problem-defined level", () => {
    let state = complete(boundState(), "choose-vertex", 20);
    state = addDelivery(
      state,
      [chooseDisclosure, triangleDisclosure],
      4,
      "EXPOSED",
      5,
      "mixed-level"
    );

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(findMilestone(evaluation, "choose-vertex").assistanceLevel).toBe(2);
    expect(evaluation.disclosedInterventions[0]?.disclosureLevel).toBe(4);
    expect(evaluation.scores.independence).toBeNull();
  });

  it("rejects a disclosure ledger that disagrees with exposed delivery state", () => {
    const exposed = addDelivery(
      complete(boundState(), "choose-vertex", 20),
      chooseDisclosure,
      2,
      "EXPOSED",
      5,
      "ledger-mismatch"
    );
    const inconsistent: SessionState = {
      ...exposed,
      disclosureLedger: []
    };

    expect(() => evaluateInterviewSession(inconsistent, sixPeopleProblem)).toThrow(
      "disclosure ledger does not match"
    );
  });

  it("does not penalize a milestone for an unrelated protected disclosure", () => {
    let state = complete(boundState(), "choose-vertex", 20);
    state = addDelivery(state, triangleDisclosure, 4, "EXPOSED", 5, "unrelated");

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(findMilestone(evaluation, "choose-vertex").assistanceLevel).toBe(0);
    expect(evaluation.scores.independence).toBe(100);
  });

  it("rejects exposed disclosure identities outside the exact problem definition", () => {
    let state = complete(boundState(), "choose-vertex", 20);
    state = addDelivery(
      state,
      DisclosureIdSchema.parse("unmapped_disclosure"),
      3,
      "EXPOSED",
      5,
      "unmapped"
    );

    expect(() => evaluateInterviewSession(state, sixPeopleProblem)).toThrow(
      "disclosure outside the exact problem definition"
    );
  });

  it("abstains on hint responsiveness when exposure ordering is not authoritative", () => {
    let apparentProgress = complete(boundState(), "choose-vertex", 20);
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

  it("does not misclassify invalidated stale evidence as student error recovery", () => {
    const key = milestoneKey("model-relations", "CORRECTNESS");
    let state = boundState();
    state = setHistory(state, key, [
      { value: "CORRECT", sequence: 10, status: "STALE" },
      { value: "CORRECT", sequence: 20, status: "ACTIVE" }
    ]);

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.errorRecovery).toBeNull();
  });

  it("records incomplete and archived lifecycle context without completion-style prose", () => {
    const active: SessionState = {
      ...boundState(),
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
    let state = complete(boundState(), "model-relations", 30);
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
    const state = boundState();
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
    let state = complete(boundState(), "model-relations", 30);
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
    let state = boundState();
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
    let state = complete(boundState(), "choose-vertex", 20);
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
      ...boundState(),
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

  it("rejects duplicate reasoning identities and unknown protected-disclosure references", () => {
    const firstMilestone = sixPeopleProblem.interviewer.reasoningGraph.milestones[0];
    if (firstMilestone === undefined) throw new Error("Expected fixture milestone");

    const duplicateMilestoneProblem: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          ...sixPeopleProblem.interviewer.reasoningGraph,
          milestones: [
            ...sixPeopleProblem.interviewer.reasoningGraph.milestones,
            firstMilestone
          ]
        }
      }
    };
    expect(() => evaluateInterviewSession(
      boundStateFor(duplicateMilestoneProblem),
      duplicateMilestoneProblem
    )).toThrow("duplicate reasoning-graph milestone");

    const missingDisclosure = DisclosureIdSchema.parse("missing_protected_disclosure");
    const unknownDisclosureProblem: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          ...sixPeopleProblem.interviewer.reasoningGraph,
          milestones: sixPeopleProblem.interviewer.reasoningGraph.milestones.map(
            (milestone, index) => index === 0
              ? {
                  ...milestone,
                  protectedDisclosureIds: [
                    ...milestone.protectedDisclosureIds,
                    missingDisclosure
                  ]
                }
              : milestone
          )
        }
      }
    };
    expect(() => evaluateInterviewSession(
      boundStateFor(unknownDisclosureProblem),
      unknownDisclosureProblem
    )).toThrow("unknown protected disclosure");
  });

  it("rejects pathological aggregate evidence provenance before traversing it", () => {
    const key = milestoneKey("model-relations", "JUSTIFICATION");
    const oversized = Array.from(
      { length: 150_001 },
      () => EventIdSchema.parse("oversized_provenance")
    );
    const state = setHistory(boundState(), key, [
      {
        value: "JUSTIFIED",
        sequence: 10,
        status: "ACTIVE"
      }
    ]);
    const keyString = evidenceKeyToString(key);
    const active = state.evidenceHistory[keyString]?.[0];
    if (active === undefined) throw new Error("Expected active fixture evidence");
    const corrupted: SessionState = {
      ...state,
      evidenceHistory: {
        ...state.evidenceHistory,
        [keyString]: [{
          ...active,
          value: {
            ...active.value,
            evidenceEventIds: oversized
          }
        }]
      },
      studentEvidence: {
        ...state.studentEvidence,
        [keyString]: {
          ...active.value,
          evidenceEventIds: oversized
        }
      }
    };

    expect(() => evaluateInterviewSession(corrupted, sixPeopleProblem)).toThrow(
      "supported evidence-provenance bound"
    );
  });

  it("rejects pathological problem fingerprint input before hashing it", () => {
    const oversizedProblem: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        difficulty: "x".repeat(2_000_001)
      }
    };

    expect(() => evaluateInterviewSession(boundState(), oversizedProblem)).toThrow(
      "supported fingerprint-input bound"
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
      ...boundState(),
      turns
    };
    expect(() => evaluateInterviewSession(state, sixPeopleProblem)).toThrow(
      "supported turn bound"
    );
  });

  it("rejects a same-id/version problem whose session-bound fingerprint differs", () => {
    const alteredProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        difficulty: "tampered-evaluation-definition"
      }
    };

    expect(() => evaluateInterviewSession(boundState(), alteredProblem)).toThrow(
      "session-bound problem fingerprint"
    );
  });

  it("rejects active evidence that disagrees with the student-evidence projection", () => {
    const state = setHistory(
      boundState(),
      milestoneKey("model-relations", "PROGRESS"),
      [{ value: "COMPLETE", sequence: 10, status: "ACTIVE" }]
    );
    const inconsistent: SessionState = {
      ...state,
      studentEvidence: {}
    };

    expect(() => evaluateInterviewSession(inconsistent, sixPeopleProblem)).toThrow(
      "active evidence does not match"
    );
  });

  it("rejects evidence for milestone and approach identities outside the reasoning graph", () => {
    const unknownMilestone: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "MILESTONE", milestoneId: "invented-milestone" },
      dimension: "PROGRESS"
    };
    const unknownApproach: EvidenceKey = {
      problemId: sixPeopleProblem.id,
      subject: { kind: "APPROACH", approachId: "invented-approach" },
      dimension: "PROGRESS"
    };

    expect(() => evaluateInterviewSession(
      setHistory(boundState(), unknownMilestone, [
        { value: "COMPLETE", sequence: 10, status: "ACTIVE" }
      ]),
      sixPeopleProblem
    )).toThrow("unknown reasoning-graph milestone");

    expect(() => evaluateInterviewSession(
      setHistory(boundState(), unknownApproach, [
        { value: "PROGRESSING", sequence: 10, status: "ACTIVE" }
      ]),
      sixPeopleProblem
    )).toThrow("unknown reasoning-graph approach");
  });

  it("is invariant to unverified claim-ID splitting over identical provenance", () => {
    const sharedSupport = EventIdSchema.parse("shared_claim_split_support");
    let baseline = setHistory(
      boundState(),
      claimKey("single-correct-claim", "CORRECTNESS"),
      [{
        value: "CORRECT",
        sequence: 10,
        status: "ACTIVE",
        evidenceEventIds: [sharedSupport]
      }]
    );
    baseline = setHistory(
      baseline,
      claimKey("single-error-claim", "CORRECTNESS"),
      [{
        value: "LOCAL_ERROR",
        sequence: 20,
        status: "ACTIVE"
      }]
    );
    const baselineEvaluation = evaluateInterviewSession(baseline, sixPeopleProblem);

    let split = baseline;
    for (let index = 0; index < 20; index += 1) {
      split = setHistory(
        split,
        claimKey("split-correct-" + String(index), "CORRECTNESS"),
        [{
          value: "CORRECT",
          sequence: 30 + index,
          status: "ACTIVE",
          evidenceEventIds: [sharedSupport]
        }]
      );
    }
    const splitEvaluation = evaluateInterviewSession(split, sixPeopleProblem);

    expect(splitEvaluation.scores.technicalCorrectness)
      .toBe(baselineEvaluation.scores.technicalCorrectness);
    expect(splitEvaluation.dimensionResults.technicalCorrectness.supportLevel)
      .toBe(baselineEvaluation.dimensionResults.technicalCorrectness.supportLevel);
  });

  it("does not let claim-ID splitting manufacture extra rigor weight", () => {
    const sharedSupport = EventIdSchema.parse("shared_rigor_split_support");
    let baseline = setHistory(
      boundState(),
      claimKey("single-justified", "JUSTIFICATION"),
      [{
        value: "JUSTIFIED",
        sequence: 10,
        status: "ACTIVE",
        evidenceEventIds: [sharedSupport]
      }]
    );
    baseline = setHistory(
      baseline,
      claimKey("single-unjustified", "JUSTIFICATION"),
      [{
        value: "UNJUSTIFIED",
        sequence: 20,
        status: "ACTIVE"
      }]
    );
    const baselineEvaluation = evaluateInterviewSession(baseline, sixPeopleProblem);

    let split = baseline;
    for (let index = 0; index < 20; index += 1) {
      split = setHistory(
        split,
        claimKey("split-justified-" + String(index), "JUSTIFICATION"),
        [{
          value: "JUSTIFIED",
          sequence: 30 + index,
          status: "ACTIVE",
          evidenceEventIds: [sharedSupport]
        }]
      );
    }
    const splitEvaluation = evaluateInterviewSession(split, sixPeopleProblem);

    expect(splitEvaluation.scores.rigor).toBe(baselineEvaluation.scores.rigor);
    expect(splitEvaluation.dimensionResults.rigor.supportLevel)
      .toBe(baselineEvaluation.dimensionResults.rigor.supportLevel);
  });

  it("does not promote repeated model-inferred rigor evidence to STRONG support", () => {
    let state = boundState();
    for (const [index, claimId] of ["claim-a", "claim-b", "claim-c"].entries()) {
      state = setHistory(state, claimKey(claimId, "JUSTIFICATION"), [
        { value: "JUSTIFIED", sequence: 10 + index, status: "ACTIVE" }
      ]);
    }

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);
    expect(evaluation.scores.rigor).toBe(100);
    expect(evaluation.dimensionResults.rigor.supportLevel).toBe("MODERATE");
  });

  it("fails closed rather than throwing on malformed fallible qualitative proposals", () => {
    const allowed = { kind: "EVIDENCE_EVENT" as const, id: "event_allowed" };
    expect(validateFallibleQualitativeEvaluationProposal(
      { allowedEvidenceRefs: [allowed] },
      {
        dimension: "communication",
        score: 101,
        evidenceRefs: [allowed],
        rationale: "Invalid out-of-range proposal."
      }
    )).toEqual({
      accepted: false,
      reason: "INVALID_PROPOSAL"
    });
  });

  it("requires an approach-switch recovery to occur after the latest same-dimension error", () => {
    let state = setHistory(
      boundState(),
      approachKey("two-colour-graph", "PROGRESS"),
      [
        { value: "REGRESSING", sequence: 10, status: "SUPERSEDED" },
        { value: "REGRESSING", sequence: 30, status: "ACTIVE" }
      ]
    );
    state = setHistory(
      state,
      approachKey("graph-complement", "PROGRESS"),
      [{ value: "PROGRESSING", sequence: 20, status: "ACTIVE" }]
    );

    expect(evaluateInterviewSession(state, sixPeopleProblem).scores.errorRecovery).toBe(0);

    const recovered = setHistory(
      state,
      approachKey("graph-complement", "PROGRESS"),
      [{ value: "PROGRESSING", sequence: 40, status: "ACTIVE" }]
    );
    expect(evaluateInterviewSession(recovered, sixPeopleProblem).scores.errorRecovery).toBe(100);
  });

  it("property: arbitrary meaningless extra turns cannot improve grounded scores", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.string({ minLength: 1, maxLength: 200 }),
      (extraTurns, text) => {
        let state = complete(boundState(), "model-relations", 10);
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

function boundState(): SessionState {
  return boundStateFor(sixPeopleProblem);
}

function boundStateFor(problem: InterviewProblem): SessionState {
  return {
    ...initialSessionState(newSessionId()),
    started: true,
    status: "ACTIVE",
    problem: {
      id: problem.id,
      version: problem.version,
      prompt: problem.public.prompt,
      providerContextSpecSha256: createProviderContextSpecFingerprintSync(problem)
    }
  };
}

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

function claimKey(
  claimId: string,
  dimension: EvidenceKey["dimension"]
): EvidenceKey {
  return {
    problemId: sixPeopleProblem.id,
    subject: { kind: "CLAIM", claimId },
    dimension
  };
}

function approachKey(
  approachId: string,
  dimension: EvidenceKey["dimension"]
): EvidenceKey {
  return {
    problemId: sixPeopleProblem.id,
    subject: { kind: "APPROACH", approachId },
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
    readonly evidenceEventIds?: readonly ReturnType<typeof EventIdSchema.parse>[];
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
      "eval_" + subjectId + "_" + key.dimension + "_" + String(spec.sequence) + "_" + String(index)
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
        inferenceConfidence: 0.95,
        evidenceEventIds: spec.evidenceEventIds === undefined
          ? [
              EventIdSchema.parse(
                "support_" + subjectId + "_" + key.dimension + "_" + String(spec.sequence) + "_" + String(index)
              )
            ]
          : [...spec.evidenceEventIds],
        lastUpdatedSequence: spec.sequence
      },
      status: spec.status,
      ...(spec.status === "SUPERSEDED" ? { supersededByEventId } : {}),
      ...(spec.status === "STALE" ? { invalidationReason: "fixture invalidation" } : {})
    };
  });

  const active = history.find((record) => record.status === "ACTIVE");
  const studentEvidence = active === undefined
    ? Object.fromEntries(
        Object.entries(state.studentEvidence).filter(([candidate]) => candidate !== keyString)
      )
    : { ...state.studentEvidence, [keyString]: active.value };

  let eventIds = [...state.eventIds];
  for (const record of history) {
    for (const provenanceId of record.value.evidenceEventIds) {
      if (!eventIds.includes(provenanceId)) {
        eventIds = placeEventBeforeSequence(
          eventIds,
          provenanceId,
          record.value.lastUpdatedSequence
        );
      }
    }
    eventIds = placeEventAtSequence(
      eventIds,
      record.evidenceEventId,
      record.value.lastUpdatedSequence
    );
  }
  return {
    ...state,
    sequence: Math.max(state.sequence, ...specs.map((item) => item.sequence)),
    eventIds,
    studentEvidence,
    evidenceHistory: {
      ...state.evidenceHistory,
      [keyString]: history
    }
  };
}

function addDelivery(
  state: SessionState,
  disclosureInput: DisclosureId | readonly DisclosureId[],
  level: 0 | 1 | 2 | 3 | 4 | 5,
  status: DeliveryAtom["status"],
  basisSequence: number,
  label: string
): SessionState {
  const disclosureIds: DisclosureId[] =
    typeof disclosureInput === "string"
      ? [disclosureInput]
      : [...disclosureInput];
  const generationId = GenerationIdSchema.parse("generation_adv_" + label);
  const deliveryId = DeliveryIdSchema.parse("delivery_adv_" + label);
  const turnId = TurnIdSchema.parse("turn_adv_basis_" + String(basisSequence));
  const inputEpisodeId = InputEpisodeIdSchema.parse(
    "episode_adv_basis_" + String(basisSequence)
  );
  const turnEventId = EventIdSchema.parse(
    "turn_committed_adv_basis_" + String(basisSequence)
  );
  const atom: DeliveryAtom = {
    deliveryId,
    generationId,
    content: { medium: "TEXT", text: "fixture assistance " + label },
    disclosureIds,
    effectiveDisclosureLevel: level,
    status
  };
  const eventIds = placeEventAtSequence([...state.eventIds], turnEventId, basisSequence);
  const latestCommittedInputSequence = Math.max(
    state.lastCommittedInputSequence ?? 0,
    basisSequence
  );
  return {
    ...state,
    sequence: Math.max(state.sequence, basisSequence),
    eventIds,
    lastCommittedInputSequence: latestCommittedInputSequence,
    inputEpisodes: {
      ...state.inputEpisodes,
      [inputEpisodeId]: {
        inputEpisodeId,
        status: "COMMITTED",
        inputs: [{ modality: "TYPING", semanticContent: "fixture delivery basis" }]
      }
    },
    turns: {
      ...state.turns,
      [turnId]: {
        turnId,
        inputEpisodeId,
        studentText: "fixture delivery basis",
        committedSequence: basisSequence
      }
    },
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
          inputEpisodeId,
          turnId
        },
        provider: "fixture-provider",
        status: "VALIDATED"
      }
    },
    deliveries: {
      ...state.deliveries,
      [deliveryId]: atom
    },
    disclosureLedger:
      status === "EXPOSED" || status === "COMPLETED" || status === "POSSIBLY_EXPOSED"
        ? Array.from(new Set([...state.disclosureLedger, ...disclosureIds]))
        : state.disclosureLedger
  };
}

function addTurns(
  state: SessionState,
  count: number,
  text: string
): SessionState {
  const turns: Record<string, SessionState["turns"][string]> = { ...state.turns };
  const inputEpisodes = { ...state.inputEpisodes };
  let eventIds = [...state.eventIds];
  let sequence = state.sequence;
  for (let index = 0; index < count; index += 1) {
    sequence += 1;
    const turnId = TurnIdSchema.parse("turn_property_" + String(sequence) + "_" + String(index));
    const inputEpisodeId = InputEpisodeIdSchema.parse(
      "episode_property_" + String(sequence) + "_" + String(index)
    );
    eventIds = placeEventAtSequence(
      eventIds,
      EventIdSchema.parse("turn_committed_property_" + String(sequence) + "_" + String(index)),
      sequence
    );
    inputEpisodes[inputEpisodeId] = {
      inputEpisodeId,
      status: "COMMITTED",
      inputs: [{
        modality: "TYPING",
        semanticContent: text.length === 0 ? "meaningless" : text
      }]
    };
    turns[turnId] = {
      turnId,
      inputEpisodeId,
      studentText: text.length === 0 ? "meaningless" : text,
      committedSequence: sequence
    };
  }
  return {
    ...state,
    sequence,
    eventIds,
    inputEpisodes,
    turns,
    ...(count === 0 ? {} : { lastCommittedInputSequence: sequence })
  };
}

function placeEventAtSequence(
  input: readonly ReturnType<typeof EventIdSchema.parse>[],
  eventId: ReturnType<typeof EventIdSchema.parse>,
  sequence: number
): ReturnType<typeof EventIdSchema.parse>[] {
  const eventIds = [...input];
  const existingIndex = eventIds.indexOf(eventId);
  if (existingIndex >= 0 && existingIndex !== sequence - 1) {
    throw new Error("Fixture event is already assigned to a different sequence");
  }
  while (eventIds.length < sequence) {
    eventIds.push(EventIdSchema.parse("adv_padding_event_" + String(eventIds.length + 1)));
  }
  const occupied = eventIds[sequence - 1];
  if (
    occupied !== undefined &&
    !occupied.startsWith("adv_padding_event_") &&
    occupied !== eventId
  ) {
    throw new Error("Fixture sequence is already occupied");
  }
  eventIds[sequence - 1] = eventId;
  return eventIds;
}

function placeEventBeforeSequence(
  input: readonly ReturnType<typeof EventIdSchema.parse>[],
  eventId: ReturnType<typeof EventIdSchema.parse>,
  beforeSequence: number
): ReturnType<typeof EventIdSchema.parse>[] {
  const existingIndex = input.indexOf(eventId);
  if (existingIndex >= 0) {
    if (existingIndex + 1 >= beforeSequence) {
      throw new Error("Fixture provenance must predate its evidence update");
    }
    return [...input];
  }
  for (let sequence = 1; sequence < beforeSequence; sequence += 1) {
    const current = input[sequence - 1];
    if (current === undefined || current.startsWith("adv_padding_event_")) {
      return placeEventAtSequence(input, eventId, sequence);
    }
  }
  throw new Error("Fixture has no sequence available for provenance");
}

