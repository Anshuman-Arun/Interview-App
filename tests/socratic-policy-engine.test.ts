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
  type EvidenceKey,
  type EvidenceRating,
  type InterviewProblem,
  type RealizationRequest
} from "../packages/domain/src/index.js";
import {
  initialSessionState,
  type SessionState
} from "../packages/events/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
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
  const seedEventId = EventIdSchema.parse(nextId("event_seed"));
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
        prompt: problem.public.prompt
      },
      lastCommittedInputSequence: 4,
      eventIds: [seedEventId],
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
  const evidenceValue = {
    value,
    inferenceConfidence: options.confidence ?? 0.95,
    evidenceEventIds: options.duplicateProvenance ? [eventId, eventId] : [eventId],
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
  }
): SessionState {
  const turnId = TurnIdSchema.parse(nextId("turn_assist"));
  const inputEpisodeId = InputEpisodeIdSchema.parse(nextId("episode_assist"));
  const generationId = GenerationIdSchema.parse(nextId("generation_assist"));
  const deliveryId = DeliveryIdSchema.parse(nextId("delivery_assist"));
  const turnSequence = Math.max(1, state.sequence - 1);
  const request: RealizationRequest = {
    requiredAction: input.action,
    target: input.target,
    maximumDisclosure: input.maximumDisclosure
  };
  return {
    ...state,
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
          committedInputSequence: state.lastCommittedInputSequence ?? 1,
          transcriptRevision: state.transcriptRevision,
          boardRevision: state.boardRevision,
          problemStateRevision: state.problemStateRevision,
          policyRevision: state.policyRevision,
          inputEpisodeId,
          turnId
        },
        provider: "policy-test",
        status: "VALIDATED"
      }
    },
    deliveries: {
      ...state.deliveries,
      [deliveryId]: {
        deliveryId,
        generationId,
        content: { medium: "TEXT", text: "reviewed assistance" },
        disclosureIds: [],
        effectiveDisclosureLevel: input.effectiveDisclosureLevel ?? input.maximumDisclosure,
        status: input.status ?? "EXPOSED"
      }
    }
  };
}

function withVerification(
  state: SessionState,
  key: EvidenceKey,
  status: "VERIFIED" | "CONTRADICTED" | "UNRESOLVED",
  options: { readonly staleBasis?: boolean } = {}
): SessionState {
  const requestId = RequestIdSchema.parse(nextId("request_verify"));
  const eventId = EventIdSchema.parse(nextId("event_verify"));
  const sequence = state.sequence + 1;
  return {
    ...state,
    sequence,
    eventIds: [...state.eventIds, eventId],
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
        interpretationConfidence: 1,
        evidenceKey: key,
        evidenceEventIds: [eventId],
        requestedEventId: eventId,
        status: "ACCEPTED",
        result: {
          status,
          interpretationConfidence: 1,
          verifier: "deterministic-policy-test",
          reason: "deterministic test result"
        }
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
      state = {
        ...state,
        disclosureLedger: [branchDisclosure.id]
      };
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
    const state: SessionState = {
      ...base,
      eventIds: [...base.eventIds, ...records.map((record) => record.evidenceEventId)],
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
});
