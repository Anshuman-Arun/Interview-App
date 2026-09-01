import { describe, expect, it } from "vitest";
import {
  DeliveryIdSchema,
  DisclosureIdSchema,
  EventIdSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  RequestIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  evidenceKeyToString,
  type DisclosureId,
  type EvidenceKey,
  type EvidenceRating,
  type InterviewProblem,
  type RealizationRequest
} from "../packages/domain/src/index.js";
import {
  initialSessionState,
  type SessionState
} from "../packages/events/src/index.js";
import { biasedCoinProblem, sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  canonicalJson,
  compileContext,
  createProviderContextSpecFingerprintSync,
  decidePedagogicalPolicy
} from "../packages/interview-engine/src/index.js";

let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return prefix + "_" + String(idCounter);
}

function makeState(problem: InterviewProblem = sixPeopleProblem): {
  readonly state: SessionState;
  readonly turnId: SessionState["turns"][string]["turnId"];
} {
  const sessionId = SessionIdSchema.parse(nextId("session_policy"));
  const turnId = TurnIdSchema.parse(nextId("turn_policy"));
  const inputEpisodeId = InputEpisodeIdSchema.parse(nextId("episode_policy"));
  const seedEventIds = Array.from({ length: 10 }, () =>
    EventIdSchema.parse(nextId("event_seed"))
  );
  const initial = initialSessionState(sessionId);
  return {
    turnId,
    state: {
      ...initial,
      sequence: 10,
      started: true,
      status: "ACTIVE",
      problem: {
        id: problem.id,
        version: problem.version,
        prompt: problem.public.prompt,
        providerContextSpecSha256: createProviderContextSpecFingerprintSync(problem)
      },
      lastCommittedInputSequence: 4,
      eventIds: seedEventIds,
      inputEpisodes: {
        [inputEpisodeId]: {
          inputEpisodeId,
          status: "COMMITTED",
          inputs: [{ modality: "TYPING", semanticContent: "student work" }]
        }
      },
      turns: {
        [turnId]: {
          turnId,
          inputEpisodeId,
          studentText: "student work",
          committedSequence: 4
        }
      }
    }
  };
}

function milestoneKey(
  problem: InterviewProblem,
  milestoneId: string,
  dimension: EvidenceKey["dimension"]
): EvidenceKey {
  return {
    problemId: problem.id,
    subject: { kind: "MILESTONE", milestoneId },
    dimension
  };
}

function claimKey(
  problem: InterviewProblem,
  claimId: string,
  dimension: EvidenceKey["dimension"]
): EvidenceKey {
  return {
    problemId: problem.id,
    subject: { kind: "CLAIM", claimId },
    dimension
  };
}

function approachKey(
  problem: InterviewProblem,
  approachId: string,
  dimension: EvidenceKey["dimension"]
): EvidenceKey {
  return {
    problemId: problem.id,
    subject: { kind: "APPROACH", approachId },
    dimension
  };
}

function withEvidence(
  state: SessionState,
  key: EvidenceKey,
  value: EvidenceRating,
  options: {
    readonly status?: "ACTIVE" | "STALE" | "SUPERSEDED";
    readonly confidence?: number;
    readonly duplicateProvenance?: boolean;
  } = {}
): SessionState {
  const eventId = EventIdSchema.parse(nextId("event_evidence"));
  const sequence = state.sequence + 1;
  const provenanceEventId = state.eventIds[Math.max(0, Math.min(
    state.eventIds.length - 1,
    (Object.values(state.turns)[0]?.committedSequence ?? 1) - 1
  ))];
  if (provenanceEventId === undefined) throw new Error("missing evidence provenance");
  const evidenceValue = {
    value,
    inferenceConfidence: options.confidence ?? 0.95,
    evidenceEventIds: options.duplicateProvenance
      ? [provenanceEventId, provenanceEventId]
      : [provenanceEventId],
    lastUpdatedSequence: sequence
  };
  const canonicalKey = evidenceKeyToString(key);
  const status = options.status ?? "ACTIVE";
  const existingHistory = state.evidenceHistory[canonicalKey] ?? [];
  return {
    ...state,
    sequence,
    eventIds: [...state.eventIds, eventId],
    studentEvidence: status === "ACTIVE"
      ? { ...state.studentEvidence, [canonicalKey]: evidenceValue }
      : state.studentEvidence,
    evidenceHistory: {
      ...state.evidenceHistory,
      [canonicalKey]: [
        ...existingHistory,
        {
          evidenceEventId: eventId,
          key,
          value: evidenceValue,
          status
        }
      ]
    }
  };
}

function withAssistance(
  state: SessionState,
  input: {
    readonly target: string;
    readonly action: RealizationRequest["requiredAction"];
    readonly maximumDisclosure: RealizationRequest["maximumDisclosure"];
    readonly effectiveDisclosureLevel?: RealizationRequest["maximumDisclosure"];
    readonly status?: "EXPOSED" | "COMPLETED" | "POSSIBLY_EXPOSED";
    readonly disclosureIds?: readonly DisclosureId[];
    readonly allowedDisclosureIds?: readonly DisclosureId[];
  }
): SessionState {
  const turnId = TurnIdSchema.parse(nextId("turn_assist"));
  const inputEpisodeId = InputEpisodeIdSchema.parse(nextId("episode_assist"));
  const generationId = GenerationIdSchema.parse(nextId("generation_assist"));
  const deliveryId = DeliveryIdSchema.parse(nextId("delivery_assist"));
  const historicalAssistanceCount = Object.values(state.generations)
    .filter((generation) => generation.provider === "policy-test")
    .length;
  const currentTurnSequence = state.lastCommittedInputSequence ?? 4;
  const turnSequence = Math.min(
    Math.max(1, currentTurnSequence - 1),
    historicalAssistanceCount + 1
  );
  const disclosureIds = [...(input.disclosureIds ?? [])];
  const request: RealizationRequest = {
    requiredAction: input.action,
    target: input.target,
    maximumDisclosure: input.maximumDisclosure,
    ...(input.allowedDisclosureIds === undefined
      ? {}
      : { allowedDisclosureIds: [...input.allowedDisclosureIds] })
  };
  return {
    ...state,
    inputEpisodes: {
      ...state.inputEpisodes,
      [inputEpisodeId]: {
        inputEpisodeId,
        status: "COMMITTED",
        inputs: [{ modality: "TYPING", semanticContent: "prior student work" }]
      }
    },
    turns: {
      ...state.turns,
      [turnId]: {
        turnId,
        inputEpisodeId,
        studentText: "prior student work",
        committedSequence: turnSequence
      }
    },
    pedagogicalActions: {
      ...state.pedagogicalActions,
      [turnId]: request
    },
    generations: {
      ...state.generations,
      [generationId]: {
        generationId,
        basis: {
          contextEpoch: state.contextEpoch,
          committedInputSequence: turnSequence,
          transcriptRevision: state.transcriptRevision,
          boardRevision: state.boardRevision,
          problemStateRevision: state.problemStateRevision,
          policyRevision: state.policyRevision,
          inputEpisodeId,
          turnId
        },
        provider: "policy-test",
        pedagogicalAction: request,
        status: "VALIDATED"
      }
    },
    deliveries: {
      ...state.deliveries,
      [deliveryId]: {
        deliveryId,
        generationId,
        content: { medium: "TEXT", text: "reviewed assistance" },
        disclosureIds,
        effectiveDisclosureLevel: input.effectiveDisclosureLevel ?? input.maximumDisclosure,
        status: input.status ?? "EXPOSED"
      }
    },
    disclosureLedger: Array.from(new Set([...state.disclosureLedger, ...disclosureIds]))
  };
}

function withVerification(
  state: SessionState,
  key: EvidenceKey,
  status: "VERIFIED" | "CONTRADICTED" | "UNRESOLVED",
  options: {
    readonly staleBasis?: boolean;
    readonly confidence?: number;
  } = {}
): SessionState {
  const requestId = RequestIdSchema.parse(nextId("request_verify"));
  const requestedEventId = EventIdSchema.parse(nextId("event_verify_request"));
  const resultEventId = EventIdSchema.parse(nextId("event_verify_result"));
  const resultSequence = state.sequence + 2;
  const turn = Object.values(state.turns)[0];
  const provenanceEventId = turn === undefined
    ? undefined
    : state.eventIds[turn.committedSequence - 1];
  if (provenanceEventId === undefined) throw new Error("missing verification provenance");
  return {
    ...state,
    sequence: resultSequence,
    eventIds: [...state.eventIds, requestedEventId, resultEventId],
    verificationRequests: {
      ...state.verificationRequests,
      [requestId]: {
        verificationRequestId: requestId,
        verifier: "deterministic-policy-test",
        basis: {
          contextEpoch: options.staleBasis
            ? ((state.contextEpoch + 1) as SessionState["contextEpoch"])
            : state.contextEpoch,
          committedInputSequence: state.lastCommittedInputSequence ?? 1,
          transcriptRevision: state.transcriptRevision,
          boardRevision: state.boardRevision,
          problemStateRevision: state.problemStateRevision,
          policyRevision: state.policyRevision,
          inputEpisodeId: Object.values(state.turns)[0]?.inputEpisodeId ?? InputEpisodeIdSchema.parse("episode_fallback"),
          turnId: Object.values(state.turns)[0]?.turnId ?? TurnIdSchema.parse("turn_fallback")
        },
        candidateFormalInterpretation: "formal candidate",
        interpretationConfidence: options.confidence ?? 1,
        evidenceKey: key,
        evidenceEventIds: [provenanceEventId],
        requestedEventId,
        status: "ACCEPTED",
        result: {
          status,
          interpretationConfidence: options.confidence ?? 1,
          verifier: "deterministic-policy-test",
          reason: "deterministic test result"
        },
        resultEventId,
        resultSequence
      }
    }
  };
}

function target(kind: "milestone" | "approach" | "claim" | "skill", id: string): string {
  return kind + ":" + id;
}

function makeBranchScopedProblem(): InterviewProblem {
  const branchDisclosureId = DisclosureIdSchema.parse("disclosure_branch_specific_policy_test");
  return {
    ...sixPeopleProblem,
    version: "1.0.0-policy-test",
    interviewer: {
      ...sixPeopleProblem.interviewer,
      reasoningGraph: {
        ...sixPeopleProblem.interviewer.reasoningGraph,
        version: "1.0.0-policy-test",
        milestones: sixPeopleProblem.interviewer.reasoningGraph.milestones.map((milestone) =>
          milestone.id === "close-triangle"
            ? {
                ...milestone,
                protectedDisclosureIds: [...milestone.protectedDisclosureIds, branchDisclosureId]
              }
            : milestone
        )
      },
      protectedDisclosures: [
        ...sixPeopleProblem.interviewer.protectedDisclosures,
        {
          id: branchDisclosureId,
          fact: "Use the branch-specific close-triangle structure.",
          minimumDisclosureLevel: 2,
          equivalentFormulations: ["branch-specific close-triangle structure"]
        }
      ]
    }
  };
}

function makeMergeScopedProblem(): InterviewProblem {
  const leftId = DisclosureIdSchema.parse("disclosure_merge_left_policy_test");
  const rightId = DisclosureIdSchema.parse("disclosure_merge_right_policy_test");
  return {
    ...sixPeopleProblem,
    version: "1.0.0-merge-policy-test",
    interviewer: {
      ...sixPeopleProblem.interviewer,
      reasoningGraph: {
        ...sixPeopleProblem.interviewer.reasoningGraph,
        version: "1.0.0-merge-policy-test",
        milestones: sixPeopleProblem.interviewer.reasoningGraph.milestones.map((milestone) => {
          if (milestone.id === "close-triangle") {
            return { ...milestone, protectedDisclosureIds: [...milestone.protectedDisclosureIds, leftId] };
          }
          if (milestone.id === "complement-case") {
            return { ...milestone, protectedDisclosureIds: [...milestone.protectedDisclosureIds, rightId] };
          }
          return milestone;
        })
      },
      protectedDisclosures: [
        ...sixPeopleProblem.interviewer.protectedDisclosures,
        {
          id: leftId,
          fact: "Use only the two-colour branch fact.",
          minimumDisclosureLevel: 1,
          equivalentFormulations: ["two-colour branch fact"]
        },
        {
          id: rightId,
          fact: "Use only the complement branch fact.",
          minimumDisclosureLevel: 1,
          equivalentFormulations: ["complement branch fact"]
        }
      ]
    }
  };
}

describe("production Socratic policy engine", () => {
  it("waits during clear productive progress", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"), "PROGRESSING");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("PRODUCTIVE_PROGRESS");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
    expect(decision.waitingPreferred).toBe(true);
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("probes an unsupported claim rather than treating it as correct", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, claimKey(sixPeopleProblem, "claim-1", "JUSTIFICATION"), "UNJUSTIFIED");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("UNSUPPORTED_CLAIM");
    expect(decision.realizationRequest.requiredAction).toBe("PROBE_JUSTIFICATION");
  });

  it("clarifies ambiguous active evidence", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, claimKey(sixPeopleProblem, "claim-unclear", "CORRECTNESS"), "UNKNOWN");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("AMBIGUOUS_STATEMENT");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("checks a local error before escalating", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"), "LOCAL_ERROR");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("LOCAL_ERROR");
    expect(decision.realizationRequest.requiredAction).toBe("CHECK_LOCAL_STEP");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("changes representation for a structural error", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "model-relations", "CORRECTNESS"), "STRUCTURAL_ERROR");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("STRUCTURAL_ERROR");
    expect(decision.realizationRequest.requiredAction).toBe("CHANGE_REPRESENTATION");
    expect(decision.realizationRequest.maximumDisclosure).toBe(1);
  });

  it("simplifies the case for a problem misunderstanding", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, claimKey(sixPeopleProblem, "problem-reading", "UNDERSTANDING"), "MISUNDERSTOOD_PROBLEM");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("MISUNDERSTANDING");
    expect(decision.realizationRequest.requiredAction).toBe("SIMPLIFY_CASE");
  });

  it("asks for an example on first genuine stagnation and never jumps directly to a hint", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "STALLED");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("TRUE_STAGNATION");
    expect(decision.realizationRequest.requiredAction).toBe("ASK_FOR_EXAMPLE");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("recognizes valid progress on a non-primary reasoning branch", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "complement-case", "PROGRESS"), "PROGRESSING");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("UNEXPECTED_VALID_APPROACH");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("asks for an alternate solution after one complete approach", () => {
    const { state: base, turnId } = makeState();
    let state = base;
    for (const milestoneId of ["model-relations", "choose-vertex", "close-triangle", "verify"]) {
      state = withEvidence(state, milestoneKey(sixPeopleProblem, milestoneId, "PROGRESS"), "COMPLETE");
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("COMPLETED_PRIMARY_APPROACH");
    expect(decision.realizationRequest.requiredAction).toBe("ASK_ALTERNATE_SOLUTION");
    expect(decision.realizationRequest.target).toBe("approach:graph-complement");
  });

  it("generalizes after all authored approaches are complete", () => {
    const { state: base, turnId } = makeState();
    let state = base;
    for (const milestoneId of ["model-relations", "choose-vertex", "close-triangle", "complement-case", "verify"]) {
      state = withEvidence(state, milestoneKey(sixPeopleProblem, milestoneId, "PROGRESS"), "COMPLETE");
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("GENERALIZE");
  });

  it("escalates a repeated local error only after exposed assistance", () => {
    const { state: base, turnId } = makeState();
    const key = milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS");
    let state = withEvidence(base, key, "LOCAL_ERROR");
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "CHECK_LOCAL_STEP",
      maximumDisclosure: 0
    });
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("FOCUS_ATTENTION");
    expect(decision.realizationRequest.maximumDisclosure).toBe(1);
    expect(decision.escalationJustified).toBe(true);
  });

  it("keeps exposed assistance bound to the action snapshot that its generation actually used", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"),
      "STALLED"
    );
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "ASK_FOR_EXAMPLE",
      maximumDisclosure: 0
    });

    const historicalGeneration = Object.values(state.generations).find(
      (generation) => generation.provider === "policy-test"
    );
    expect(historicalGeneration?.pedagogicalAction).toBeDefined();
    if (historicalGeneration === undefined) throw new Error("missing historical generation");
    const historicalTurnId = historicalGeneration.basis.turnId;

    state = {
      ...state,
      pedagogicalActions: {
        ...state.pedagogicalActions,
        [historicalTurnId]: {
          requiredAction: "EXPLICIT_HINT",
          target: target("milestone", "close-triangle"),
          maximumDisclosure: 4
        }
      }
    };

    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("FOCUS_ATTENTION");
    expect(decision.realizationRequest.maximumDisclosure).toBe(1);
  });

  it("counts POSSIBLY_EXPOSED assistance conservatively", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "STALLED");
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "ASK_FOR_EXAMPLE",
      maximumDisclosure: 0,
      status: "POSSIBLY_EXPOSED"
    });
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("FOCUS_ATTENTION");
  });

  it("does not count cancelled or merely queued assistance as disclosed", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "STALLED");
    const assisted = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "FOCUS_ATTENTION",
      maximumDisclosure: 1
    });
    const deliveryId = Object.keys(assisted.deliveries).at(-1);
    expect(deliveryId).toBeDefined();
    if (deliveryId === undefined) throw new Error("missing delivery");
    const assistedDelivery = assisted.deliveries[deliveryId];
    expect(assistedDelivery).toBeDefined();
    if (assistedDelivery === undefined) throw new Error("missing delivery state");
    state = {
      ...assisted,
      deliveries: {
        ...assisted.deliveries,
        [deliveryId]: {
          ...assistedDelivery,
          status: "CANCELLED"
        }
      }
    };
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("ASK_FOR_EXAMPLE");
  });

  it("moves from focus to directional nudge only after repeated exposed interventions", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "STALLED");
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "ASK_FOR_EXAMPLE",
      maximumDisclosure: 0
    });
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "FOCUS_ATTENTION",
      maximumDisclosure: 1
    });
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("REPEATED_STAGNATION");
    expect(decision.realizationRequest.requiredAction).toBe("DIRECTIONAL_NUDGE");
    expect(decision.realizationRequest.maximumDisclosure).toBe(2);
  });

  it("permits an explicit hint only for a ready target with matching protected metadata", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "COMPLETE");
    state = withEvidence(state, milestoneKey(sixPeopleProblem, "close-triangle", "PROGRESS"), "STALLED");
    for (const action of ["ASK_FOR_EXAMPLE", "FOCUS_ATTENTION", "DIRECTIONAL_NUDGE"] as const) {
      state = withAssistance(state, {
        target: target("milestone", "close-triangle"),
        action,
        maximumDisclosure: action === "DIRECTIONAL_NUDGE" ? 2 : action === "FOCUS_ATTENTION" ? 1 : 0
      });
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    const completeTriangle = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(decision.realizationRequest.requiredAction).toBe("EXPLICIT_HINT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(4);
    expect(completeTriangle).toBeDefined();
    if (completeTriangle !== undefined) {
      expect(decision.realizationRequest.allowedDisclosureIds).toContain(completeTriangle.id);
    }
  });

  it("refuses explicit-hint escalation when graph prerequisites are not satisfied", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "close-triangle", "PROGRESS"), "STALLED");
    for (const action of ["ASK_FOR_EXAMPLE", "FOCUS_ATTENTION", "DIRECTIONAL_NUDGE"] as const) {
      state = withAssistance(state, {
        target: target("milestone", "close-triangle"),
        action,
        maximumDisclosure: action === "DIRECTIONAL_NUDGE" ? 2 : action === "FOCUS_ATTENTION" ? 1 : 0
      });
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).not.toBe("EXPLICIT_HINT");
    expect(decision.realizationRequest.maximumDisclosure).toBeLessThan(4);
  });

  it("does not leak the other branch's protected fact when intervening at a shared merge milestone", () => {
    const problem = makeMergeScopedProblem();
    const { state: base, turnId } = makeState(problem);
    let state = withEvidence(
      base,
      milestoneKey(problem, "choose-vertex", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(problem, "close-triangle", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(problem, "verify", "CORRECTNESS"),
      "STRUCTURAL_ERROR"
    );

    const decision = decidePedagogicalPolicy(state, turnId, problem);
    const left = problem.interviewer.protectedDisclosures.find(
      (item) => item.id === "disclosure_merge_left_policy_test"
    );
    const right = problem.interviewer.protectedDisclosures.find(
      (item) => item.id === "disclosure_merge_right_policy_test"
    );
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(decision.realizationRequest.requiredAction).toBe("CHANGE_REPRESENTATION");
    if (left !== undefined && right !== undefined) {
      expect(decision.realizationRequest.allowedDisclosureIds ?? []).toContain(left.id);
      expect(decision.realizationRequest.allowedDisclosureIds ?? []).not.toContain(right.id);
    }
  });

  it("does not authorize an uncompleted optional predecessor within the same approach", () => {
    const leftId = DisclosureIdSchema.parse("disclosure_same_approach_left");
    const rightId = DisclosureIdSchema.parse("disclosure_same_approach_right");
    const problem: InterviewProblem = {
      id: "same-approach-optional-policy-test",
      version: "1.0.0",
      public: {
        prompt: "Test optional same-approach prerequisite disclosure isolation.",
        givenInformation: []
      },
      interviewer: {
        topics: ["test"],
        difficulty: "test",
        reasoningGraph: {
          version: "1.0.0",
          approaches: [{ id: "single-approach", label: "Single approach" }],
          milestones: [
            {
              id: "root",
              description: "Establish the shared root.",
              approachIds: ["single-approach"],
              optionalPrerequisiteIds: [],
              protectedDisclosureIds: []
            },
            {
              id: "left",
              description: "Take the left optional route.",
              approachIds: ["single-approach"],
              optionalPrerequisiteIds: ["root"],
              protectedDisclosureIds: [leftId]
            },
            {
              id: "right",
              description: "Take the right optional route.",
              approachIds: ["single-approach"],
              optionalPrerequisiteIds: ["root"],
              protectedDisclosureIds: [rightId]
            },
            {
              id: "merge",
              description: "Continue after either optional route.",
              approachIds: ["single-approach"],
              optionalPrerequisiteIds: ["left", "right"],
              protectedDisclosureIds: []
            }
          ],
          edges: [
            { from: "root", to: "left" },
            { from: "root", to: "right" },
            { from: "left", to: "merge" },
            { from: "right", to: "merge" }
          ],
          commonErrors: [],
          extensions: []
        },
        protectedDisclosures: [
          {
            id: leftId,
            fact: "Use the completed left route.",
            minimumDisclosureLevel: 1,
            equivalentFormulations: ["completed left route"]
          },
          {
            id: rightId,
            fact: "Use the uncompleted right route.",
            minimumDisclosureLevel: 1,
            equivalentFormulations: ["uncompleted right route"]
          }
        ]
      },
      private: {
        canonicalSolution: "private",
        verificationNotes: "private"
      }
    };

    const { state: base, turnId } = makeState(problem);
    let state = withEvidence(
      base,
      milestoneKey(problem, "root", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(problem, "left", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(problem, "merge", "CORRECTNESS"),
      "STRUCTURAL_ERROR"
    );

    const decision = decidePedagogicalPolicy(state, turnId, problem);
    expect(decision.realizationRequest.requiredAction).toBe("CHANGE_REPRESENTATION");
    expect(decision.realizationRequest.allowedDisclosureIds ?? []).toContain(leftId);
    expect(decision.realizationRequest.allowedDisclosureIds ?? []).not.toContain(rightId);
  });

  it("does not authorize a protected disclosure from an unrelated branch", () => {
    const problem = makeBranchScopedProblem();
    const { state: base, turnId } = makeState(problem);
    let state = withEvidence(base, milestoneKey(problem, "choose-vertex", "PROGRESS"), "STALLED");
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "ASK_FOR_EXAMPLE",
      maximumDisclosure: 0
    });
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "FOCUS_ATTENTION",
      maximumDisclosure: 1
    });
    const branchDisclosure = problem.interviewer.protectedDisclosures.at(-1);
    expect(branchDisclosure).toBeDefined();
    if (branchDisclosure !== undefined) {
      state = withAssistance(state, {
        target: target("milestone", "close-triangle"),
        action: "DIRECTIONAL_NUDGE",
        maximumDisclosure: 2,
        effectiveDisclosureLevel: 2,
        disclosureIds: [branchDisclosure.id],
        allowedDisclosureIds: [branchDisclosure.id]
      });
    }

    const decision = decidePedagogicalPolicy(state, turnId, problem);
    expect(decision.realizationRequest.requiredAction).toBe("DIRECTIONAL_NUDGE");
    if (branchDisclosure !== undefined) {
      expect(decision.realizationRequest.allowedDisclosureIds ?? []).not.toContain(branchDisclosure.id);
    }
  });

  it("suppresses repeated high-disclosure assistance after an exposed explicit hint", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "close-triangle", "PROGRESS"), "STALLED");
    state = withAssistance(state, {
      target: target("milestone", "close-triangle"),
      action: "EXPLICIT_HINT",
      maximumDisclosure: 4,
      effectiveDisclosureLevel: 4,
      status: "POSSIBLY_EXPOSED"
    });
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("ASSISTANCE_SATURATED");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("de-escalates safely when new evidence shows productive progress", () => {
    const { state: base, turnId } = makeState();
    let state = withAssistance(base, {
      target: target("milestone", "choose-vertex"),
      action: "DIRECTIONAL_NUDGE",
      maximumDisclosure: 2
    });
    state = withEvidence(state, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "PROGRESSING");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("ignores stale evidence", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "STALLED", { status: "STALE" });
    state = withEvidence(state, milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"), "PROGRESSING");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("ignores superseded evidence", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"), "STRUCTURAL_ERROR", { status: "SUPERSEDED" });
    state = withEvidence(state, milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"), "PROGRESSING");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("does not double-count duplicated evidence provenance", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"),
      "STALLED",
      { duplicateProvenance: true }
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("ASK_FOR_EXAMPLE");
  });

  it("handles contradictory active signals conservatively", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "COMPLETE");
    state = withEvidence(state, milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"), "STRUCTURAL_ERROR");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("CONFLICTING_ACTIVE_SIGNALS");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("distinguishes committed evidence from unverified model evidence proposals", () => {
    const { state: base, turnId } = makeState();
    const eventId = base.eventIds[0];
    expect(eventId).toBeDefined();
    if (eventId === undefined) throw new Error("missing event");
    const state: SessionState = {
      ...base,
      evidenceProposals: [{
        key: milestoneKey(sixPeopleProblem, "model-relations", "CORRECTNESS"),
        proposedValue: "CORRECT",
        inferenceConfidence: 1,
        evidenceEventIds: [eventId]
      }]
    };
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision.realizationRequest.requiredAction).toBe("PROBE_JUSTIFICATION");
  });

  it("uses compatible deterministic verification without treating provider proposals as authority", () => {
    const { state: base, turnId } = makeState();
    const key = claimKey(sixPeopleProblem, "verified-claim", "CORRECTNESS");
    const state = withVerification(base, key, "VERIFIED");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("PRODUCTIVE_PROGRESS");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("asks for local checking on a deterministic contradiction", () => {
    const { state: base, turnId } = makeState();
    const key = claimKey(sixPeopleProblem, "contradicted-claim", "CORRECTNESS");
    const state = withVerification(base, key, "CONTRADICTED");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("LOCAL_ERROR");
    expect(decision.realizationRequest.requiredAction).toBe("CHECK_LOCAL_STEP");
  });

  it("orders accepted verification by result arrival rather than request creation", () => {
    const { state: base, turnId } = makeState();
    const verified = withVerification(
      base,
      claimKey(sixPeopleProblem, "delayed-verified-claim", "CORRECTNESS"),
      "VERIFIED"
    );
    const withLowConfidence = withEvidence(
      verified,
      claimKey(sixPeopleProblem, "newer-ambiguous-claim", "CORRECTNESS"),
      "LOCAL_ERROR",
      { confidence: 0.69 }
    );

    const verificationEntry = Object.values(withLowConfidence.verificationRequests)[0];
    const evidenceEntry = Object.entries(withLowConfidence.evidenceHistory)
      .find(([key]) => key.includes("newer-ambiguous-claim"));
    expect(verificationEntry?.resultEventId).toBeDefined();
    expect(evidenceEntry?.[1][0]).toBeDefined();
    if (
      verificationEntry?.resultEventId === undefined
      || verificationEntry.resultSequence === undefined
      || evidenceEntry?.[1][0] === undefined
    ) throw new Error("missing delayed verification fixture");

    const requestId = verificationEntry.requestedEventId;
    const resultId = verificationEntry.resultEventId;
    const evidenceId = evidenceEntry[1][0].evidenceEventId;
    const reorderedEventIds = [
      ...base.eventIds,
      requestId,
      evidenceId,
      resultId
    ];
    const evidenceValue = {
      ...evidenceEntry[1][0].value,
      lastUpdatedSequence: base.sequence + 2
    };
    const canonicalEvidenceKey = evidenceEntry[0];
    const state: SessionState = {
      ...withLowConfidence,
      sequence: reorderedEventIds.length,
      eventIds: reorderedEventIds,
      studentEvidence: {
        ...withLowConfidence.studentEvidence,
        [canonicalEvidenceKey]: evidenceValue
      },
      evidenceHistory: {
        ...withLowConfidence.evidenceHistory,
        [canonicalEvidenceKey]: [{
          ...evidenceEntry[1][0],
          value: evidenceValue
        }]
      },
      verificationRequests: {
        ...withLowConfidence.verificationRequests,
        [verificationEntry.verificationRequestId]: {
          ...verificationEntry,
          resultSequence: base.sequence + 3
        }
      }
    };

    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("PRODUCTIVE_PROGRESS");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("ignores verification whose GenerationBasis is no longer compatible", () => {
    const { state: base, turnId } = makeState();
    const key = claimKey(sixPeopleProblem, "stale-verification", "CORRECTNESS");
    const state = withVerification(base, key, "CONTRADICTED", { staleBasis: true });
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision.realizationRequest.requiredAction).toBe("PROBE_JUSTIFICATION");
  });

  it("does not turn absent evidence into negative evidence", () => {
    const { state, turnId } = makeState();
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision.realizationRequest.requiredAction).toBe("PROBE_JUSTIFICATION");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("fails closed for an invalid milestone evidence target", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "missing-milestone", "PROGRESS"), "STALLED");
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("INVALID_REASONING_TARGET");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("fails closed when runtime data contains an unexpected delivery enum", () => {
    const { state: base, turnId } = makeState();
    const malformed = {
      ...base,
      deliveries: {
        bad: {
          deliveryId: "bad",
          generationId: "bad-generation",
          content: { medium: "TEXT", text: "bad" },
          disclosureIds: [],
          effectiveDisclosureLevel: 5,
          status: "BROKEN"
        }
      }
    } as unknown as SessionState;
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("handles large bounded stale histories without recursion or escalation", () => {
    const { state: base, turnId } = makeState();
    const key = milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS");
    const canonical = evidenceKeyToString(key);
    const records = Array.from({ length: 1_000 }, (_, index) => {
      const eventId = EventIdSchema.parse("event_stale_" + String(index));
      return {
        evidenceEventId: eventId,
        key,
        value: {
          value: "STALLED" as const,
          inferenceConfidence: 1,
          evidenceEventIds: [eventId],
          lastUpdatedSequence: 1
        },
        status: "STALE" as const
      };
    });
    const eventIds = [...base.eventIds, ...records.map((record) => record.evidenceEventId)];
    const state: SessionState = {
      ...base,
      sequence: eventIds.length,
      eventIds,
      evidenceHistory: { [canonical]: records }
    };
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("fails closed above the evidence-key resource bound", () => {
    const { state: base, turnId } = makeState();
    const tooMany = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => ["key-" + String(index), []] as const)
    );
    const malformed = { ...base, evidenceHistory: tooMany } as unknown as SessionState;
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("is deterministic across repeated identical calls", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"), "STALLED");
    expect(decidePedagogicalPolicy(state, turnId, sixPeopleProblem)).toEqual(
      decidePedagogicalPolicy(state, turnId, sixPeopleProblem)
    );
  });

  it("does not depend on object insertion order", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(base, claimKey(sixPeopleProblem, "claim-z", "STUDENT_CONFIDENCE"), "UNCERTAIN");
    state = withEvidence(state, milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"), "PROGRESSING");
    const reversedHistory = Object.fromEntries(Object.entries(state.evidenceHistory).reverse());
    const reversedEvidence = Object.fromEntries(Object.entries(state.studentEvidence).reverse());
    const reordered: SessionState = {
      ...state,
      evidenceHistory: reversedHistory,
      studentEvidence: reversedEvidence
    };
    expect(decidePedagogicalPolicy(reordered, turnId, sixPeopleProblem)).toEqual(
      decidePedagogicalPolicy(state, turnId, sixPeopleProblem)
    );
  });

  it("does not infer approach completion from shared setup milestones alone", () => {
    const { state: base, turnId } = makeState(biasedCoinProblem);
    let state = withEvidence(
      base,
      milestoneKey(biasedCoinProblem, "toss-in-pairs-concept", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(biasedCoinProblem, "expected-value-derivation", "PROGRESS"),
      "COMPLETE"
    );

    const decision = decidePedagogicalPolicy(state, turnId, biasedCoinProblem);
    expect(decision.classification).not.toBe("COMPLETED_PRIMARY_APPROACH");
    expect(decision.realizationRequest.requiredAction).not.toBe("ASK_ALTERNATE_SOLUTION");
    expect(decision.realizationRequest.requiredAction).not.toBe("GENERALIZE");
  });

  it("bounds canonical JSON nesting before recursive input can exhaust the stack", () => {
    let value: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) value = { nested: value };
    expect(() => canonicalJson(value)).toThrow(/nesting depth/u);
  });

  it("recognizes authoritative approach-level completion without inventing missing milestone facts", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(
      base,
      approachKey(sixPeopleProblem, "graph-complement", "PROGRESS"),
      "COMPLETE"
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("COMPLETED_PRIMARY_APPROACH");
    expect(decision.realizationRequest.requiredAction).toBe("ASK_ALTERNATE_SOLUTION");
    expect(decision.realizationRequest.target).toBe("approach:two-colour-graph");
  });

  it("fails closed when the active evidence projection disagrees with evidence history", () => {
    const { state: base, turnId } = makeState();
    const valid = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"),
      "PROGRESSING"
    );
    const malformed: SessionState = {
      ...valid,
      studentEvidence: {}
    };
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("rejects a rating that is valid globally but impossible for its evidence dimension", () => {
    const { state: base, turnId } = makeState();
    const malformed = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "model-relations", "CORRECTNESS"),
      "PROGRESSING"
    );
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("bounds malformed direct TurnIds without echoing attacker-sized targets", () => {
    const { state } = makeState();
    const oversizedTurnId = "x".repeat(10_000);
    const decision = decidePedagogicalPolicy(state, oversizedTurnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.target).toBe("turn:invalid-turn");
    expect(JSON.stringify(decision).length).toBeLessThan(2_000);
  });

  it("does not treat prototype properties as authoritative turns", () => {
    const { state } = makeState();
    const decision = decidePedagogicalPolicy(state, "__proto__", sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("fails closed when the direct policy API is asked about a stale committed turn", () => {
    const { state: base, turnId } = makeState();
    const staleTurn = base.turns[turnId];
    expect(staleTurn).toBeDefined();
    if (staleTurn === undefined) throw new Error("missing stale turn");
    const newerEpisodeId = InputEpisodeIdSchema.parse(nextId("episode_newer_policy"));
    const newerTurnId = TurnIdSchema.parse(nextId("turn_newer_policy"));
    const state: SessionState = {
      ...base,
      lastCommittedInputSequence: base.sequence,
      inputEpisodes: {
        ...base.inputEpisodes,
        [newerEpisodeId]: {
          inputEpisodeId: newerEpisodeId,
          status: "COMMITTED",
          inputs: [{ modality: "TYPING", semanticContent: "newer student work" }]
        }
      },
      turns: {
        ...base.turns,
        [newerTurnId]: {
          turnId: newerTurnId,
          inputEpisodeId: newerEpisodeId,
          studentText: "newer student work",
          committedSequence: base.sequence
        }
      }
    };

    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("STALE_TURN_CONTEXT");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("handles an empty committed turn conservatively", () => {
    const { state: base, turnId } = makeState();
    const turn = base.turns[turnId];
    expect(turn).toBeDefined();
    if (turn === undefined) throw new Error("missing turn");
    const state: SessionState = {
      ...base,
      turns: {
        ...base.turns,
        [turnId]: { ...turn, studentText: "" }
      }
    };
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("INSUFFICIENT_EVIDENCE");
    expect(decision.realizationRequest.requiredAction).toBe("PROBE_JUSTIFICATION");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("does not depend on the wall clock", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"),
      "PROGRESSING"
    );
    const before = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    const dateNow = Date.now;
    try {
      Date.now = () => 4_102_444_800_000;
      expect(decidePedagogicalPolicy(state, turnId, sixPeopleProblem)).toEqual(before);
    } finally {
      Date.now = dateNow;
    }
  });

  it("targets the newest active contradiction instead of the alphabetically first one", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "model-relations", "CORRECTNESS"),
      "LOCAL_ERROR"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"),
      "STRUCTURAL_ERROR"
    );

    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("AMBIGUOUS_STATEMENT");
    expect(decision.reasonCode).toBe("CONFLICTING_ACTIVE_SIGNALS");
    expect(decision.realizationRequest.target).toBe("milestone:choose-vertex");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("does not let an older error on an abandoned branch override newer alternate-branch progress", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "close-triangle", "CORRECTNESS"),
      "LOCAL_ERROR"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "complement-case", "PROGRESS"),
      "PROGRESSING"
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("UNEXPECTED_VALID_APPROACH");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("does honor a newer branch-specific error after earlier alternate-branch progress", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "complement-case", "PROGRESS"),
      "PROGRESSING"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "close-triangle", "CORRECTNESS"),
      "LOCAL_ERROR"
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("LOCAL_ERROR");
    expect(decision.realizationRequest.requiredAction).toBe("CHECK_LOCAL_STEP");
  });

  it("does not announce completion while an active error remains on the completed branch", () => {
    const { state: base, turnId } = makeState();
    let state = base;
    for (const milestoneId of ["model-relations", "choose-vertex", "close-triangle", "verify"]) {
      state = withEvidence(
        state,
        milestoneKey(sixPeopleProblem, milestoneId, "PROGRESS"),
        "COMPLETE"
      );
    }
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "close-triangle", "CORRECTNESS"),
      "STRUCTURAL_ERROR"
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).not.toBe("COMPLETED_PRIMARY_APPROACH");
    expect(decision.realizationRequest.requiredAction).not.toBe("ASK_ALTERNATE_SOLUTION");
    expect(decision.realizationRequest.requiredAction).not.toBe("GENERALIZE");
  });

  it("treats high-confidence positive correctness evidence as productive without inventing proof completion", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"),
      "CORRECT"
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("PRODUCTIVE_PROGRESS");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
  });

  it("does not turn low-confidence error evidence into a confident correction", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"),
      "LOCAL_ERROR",
      { confidence: 0.69 }
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("AMBIGUOUS_STATEMENT");
    expect(decision.realizationRequest.requiredAction).toBe("CLARIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("lets productive evidence de-escalate even after high-disclosure assistance on the same target", () => {
    const { state: base, turnId } = makeState();
    let state = withAssistance(base, {
      target: target("milestone", "choose-vertex"),
      action: "EXPLICIT_HINT",
      maximumDisclosure: 4,
      effectiveDisclosureLevel: 4
    });
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "choose-vertex", "CORRECTNESS"),
      "CORRECT"
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("PRODUCTIVE_PROGRESS");
    expect(decision.realizationRequest.requiredAction).toBe("WAIT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("does not let legacy vague-target assistance escalate an unrelated milestone", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "close-triangle", "PROGRESS"),
      "STALLED"
    );
    for (let index = 0; index < 3; index += 1) {
      state = withAssistance(state, {
        target: "the student's most recent asserted step",
        action: "PROBE_JUSTIFICATION",
        maximumDisclosure: 0
      });
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("ASK_FOR_EXAMPLE");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("can escalate repeated local failure to an explicit hint only when target metadata authorizes it", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "close-triangle", "CORRECTNESS"),
      "LOCAL_ERROR"
    );
    for (const action of ["CHECK_LOCAL_STEP", "FOCUS_ATTENTION", "DIRECTIONAL_NUDGE"] as const) {
      state = withAssistance(state, {
        target: target("milestone", "close-triangle"),
        action,
        maximumDisclosure: action === "DIRECTIONAL_NUDGE" ? 2 : action === "FOCUS_ATTENTION" ? 1 : 0
      });
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("EXPLICIT_HINT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(4);
  });

  it("allows an already-exposed relevant fact to be referenced without opening unrelated disclosures", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing choose-person disclosure");

    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"),
      "STALLED"
    );
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "DIRECTIONAL_NUDGE",
      maximumDisclosure: 2,
      effectiveDisclosureLevel: 2,
      disclosureIds: [disclosure.id],
      allowedDisclosureIds: [disclosure.id]
    });
    state = withAssistance(state, {
      target: target("milestone", "choose-vertex"),
      action: "FOCUS_ATTENTION",
      maximumDisclosure: 1
    });
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).toBe("DIRECTIONAL_NUDGE");
    expect(decision.realizationRequest.allowedDisclosureIds ?? []).toContain(disclosure.id);
    const unrelated = sixPeopleProblem.interviewer.protectedDisclosures[1];
    if (unrelated !== undefined) {
      expect(decision.realizationRequest.allowedDisclosureIds ?? []).not.toContain(unrelated.id);
    }
  });

  it("fails closed if same-ID/version problem metadata differs from the session-bound definition", () => {
    const { state, turnId } = makeState();
    const tampered: InterviewProblem = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          ...sixPeopleProblem.interviewer.reasoningGraph,
          milestones: sixPeopleProblem.interviewer.reasoningGraph.milestones.map((milestone) =>
            milestone.id === "model-relations"
              ? { ...milestone, description: "tampered policy target description" }
              : milestone
          )
        }
      }
    };
    const decision = decidePedagogicalPolicy(state, turnId, tampered);
    expect(decision.reasonCode).toBe("PROBLEM_DEFINITION_MISMATCH");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("rejects evidence whose authoritative sequence does not match its evidence-update event", () => {
    const { state: base, turnId } = makeState();
    const valid = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "model-relations", "PROGRESS"),
      "PROGRESSING"
    );
    const [canonicalKey, history] = Object.entries(valid.evidenceHistory)[0] ?? [];
    expect(canonicalKey).toBeDefined();
    expect(history?.[0]).toBeDefined();
    if (canonicalKey === undefined || history?.[0] === undefined) throw new Error("missing evidence fixture");
    const badValue = {
      ...history[0].value,
      lastUpdatedSequence: history[0].value.lastUpdatedSequence - 1
    };
    const malformed: SessionState = {
      ...valid,
      studentEvidence: { ...valid.studentEvidence, [canonicalKey]: badValue },
      evidenceHistory: {
        ...valid.evidenceHistory,
        [canonicalKey]: [{ ...history[0], value: badValue }]
      }
    };
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("rejects verification state whose map key and embedded request ID disagree", () => {
    const { state: base, turnId } = makeState();
    const verified = withVerification(
      base,
      claimKey(sixPeopleProblem, "verification-id-mismatch", "CORRECTNESS"),
      "VERIFIED"
    );
    const entry = Object.entries(verified.verificationRequests)[0];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error("missing verification fixture");
    const malformed: SessionState = {
      ...verified,
      verificationRequests: { different_request_key: entry[1] }
    };
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("rejects a disclosure ledger that forgets an exposed protected fact", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");

    const { state: base, turnId } = makeState();
    const exposed = withAssistance(base, {
      target: target("milestone", "choose-vertex"),
      action: "DIRECTIONAL_NUDGE",
      maximumDisclosure: 2,
      effectiveDisclosureLevel: 2,
      disclosureIds: [disclosure.id],
      allowedDisclosureIds: [disclosure.id]
    });
    const malformed: SessionState = { ...exposed, disclosureLedger: [] };
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("fails before deep parsing when a milestone exceeds the bounded prerequisite fan-in", () => {
    const { state, turnId } = makeState();
    const malformed = {
      ...sixPeopleProblem,
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          ...sixPeopleProblem.interviewer.reasoningGraph,
          milestones: sixPeopleProblem.interviewer.reasoningGraph.milestones.map((milestone, index) =>
            index === 0
              ? {
                  ...milestone,
                  optionalPrerequisiteIds: Array.from({ length: 2_049 }, () => "choose-vertex")
                }
              : milestone
          )
        }
      }
    } as unknown as InterviewProblem;
    const decision = decidePedagogicalPolicy(state, turnId, malformed);
    expect(decision.reasonCode).toBe("RESOURCE_LIMIT_EXCEEDED");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("keeps an authorized disclosure out of the provider forbidden-disclosure set", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    const other = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(disclosure).toBeDefined();
    expect(other).toBeDefined();
    if (disclosure === undefined || other === undefined) throw new Error("missing protected disclosures");

    const { state: base, turnId } = makeState();
    const realizationRequest: RealizationRequest = {
      requiredAction: "DIRECTIONAL_NUDGE",
      target: target("milestone", "choose-vertex"),
      maximumDisclosure: 2,
      allowedDisclosureIds: [disclosure.id]
    };
    const state: SessionState = {
      ...base,
      pedagogicalActions: {
        ...base.pedagogicalActions,
        [turnId]: realizationRequest
      }
    };
    const context = compileContext({
      state,
      problem: sixPeopleProblem,
      turnId,
      realizationRequest
    });
    expect(context.forbiddenDisclosureIds).not.toContain(disclosure.id);
    expect(context.forbiddenDisclosureIds).toContain(other.id);
  });

  it("rejects direct context compilation for a stale committed turn", () => {
    const { state: base, turnId } = makeState();
    const newerEpisodeId = InputEpisodeIdSchema.parse(nextId("episode_newer_context"));
    const newerTurnId = TurnIdSchema.parse(nextId("turn_newer_context"));
    const request: RealizationRequest = {
      requiredAction: "PROBE_JUSTIFICATION",
      target: `turn:${turnId}`,
      maximumDisclosure: 0
    };
    const state: SessionState = {
      ...base,
      lastCommittedInputSequence: base.sequence,
      pedagogicalActions: {
        ...base.pedagogicalActions,
        [turnId]: request
      },
      inputEpisodes: {
        ...base.inputEpisodes,
        [newerEpisodeId]: {
          inputEpisodeId: newerEpisodeId,
          status: "COMMITTED",
          inputs: [{ modality: "TYPING", semanticContent: "newer context work" }]
        }
      },
      turns: {
        ...base.turns,
        [newerTurnId]: {
          turnId: newerTurnId,
          inputEpisodeId: newerEpisodeId,
          studentText: "newer context work",
          committedSequence: base.sequence
        }
      }
    };

    expect(() => compileContext({
      state,
      problem: sixPeopleProblem,
      turnId,
      realizationRequest: request
    })).toThrow(/latest committed Turn/u);
  });

  it("keeps previously exposed but currently unauthorized protected facts forbidden", () => {
    const currentlyAllowed = sixPeopleProblem.interviewer.protectedDisclosures[0];
    const previouslyExposed = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(currentlyAllowed).toBeDefined();
    expect(previouslyExposed).toBeDefined();
    if (currentlyAllowed === undefined || previouslyExposed === undefined) {
      throw new Error("missing disclosure fixtures");
    }

    const { state: base, turnId } = makeState();
    let state = withAssistance(base, {
      target: target("milestone", "close-triangle"),
      action: "EXPLICIT_HINT",
      maximumDisclosure: 4,
      effectiveDisclosureLevel: 4,
      disclosureIds: [previouslyExposed.id],
      allowedDisclosureIds: [previouslyExposed.id]
    });
    const request: RealizationRequest = {
      requiredAction: "DIRECTIONAL_NUDGE",
      target: target("milestone", "choose-vertex"),
      maximumDisclosure: 2,
      allowedDisclosureIds: [currentlyAllowed.id]
    };
    state = {
      ...state,
      pedagogicalActions: {
        ...state.pedagogicalActions,
        [turnId]: request
      }
    };

    const context = compileContext({
      state,
      problem: sixPeopleProblem,
      turnId,
      realizationRequest: request
    });
    expect(context.deliveredFacts).toContain(previouslyExposed.id);
    expect(context.forbiddenDisclosureIds).toContain(previouslyExposed.id);
    expect(context.forbiddenDisclosureIds).not.toContain(currentlyAllowed.id);
  });

  it("rejects provider context when target authorization exceeds its numeric disclosure ceiling", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing level-four disclosure");

    const { state: base, turnId } = makeState();
    const realizationRequest: RealizationRequest = {
      requiredAction: "DIRECTIONAL_NUDGE",
      target: target("milestone", "close-triangle"),
      maximumDisclosure: 2,
      allowedDisclosureIds: [disclosure.id]
    };
    const state: SessionState = {
      ...base,
      pedagogicalActions: {
        ...base.pedagogicalActions,
        [turnId]: realizationRequest
      }
    };

    expect(() => compileContext({
      state,
      problem: sixPeopleProblem,
      turnId,
      realizationRequest
    })).toThrow(/above its numeric ceiling/u);
  });

  it("rejects provider context for a bound problem with duplicate protected disclosure IDs", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");
    const duplicateProblem: InterviewProblem = {
      ...sixPeopleProblem,
      version: "1.0.0-duplicate-disclosure-context-test",
      interviewer: {
        ...sixPeopleProblem.interviewer,
        protectedDisclosures: [
          ...sixPeopleProblem.interviewer.protectedDisclosures,
          { ...disclosure }
        ]
      }
    };
    const { state: base, turnId } = makeState(duplicateProblem);
    const realizationRequest: RealizationRequest = {
      requiredAction: "PROBE_JUSTIFICATION",
      target: `turn:${turnId}`,
      maximumDisclosure: 0
    };
    const state: SessionState = {
      ...base,
      pedagogicalActions: {
        ...base.pedagogicalActions,
        [turnId]: realizationRequest
      }
    };

    expect(() => compileContext({
      state,
      problem: duplicateProblem,
      turnId,
      realizationRequest
    })).toThrow(/duplicate protected disclosure IDs/u);
  });

  it("does not let low-confidence completion unlock a downstream protected hint", () => {
    const { state: base, turnId } = makeState();
    let state = withEvidence(
      base,
      milestoneKey(sixPeopleProblem, "choose-vertex", "PROGRESS"),
      "COMPLETE",
      { confidence: 0.69 }
    );
    state = withEvidence(
      state,
      milestoneKey(sixPeopleProblem, "close-triangle", "PROGRESS"),
      "STALLED"
    );
    for (const action of ["ASK_FOR_EXAMPLE", "FOCUS_ATTENTION", "DIRECTIONAL_NUDGE"] as const) {
      state = withAssistance(state, {
        target: target("milestone", "close-triangle"),
        action,
        maximumDisclosure: action === "DIRECTIONAL_NUDGE" ? 2 : action === "FOCUS_ATTENTION" ? 1 : 0
      });
    }
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.realizationRequest.requiredAction).not.toBe("EXPLICIT_HINT");
    expect(decision.realizationRequest.maximumDisclosure).toBeLessThan(4);
  });

  it("treats a low-confidence accepted contradiction as unresolved rather than a correction", () => {
    const { state: base, turnId } = makeState();
    const state = withVerification(
      base,
      claimKey(sixPeopleProblem, "low-confidence-verification", "CORRECTNESS"),
      "CONTRADICTED",
      { confidence: 0.6 }
    );
    const decision = decidePedagogicalPolicy(state, turnId, sixPeopleProblem);
    expect(decision.classification).toBe("AMBIGUOUS_STATEMENT");
    expect(decision.realizationRequest.requiredAction).toBe("VERIFY");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("requires every same-approach predecessor before authorizing a protected join", () => {
    const disclosureId = DisclosureIdSchema.parse("disclosure_same_approach_join");
    const problem: InterviewProblem = {
      ...sixPeopleProblem,
      id: "same-approach-join-test",
      version: "1.0.0",
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          version: "1.0.0",
          approaches: [{ id: "approach-a", label: "Approach A" }],
          milestones: [
            {
              id: "parent-a",
              description: "First required parent.",
              approachIds: ["approach-a"],
              optionalPrerequisiteIds: [],
              protectedDisclosureIds: []
            },
            {
              id: "parent-b",
              description: "Second required parent.",
              approachIds: ["approach-a"],
              optionalPrerequisiteIds: [],
              protectedDisclosureIds: []
            },
            {
              id: "join",
              description: "Join requiring both parents.",
              approachIds: ["approach-a"],
              optionalPrerequisiteIds: ["parent-a", "parent-b"],
              protectedDisclosureIds: [disclosureId]
            }
          ],
          edges: [],
          commonErrors: [],
          extensions: []
        },
        protectedDisclosures: [{
          id: disclosureId,
          fact: "Use both completed parent arguments at the join.",
          minimumDisclosureLevel: 1,
          equivalentFormulations: ["use both parent arguments"]
        }]
      }
    };

    const { state: base, turnId } = makeState(problem);
    let state = withEvidence(
      base,
      milestoneKey(problem, "parent-a", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(problem, "join", "CORRECTNESS"),
      "STRUCTURAL_ERROR"
    );

    const premature = decidePedagogicalPolicy(state, turnId, problem);
    expect(premature.realizationRequest).toMatchObject({
      requiredAction: "CHANGE_REPRESENTATION",
      maximumDisclosure: 1,
      allowedDisclosureIds: []
    });

    state = withEvidence(
      state,
      milestoneKey(problem, "parent-b", "PROGRESS"),
      "COMPLETE"
    );
    const ready = decidePedagogicalPolicy(state, turnId, problem);
    expect(ready.realizationRequest.allowedDisclosureIds).toEqual([disclosureId]);
  });

  it("allows either explicitly authored approach branch to satisfy a shared join", () => {
    const disclosureId = DisclosureIdSchema.parse("disclosure_alternate_join");
    const problem: InterviewProblem = {
      ...sixPeopleProblem,
      id: "alternate-approach-join-test",
      version: "1.0.0",
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          version: "1.0.0",
          approaches: [
            { id: "approach-a", label: "Approach A" },
            { id: "approach-b", label: "Approach B" }
          ],
          milestones: [
            {
              id: "branch-a",
              description: "Approach A branch.",
              approachIds: ["approach-a"],
              optionalPrerequisiteIds: [],
              protectedDisclosureIds: []
            },
            {
              id: "branch-b",
              description: "Approach B branch.",
              approachIds: ["approach-b"],
              optionalPrerequisiteIds: [],
              protectedDisclosureIds: []
            },
            {
              id: "join",
              description: "Shared branch join.",
              approachIds: ["approach-a", "approach-b"],
              optionalPrerequisiteIds: ["branch-a", "branch-b"],
              protectedDisclosureIds: [disclosureId]
            }
          ],
          edges: [],
          commonErrors: [],
          extensions: []
        },
        protectedDisclosures: [{
          id: disclosureId,
          fact: "Carry the completed branch into the shared join.",
          minimumDisclosureLevel: 1,
          equivalentFormulations: ["carry the completed branch"]
        }]
      }
    };

    const { state: base, turnId } = makeState(problem);
    let state = withEvidence(
      base,
      milestoneKey(problem, "branch-a", "PROGRESS"),
      "COMPLETE"
    );
    state = withEvidence(
      state,
      milestoneKey(problem, "join", "CORRECTNESS"),
      "STRUCTURAL_ERROR"
    );

    const decision = decidePedagogicalPolicy(state, turnId, problem);
    expect(decision.realizationRequest).toMatchObject({
      requiredAction: "CHANGE_REPRESENTATION",
      maximumDisclosure: 1,
      allowedDisclosureIds: [disclosureId]
    });
  });

  it("fails closed when optional prerequisites introduce a cycle even if authored edges are acyclic", () => {
    const cyclic: InterviewProblem = {
      ...sixPeopleProblem,
      version: "1.0.0-optional-cycle-test",
      interviewer: {
        ...sixPeopleProblem.interviewer,
        reasoningGraph: {
          ...sixPeopleProblem.interviewer.reasoningGraph,
          version: "1.0.0-optional-cycle-test",
          milestones: sixPeopleProblem.interviewer.reasoningGraph.milestones.map((milestone) => {
            if (milestone.id === "model-relations") {
              return { ...milestone, optionalPrerequisiteIds: ["choose-vertex"] };
            }
            if (milestone.id === "choose-vertex") {
              return { ...milestone, optionalPrerequisiteIds: ["model-relations"] };
            }
            return milestone;
          })
        }
      }
    };
    const { state, turnId } = makeState(cyclic);
    const decision = decidePedagogicalPolicy(state, turnId, cyclic);
    expect(decision.reasonCode).toBe("INVALID_REASONING_TARGET");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("fails closed when event IDs are duplicated or sequence no longer matches the replay index", () => {
    const { state: base, turnId } = makeState();
    const duplicate = base.eventIds[0];
    expect(duplicate).toBeDefined();
    if (duplicate === undefined) throw new Error("missing event fixture");
    const malformed = {
      ...base,
      eventIds: [...base.eventIds.slice(0, -1), duplicate]
    } as SessionState;
    const decision = decidePedagogicalPolicy(malformed, turnId, sixPeopleProblem);
    expect(decision.reasonCode).toBe("MALFORMED_POLICY_INPUT");
    expect(decision.realizationRequest.maximumDisclosure).toBe(0);
  });

  it("rejects forged context compilation that does not use the authoritative turn request", () => {
    const { state: base, turnId } = makeState();
    const authoritative: RealizationRequest = {
      requiredAction: "PROBE_JUSTIFICATION",
      target: target("claim", "authoritative"),
      maximumDisclosure: 0
    };
    const state: SessionState = {
      ...base,
      pedagogicalActions: {
        ...base.pedagogicalActions,
        [turnId]: authoritative
      }
    };
    expect(() => compileContext({
      state,
      problem: sixPeopleProblem,
      turnId,
      realizationRequest: {
        requiredAction: "EXPLICIT_HINT",
        target: target("milestone", "close-triangle"),
        maximumDisclosure: 4
      }
    })).toThrow(/authoritative pedagogical action/u);
  });

  it("keeps protected solution text out of policy diagnostics", () => {
    const { state: base, turnId } = makeState();
    const state = withEvidence(base, milestoneKey(sixPeopleProblem, "close-triangle", "PROGRESS"), "STALLED");
    const serialized = JSON.stringify(decidePedagogicalPolicy(state, turnId, sixPeopleProblem));
    expect(serialized).not.toContain(sixPeopleProblem.private.canonicalSolution);
    for (const disclosure of sixPeopleProblem.interviewer.protectedDisclosures) {
      expect(serialized).not.toContain(disclosure.fact);
    }
  });
});

describe("target-scoped disclosure validator", () => {
  it("rejects a protected fact that is below the numeric ceiling but outside the allowed target IDs", () => {
    const first = sixPeopleProblem.interviewer.protectedDisclosures[0];
    const second = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) throw new Error("missing fixture disclosure");

    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([]));
    const result = validator.validate({
      proposal: {
        realizedAction: "EXPLICIT_HINT",
        claimedDisclosureLevel: 4,
        claimedDisclosureIds: [second.id],
        speechText: second.fact
      },
      request: {
        requiredAction: "EXPLICIT_HINT",
        maximumDisclosure: 4,
        allowedDisclosureIds: [first.id]
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toMatch(/target authorization/i);
    }
  });

  it("treats a missing allowed-disclosure list as authorizing no protected facts", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");

    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([]));
    const result = validator.validate({
      proposal: {
        realizedAction: "EXPLICIT_HINT",
        claimedDisclosureLevel: 4,
        claimedDisclosureIds: [disclosure.id],
        speechText: disclosure.fact
      },
      request: {
        requiredAction: "EXPLICIT_HINT",
        maximumDisclosure: 4
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/target authorization/i);
  });

  it("fails closed when protected metadata normalizes to an empty formulation", () => {
    const malformedDisclosure = {
      id: DisclosureIdSchema.parse("disclosure_punctuation_only"),
      fact: "!!!",
      minimumDisclosureLevel: 2 as const,
      equivalentFormulations: ["???"]
    };
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["safe probe"]));
    const result = validator.validate({
      proposal: {
        realizedAction: "FOCUS_ATTENTION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "safe probe"
      },
      request: {
        requiredAction: "FOCUS_ATTENTION",
        maximumDisclosure: 1,
        allowedDisclosureIds: []
      },
      protectedDisclosures: [malformedDisclosure]
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/uncertain|cannot be analyzed/i);
  });

  it("fails closed on oversized disclosure-analysis text", () => {
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer([]));
    const result = validator.validate({
      proposal: {
        realizedAction: "CLARIFY",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "x".repeat(100_001)
      },
      request: {
        requiredAction: "CLARIFY",
        maximumDisclosure: 0
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
  });

  it("rejects an analyzer result explicitly marked UNSAFE", () => {
    const validator = new DisclosureValidator({
      analyze: () => ({
        status: "UNSAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 1,
        reason: "synthetic unsafe result"
      })
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "CLARIFY",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "safe-looking text"
      },
      request: {
        requiredAction: "CLARIFY",
        maximumDisclosure: 0
      },
      protectedDisclosures: []
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/unsafe/i);
  });

  it("rejects a malformed custom analyzer result instead of trusting its TypeScript type", () => {
    const validator = new DisclosureValidator({
      analyze: () => ({
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 2,
        reason: "invalid confidence"
      })
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "CLARIFY",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "safe-looking text"
      },
      request: {
        requiredAction: "CLARIFY",
        maximumDisclosure: 0
      },
      protectedDisclosures: []
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/invalid result/i);
  });

  it("validates whiteboard annotation purpose even when content is present", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["safe label"]));
    const result = validator.validate({
      proposal: {
        realizedAction: "FOCUS_ATTENTION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "safe label",
          annotationPurpose: disclosure.fact
        }]
      },
      request: {
        requiredAction: "FOCUS_ATTENTION",
        maximumDisclosure: 0
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
    expect(result.analysis?.effectiveDisclosureLevel).toBeGreaterThan(0);
  });

  it("localizes a detected protected disclosure to the realization that actually contains it", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");

    const validator = new DisclosureValidator(
      new ClosedWorldDisclosureAnalyzer(["safe speech", "safe purpose"])
    );
    const result = validator.validate({
      proposal: {
        realizedAction: "DIRECTIONAL_NUDGE",
        claimedDisclosureLevel: disclosure.minimumDisclosureLevel,
        claimedDisclosureIds: [disclosure.id],
        speechText: "safe speech",
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: disclosure.fact,
          annotationPurpose: "safe purpose"
        }]
      },
      request: {
        requiredAction: "DIRECTIONAL_NUDGE",
        maximumDisclosure: disclosure.minimumDisclosureLevel,
        allowedDisclosureIds: [disclosure.id]
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    expect(result.analysis.effectiveDisclosureIds).toContain(disclosure.id);
    expect(result.realizations.speech).toMatchObject({
      effectiveDisclosureLevel: 0,
      effectiveDisclosureIds: []
    });
    expect(result.realizations.boardActions).toHaveLength(1);
    expect(result.realizations.boardActions[0]).toMatchObject({
      effectiveDisclosureLevel: disclosure.minimumDisclosureLevel,
      effectiveDisclosureIds: [disclosure.id]
    });
  });

  it("conservatively taints every realization when a provider claim cannot be localized", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");

    const validator = new DisclosureValidator({
      analyze: () => ({
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 1,
        reason: "synthetic semantic miss"
      })
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "DIRECTIONAL_NUDGE",
        claimedDisclosureLevel: disclosure.minimumDisclosureLevel,
        claimedDisclosureIds: [disclosure.id],
        speechText: "synthetic safe-looking speech",
        boardActions: [{
          operation: "write_text",
          layer: "AI_ANNOTATION",
          content: "synthetic safe-looking board text",
          annotationPurpose: "synthetic safe-looking purpose"
        }]
      },
      request: {
        requiredAction: "DIRECTIONAL_NUDGE",
        maximumDisclosure: disclosure.minimumDisclosureLevel,
        allowedDisclosureIds: [disclosure.id]
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) throw new Error(result.reason);
    expect(result.realizations.speech?.effectiveDisclosureIds).toContain(disclosure.id);
    expect(result.realizations.boardActions[0]?.effectiveDisclosureIds).toContain(disclosure.id);
    expect(result.realizations.speech?.effectiveDisclosureLevel)
      .toBe(disclosure.minimumDisclosureLevel);
    expect(result.realizations.boardActions[0]?.effectiveDisclosureLevel)
      .toBe(disclosure.minimumDisclosureLevel);
  });

  it("treats a provider-claimed protected disclosure as effective even when text analysis misses it", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");

    const validator = new DisclosureValidator({
      analyze: () => ({
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 1,
        reason: "synthetic semantic miss"
      })
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: disclosure.minimumDisclosureLevel,
        claimedDisclosureIds: [disclosure.id],
        speechText: "synthetic safe-looking text"
      },
      request: {
        requiredAction: "PROBE_JUSTIFICATION",
        maximumDisclosure: 0
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });

    expect(result.accepted).toBe(false);
    expect(result.analysis?.effectiveDisclosureIds).toContain(disclosure.id);
    expect(result.analysis?.effectiveDisclosureLevel).toBeGreaterThan(0);
  });

  it("rejects unknown or duplicate provider-claimed disclosure identities", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");
    const validator = new DisclosureValidator(new ClosedWorldDisclosureAnalyzer(["safe probe"]));

    const duplicate = validator.validate({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: disclosure.minimumDisclosureLevel,
        claimedDisclosureIds: [disclosure.id, disclosure.id],
        speechText: "safe probe"
      },
      request: {
        requiredAction: "PROBE_JUSTIFICATION",
        maximumDisclosure: disclosure.minimumDisclosureLevel,
        allowedDisclosureIds: [disclosure.id]
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(duplicate.accepted).toBe(false);

    const unknownId = DisclosureIdSchema.parse("disclosure_unknown_provider_claim");
    const unknown = validator.validate({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [unknownId],
        speechText: "safe probe"
      },
      request: {
        requiredAction: "PROBE_JUSTIFICATION",
        maximumDisclosure: 0
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(unknown.accepted).toBe(false);
  });

  it("does not let a custom analyzer erase an exact protected formulation", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[0];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");

    const validator = new DisclosureValidator({
      analyze: () => ({
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [],
        confidence: 1,
        reason: "synthetic semantic miss"
      })
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "PROBE_JUSTIFICATION",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: disclosure.fact
      },
      request: {
        requiredAction: "PROBE_JUSTIFICATION",
        maximumDisclosure: 0
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });

    expect(result.accepted).toBe(false);
    expect(result.analysis?.effectiveDisclosureLevel).toBeGreaterThan(0);
  });

  it("enforces the protected metadata level even if a custom analyzer understates it", () => {
    const disclosure = sixPeopleProblem.interviewer.protectedDisclosures[1];
    expect(disclosure).toBeDefined();
    if (disclosure === undefined) throw new Error("missing protected disclosure");
    const validator = new DisclosureValidator({
      analyze: () => ({
        status: "SAFE",
        effectiveDisclosureLevel: 0,
        effectiveDisclosureIds: [disclosure.id],
        confidence: 1,
        reason: "synthetic underreported level"
      })
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "DIRECTIONAL_NUDGE",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "synthetic output"
      },
      request: {
        requiredAction: "DIRECTIONAL_NUDGE",
        maximumDisclosure: 2,
        allowedDisclosureIds: [disclosure.id]
      },
      protectedDisclosures: sixPeopleProblem.interviewer.protectedDisclosures
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toMatch(/authorization exceeds|effective disclosure/u);
    }
  });

  it("rejects reviewed safe text that normalizes to an empty string", () => {
    expect(() => new ClosedWorldDisclosureAnalyzer(["!!!"])).toThrow(/alphanumeric/u);
  });

  it("fails closed if the analyzer throws", () => {
    const validator = new DisclosureValidator({
      analyze: () => {
        throw new Error("analyzer implementation failure");
      }
    });
    const result = validator.validate({
      proposal: {
        realizedAction: "CLARIFY",
        claimedDisclosureLevel: 0,
        claimedDisclosureIds: [],
        speechText: "safe-looking text"
      },
      request: {
        requiredAction: "CLARIFY",
        maximumDisclosure: 0
      },
      protectedDisclosures: []
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toMatch(/analyzer failed/i);
  });
});
