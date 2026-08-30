import { describe, expect, it } from "vitest";
import {
  evaluateInterviewSession,
  generateEvaluationMarkdown
} from "../packages/interview-engine/src/session-evaluator.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  DeliveryIdSchema,
  DisclosureIdSchema,
  GenerationIdSchema,
  InputEpisodeIdSchema,
  newSessionId,
  TurnIdSchema,
  type DeliveryAtom,
  type InterviewProblem
} from "../packages/domain/src/index.js";
import { initialSessionState, type SessionState } from "../packages/events/src/index.js";

const mockProbabilityProblem: InterviewProblem = {
  id: "quant-probability-puzzle",
  version: "1.0.0",
  public: {
    prompt: "Solve the coin puzzle with probability p.",
    givenInformation: ["Coin tosses are i.i.d."]
  },
  interviewer: {
    topics: ["probability", "combinatorics"],
    difficulty: "introductory-oxford",
    reasoningGraph: {
      version: "1.0.0",
      approaches: [{ id: "main-approach", label: "Direct conditioning" }],
      milestones: [
        {
          id: "step-1",
          description: "Formulate the sample space.",
          approachIds: ["main-approach"],
          optionalPrerequisiteIds: [],
          protectedDisclosureIds: []
        },
        {
          id: "step-2",
          description: "Condition on the first event.",
          approachIds: ["main-approach"],
          optionalPrerequisiteIds: ["step-1"],
          protectedDisclosureIds: [DisclosureIdSchema.parse("disclosure_prob_hint")]
        }
      ],
      edges: [{ from: "step-1", to: "step-2" }],
      commonErrors: [],
      extensions: []
    },
    protectedDisclosures: [
      {
        id: DisclosureIdSchema.parse("disclosure_prob_hint"),
        fact: "Condition on the outcome of the first toss.",
        minimumDisclosureLevel: 2,
        equivalentFormulations: ["condition on the first toss", "first event partition"]
      }
    ]
  },
  private: {
    canonicalSolution: "Condition on the first step to establish P = p * 1 + (1-p) * 0 = p.",
    verificationNotes: "Check that total probability rule is applied."
  }
};

describe("Session Evaluator Engine", () => {
  it("evaluates a high-performing unassisted interview session", () => {
    const sessionId = newSessionId();
    const turn1 = TurnIdSchema.parse("turn_001");
    const turn2 = TurnIdSchema.parse("turn_002");
    const turn3 = TurnIdSchema.parse("turn_003");
    const turn4 = TurnIdSchema.parse("turn_004");
    const turn5 = TurnIdSchema.parse("turn_005");

    const state: SessionState = {
      ...initialSessionState(sessionId),
      turns: {
        [turn1]: {
          turnId: turn1,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_001"),
          committedSequence: 1,
          studentText: "Let us model the six people as vertices in a complete graph K_6 with two edge colors."
        },
        [turn2]: {
          turnId: turn2,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_002"),
          committedSequence: 2,
          studentText: "Consider any vertex v. It has degree 5. By the pigeonhole principle, at least 3 incident edges share the same color."
        },
        [turn3]: {
          turnId: turn3,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_003"),
          committedSequence: 3,
          studentText: "Let these 3 incident neighbors be {u1, u2, u3} connected to v by red edges."
        },
        [turn4]: {
          turnId: turn4,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_004"),
          committedSequence: 4,
          studentText: "If any edge (ui, uj) is red, {v, ui, uj} forms a red triangle. Otherwise, all edges between {u1, u2, u3} are blue, forming a blue triangle."
        },
        [turn5]: {
          turnId: turn5,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_005"),
          committedSequence: 5,
          studentText: "Therefore, in all cases, a monochromatic K_3 is guaranteed to exist. This completes the proof."
        }
      },
      deliveries: {}
    };

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);

    expect(evaluation.sessionId).toBe(sessionId);
    expect(evaluation.problemId).toBe(sixPeopleProblem.id);
    expect(evaluation.scores.technicalCorrectness).toBe(100);
    expect(evaluation.scores.independence).toBe(100);
    expect(evaluation.unassistedMilestoneCount).toBeGreaterThanOrEqual(5);
    expect(evaluation.assistedMilestoneCount).toBe(0);
    expect(evaluation.scores.compositeScore).toBeGreaterThanOrEqual(90);
    expect(evaluation.keyStrengths.length).toBeGreaterThanOrEqual(2);

    const markdown = generateEvaluationMarkdown(evaluation);
    expect(markdown).toContain("Technical Interview Evaluation Report");
    expect(markdown).toContain("100% unassisted session");
    expect(markdown).toContain(sixPeopleProblem.id);
    expect(markdown.split("\n").every((line) => !/[\t ]+$/u.test(line))).toBe(true);
  });

  it("strictly uses authoritative EXPOSED and POSSIBLY_EXPOSED delivery status (ignores QUEUED/CANCELLED)", () => {
    const sessionId = newSessionId();
    const turn1 = TurnIdSchema.parse("turn_001");
    const turn2 = TurnIdSchema.parse("turn_002");
    const gen1 = GenerationIdSchema.parse("gen_001");
    const gen2 = GenerationIdSchema.parse("gen_002");
    const gen3 = GenerationIdSchema.parse("gen_003");

    const exposedDelivery: DeliveryAtom = {
      deliveryId: DeliveryIdSchema.parse("del_001"),
      generationId: gen1,
      content: { medium: "TEXT", text: "Look at the degree of vertex v and use the pigeonhole principle." },
      disclosureIds: [DisclosureIdSchema.parse("disclosure_choose_person_pigeonhole")],
      effectiveDisclosureLevel: 2,
      status: "EXPOSED"
    };

    const queuedDelivery: DeliveryAtom = {
      deliveryId: DeliveryIdSchema.parse("del_002"),
      generationId: gen2,
      content: { medium: "TEXT", text: "Unexposed hint that was queued but never played." },
      disclosureIds: [DisclosureIdSchema.parse("disclosure_complete_monochromatic_triangle")],
      effectiveDisclosureLevel: 4,
      status: "QUEUED"
    };

    const cancelledDelivery: DeliveryAtom = {
      deliveryId: DeliveryIdSchema.parse("del_003"),
      generationId: gen3,
      content: { medium: "TEXT", text: "Cancelled hint due to student barge-in." },
      disclosureIds: [DisclosureIdSchema.parse("disclosure_complete_monochromatic_triangle")],
      effectiveDisclosureLevel: 4,
      status: "CANCELLED"
    };

    const state: SessionState = {
      ...initialSessionState(sessionId),
      turns: {
        [turn1]: {
          turnId: turn1,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_001"),
          committedSequence: 1,
          studentText: "I am trying to solve the six people problem."
        },
        [turn2]: {
          turnId: turn2,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_002"),
          committedSequence: 2,
          studentText: "By the pigeonhole hint, at least 3 edges from vertex v have the same color."
        }
      },
      deliveries: {
        del_001: exposedDelivery,
        del_002: queuedDelivery,
        del_003: cancelledDelivery
      }
    };

    const evaluation = evaluateInterviewSession(state, sixPeopleProblem);

    // Only del_001 is EXPOSED (Level 2). del_002 and del_003 were not exposed and must NOT count.
    expect(evaluation.disclosedInterventions).toHaveLength(1);
    expect(evaluation.disclosedInterventions[0]?.disclosureLevel).toBe(2);
    expect(evaluation.disclosedInterventions[0]?.deliveryStatus).toBe("EXPOSED");

    // Independence should only have the Level 2 penalty (-15), not the Level 4 penalties
    expect(evaluation.scores.independence).toBe(85);
    expect(evaluation.assistedMilestoneCount).toBeGreaterThanOrEqual(1);

    const markdown = generateEvaluationMarkdown(evaluation);
    expect(markdown).toContain("pigeonhole");
    expect(markdown).not.toContain("Unexposed hint");
  });

  it("evaluates custom problem reasoning graphs correctly", () => {
    const sessionId = newSessionId();
    const turn1 = TurnIdSchema.parse("turn_001");
    const turn2 = TurnIdSchema.parse("turn_002");

    const state: SessionState = {
      ...initialSessionState(sessionId),
      turns: {
        [turn1]: {
          turnId: turn1,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_001"),
          committedSequence: 1,
          studentText: "Step 1: The sample space consists of all binary sequences."
        },
        [turn2]: {
          turnId: turn2,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_002"),
          committedSequence: 2,
          studentText: "Step 2: We condition on the first coin flip being Heads or Tails."
        }
      },
      deliveries: {}
    };

    const probEval = evaluateInterviewSession(state, mockProbabilityProblem);
    expect(probEval.problemId).toBe(mockProbabilityProblem.id);
    expect(probEval.milestones).toHaveLength(2);
    expect(probEval.scores.compositeScore).toBeGreaterThanOrEqual(70);
  });

  it("adjusts composite scoring with custom rubric weights", () => {
    const sessionId = newSessionId();
    const turn1 = TurnIdSchema.parse("turn_001");

    const state: SessionState = {
      ...initialSessionState(sessionId),
      turns: {
        [turn1]: {
          turnId: turn1,
          inputEpisodeId: InputEpisodeIdSchema.parse("ep_001"),
          committedSequence: 1,
          studentText: "Let us start by setting up the problem statement."
        }
      },
      deliveries: {}
    };

    const normalEval = evaluateInterviewSession(state, mockProbabilityProblem);

    // Custom rubric heavily weighting independence
    const customEval = evaluateInterviewSession(state, mockProbabilityProblem, {
      independenceWeight: 0.80,
      correctnessWeight: 0.10,
      rigorWeight: 0.05,
      communicationWeight: 0.05,
      errorRecoveryWeight: 0
    });

    expect(customEval.scores.independence).toBe(100);
    expect(customEval.scores.compositeScore).toBeGreaterThan(normalEval.scores.compositeScore);
  });
});
