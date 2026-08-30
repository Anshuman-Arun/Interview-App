import { describe, expect, it } from "vitest";
import {
  ALL_PROBLEMS,
  assertInterviewProblemIntegrity,
  assertReasoningGraphFixtureIntegrity,
  biasedCoinProblem,
  gamblersRuinProblem,
  getProblemById,
  getProblemsByDifficulty,
  getProblemsByTopic,
  hilbertHotelProblem,
  prisonerHatsProblem,
  problemCatalog,
  sixPeopleProblem
} from "../packages/problems/src/index.js";
import {
  ClosedWorldDisclosureAnalyzer,
  DisclosureValidator,
  selectPedagogicalAction
} from "../packages/interview-engine/src/index.js";
import {
  InputEpisodeIdSchema,
  newSessionId,
  TurnIdSchema,
  type ReasoningGraph
} from "../packages/domain/src/index.js";
import { initialSessionState } from "../packages/events/src/index.js";

describe("Problem Catalog Expansion & Pedagogical Graph Engine", () => {
  describe("1. Catalog Registration & Integrity Verification", () => {
    it("registers all 5 Oxford and Quant problems in the catalog", () => {
      expect(problemCatalog).toHaveLength(5);
      expect(ALL_PROBLEMS).toHaveLength(5);

      const ids = problemCatalog.map((p) => p.id);
      expect(ids).toContain("oxford-six-people");
      expect(ids).toContain("oxford-hilbert-hotel");
      expect(ids).toContain("oxford-prisoner-hats");
      expect(ids).toContain("quant-gamblers-ruin");
      expect(ids).toContain("quant-von-neumann-coin");
    });

    it("verifies full integrity on every problem in the catalog", () => {
      for (const problem of problemCatalog) {
        expect(() => assertInterviewProblemIntegrity(problem)).not.toThrow();
        expect(problem.public.prompt.length).toBeGreaterThan(20);
        expect(problem.public.givenInformation.length).toBeGreaterThanOrEqual(1);
        expect(problem.private.canonicalSolution.length).toBeGreaterThan(20);
        expect(problem.private.verificationNotes.length).toBeGreaterThan(10);
        expect(problem.interviewer.topics.length).toBeGreaterThanOrEqual(2);
        expect(problem.interviewer.reasoningGraph.milestones.length).toBeGreaterThanOrEqual(4);
        expect(problem.interviewer.reasoningGraph.edges.length).toBeGreaterThanOrEqual(3);
        expect(problem.interviewer.protectedDisclosures.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("retrieves problems by ID correctly", () => {
      expect(getProblemById("oxford-six-people")).toBe(sixPeopleProblem);
      expect(getProblemById("oxford-hilbert-hotel")).toBe(hilbertHotelProblem);
      expect(getProblemById("oxford-prisoner-hats")).toBe(prisonerHatsProblem);
      expect(getProblemById("quant-gamblers-ruin")).toBe(gamblersRuinProblem);
      expect(getProblemById("quant-von-neumann-coin")).toBe(biasedCoinProblem);
      expect(getProblemById("unknown-problem-id")).toBeUndefined();
    });

    it("filters problems by topic and difficulty", () => {
      const probProblems = getProblemsByTopic("probability");
      expect(probProblems.length).toBe(2);
      expect(probProblems.map((p) => p.id)).toContain("quant-gamblers-ruin");
      expect(probProblems.map((p) => p.id)).toContain("quant-von-neumann-coin");

      const quantTradingProblems = getProblemsByDifficulty("quant-trading");
      expect(quantTradingProblems).toHaveLength(1);
      expect(quantTradingProblems[0]?.id).toBe("quant-gamblers-ruin");

      const oxfordIntro = getProblemsByDifficulty("introductory-oxford");
      expect(oxfordIntro.length).toBe(2);
    });
  });

  describe("2. DAG Acyclicity and Reachability Integrity Gates", () => {
    it("rejects cyclic reasoning graphs using Kahn's topological sort", () => {
      const cyclicGraph: ReasoningGraph = {
        version: "1.0.0",
        approaches: [{ id: "approach-1", label: "Approach 1" }],
        milestones: [
          { id: "node-a", description: "Node A", approachIds: ["approach-1"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] },
          { id: "node-b", description: "Node B", approachIds: ["approach-1"], optionalPrerequisiteIds: ["node-a"], protectedDisclosureIds: [] },
          { id: "node-c", description: "Node C", approachIds: ["approach-1"], optionalPrerequisiteIds: ["node-b"], protectedDisclosureIds: [] }
        ],
        edges: [
          { from: "node-a", to: "node-b" },
          { from: "node-b", to: "node-c" },
          { from: "node-c", to: "node-a" }
        ],
        commonErrors: [],
        extensions: []
      };

      expect(() => assertReasoningGraphFixtureIntegrity(cyclicGraph)).toThrow(/acyclic/i);
    });

    it("rejects self-loops in reasoning graphs", () => {
      const selfLoopGraph: ReasoningGraph = {
        version: "1.0.0",
        approaches: [{ id: "approach-1", label: "Approach 1" }],
        milestones: [
          { id: "node-a", description: "Node A", approachIds: ["approach-1"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] }
        ],
        edges: [
          { from: "node-a", to: "node-a" }
        ],
        commonErrors: [],
        extensions: []
      };

      expect(() => assertReasoningGraphFixtureIntegrity(selfLoopGraph)).toThrow(/self-edge/i);
    });

    it("accepts valid disconnected reasoning graphs with multiple roots", () => {
      const disconnectedGraph: ReasoningGraph = {
        version: "1.0.0",
        approaches: [{ id: "approach-1", label: "Approach 1" }],
        milestones: [
          { id: "root-node", description: "Root", approachIds: ["approach-1"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] },
          { id: "step-1", description: "Step 1", approachIds: ["approach-1"], optionalPrerequisiteIds: ["root-node"], protectedDisclosureIds: [] },
          { id: "island-1", description: "Island 1", approachIds: ["approach-1"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] },
          { id: "island-2", description: "Island 2", approachIds: ["approach-1"], optionalPrerequisiteIds: ["island-1"], protectedDisclosureIds: [] }
        ],
        edges: [
          { from: "root-node", to: "step-1" },
          { from: "island-1", to: "island-2" }
        ],
        commonErrors: [],
        extensions: []
      };

      expect(() => assertReasoningGraphFixtureIntegrity(disconnectedGraph)).not.toThrow();
    });

    it("rejects duplicate approach or milestone IDs", () => {
      const duplicateMilestoneGraph: ReasoningGraph = {
        version: "1.0.0",
        approaches: [{ id: "approach-1", label: "Approach 1" }],
        milestones: [
          { id: "node-a", description: "Node A", approachIds: ["approach-1"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] },
          { id: "node-a", description: "Duplicate Node A", approachIds: ["approach-1"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] }
        ],
        edges: [],
        commonErrors: [],
        extensions: []
      };

      expect(() => assertReasoningGraphFixtureIntegrity(duplicateMilestoneGraph)).toThrow(/duplicate milestone/i);
    });
  });

  describe("3. Socratic Pedagogical Action Selection Across Catalog", () => {
    it("selects initial Socratic probe action for every catalog problem", () => {
      for (const problem of problemCatalog) {
        expect(problem.id).toBeDefined();
        const turnId = TurnIdSchema.parse("turn_001");
        const episodeId = InputEpisodeIdSchema.parse("ep_001");
        const state = {
          ...initialSessionState(newSessionId()),
          turns: {
            [turnId]: {
              turnId,
              inputEpisodeId: episodeId,
              committedSequence: 1,
              studentText: "I will begin by setting up the formal problem definition."
            }
          }
        };
        const action = selectPedagogicalAction(state, turnId);
        expect(action.requiredAction).toBe("PROBE_JUSTIFICATION");
        expect(action.maximumDisclosure).toBe(0);
        expect(action.target).toContain("most recent");
      }
    });
  });

  describe("4. Disclosure Analysis & Boundary Gates Across All Problems", () => {
    it("detects and classifies protected disclosures for Hilbert's Hotel", () => {
      const analyzer = new ClosedWorldDisclosureAnalyzer([]);
      const validator = new DisclosureValidator(analyzer);

      const firstDisclosure = hilbertHotelProblem.interviewer.protectedDisclosures[0];
      if (firstDisclosure === undefined) throw new Error("Expected first disclosure");

      // Level 2 probe with maximumDisclosure: 0 -> Must Reject
      const rejectedResult = validator.validate({
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 0,
          claimedDisclosureIds: [],
          speechText: "We can move the occupant of room n to room n+1 to free room 1."
        },
        request: { requiredAction: "PROBE_JUSTIFICATION", maximumDisclosure: 0 },
        protectedDisclosures: hilbertHotelProblem.interviewer.protectedDisclosures
      });
      expect(rejectedResult.accepted).toBe(false);
      expect(rejectedResult.analysis?.effectiveDisclosureLevel).toBe(2);

      // Level 2 probe with authorized maximumDisclosure: 2 and declared level 2 -> Must Accept
      const acceptedResult = validator.validate({
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 2,
          claimedDisclosureIds: [firstDisclosure.id],
          speechText: "We can move the occupant of room n to room n+1 to free room 1."
        },
        request: { requiredAction: "PROBE_JUSTIFICATION", maximumDisclosure: 2 },
        protectedDisclosures: hilbertHotelProblem.interviewer.protectedDisclosures
      });
      expect(acceptedResult.accepted).toBe(true);
      expect(acceptedResult.analysis?.effectiveDisclosureLevel).toBe(2);
    });

    it("detects and classifies protected disclosures for Prisoner Hats", () => {
      const analyzer = new ClosedWorldDisclosureAnalyzer([]);
      const validator = new DisclosureValidator(analyzer);

      const firstDisclosure = prisonerHatsProblem.interviewer.protectedDisclosures[0];
      if (firstDisclosure === undefined) throw new Error("Expected first disclosure");

      // Level 2 parity sum disclosure
      const result = validator.validate({
        proposal: {
          realizedAction: "PROBE_JUSTIFICATION",
          claimedDisclosureLevel: 2,
          claimedDisclosureIds: [firstDisclosure.id],
          speechText: "The first prisoner announces the sum of hat colours modulo 2."
        },
        request: { requiredAction: "PROBE_JUSTIFICATION", maximumDisclosure: 2 },
        protectedDisclosures: prisonerHatsProblem.interviewer.protectedDisclosures
      });
      expect(result.accepted).toBe(true);
      expect(result.analysis?.effectiveDisclosureLevel).toBe(2);
    });

    it("detects and classifies protected disclosures for Gambler's Ruin", () => {
      const analyzer = new ClosedWorldDisclosureAnalyzer([]);
      const validator = new DisclosureValidator(analyzer);

      const secondDisclosure = gamblersRuinProblem.interviewer.protectedDisclosures[1];
      if (secondDisclosure === undefined) throw new Error("Expected second disclosure");

      // Level 4 formula disclosure
      const result = validator.validate({
        proposal: {
          realizedAction: "EXPLICIT_HINT",
          claimedDisclosureLevel: 4,
          claimedDisclosureIds: [secondDisclosure.id],
          speechText: "The characteristic roots 1 and q/p give the general solution."
        },
        request: { requiredAction: "EXPLICIT_HINT", maximumDisclosure: 4 },
        protectedDisclosures: gamblersRuinProblem.interviewer.protectedDisclosures
      });
      expect(result.accepted).toBe(true);
      expect(result.analysis?.effectiveDisclosureLevel).toBe(4);
    });

    it("detects and classifies protected disclosures for von Neumann Fair Coin", () => {
      const analyzer = new ClosedWorldDisclosureAnalyzer([]);
      const validator = new DisclosureValidator(analyzer);

      const secondDisclosure = biasedCoinProblem.interviewer.protectedDisclosures[1];
      if (secondDisclosure === undefined) throw new Error("Expected second disclosure");

      // Level 4 expected tosses formula
      const result = validator.validate({
        proposal: {
          realizedAction: "EXPLICIT_HINT",
          claimedDisclosureLevel: 4,
          claimedDisclosureIds: [secondDisclosure.id],
          speechText: "Since each pair has success probability 2p(1-p), expected tosses equal 1 / (p(1-p))."
        },
        request: { requiredAction: "EXPLICIT_HINT", maximumDisclosure: 4 },
        protectedDisclosures: biasedCoinProblem.interviewer.protectedDisclosures
      });
      expect(result.accepted).toBe(true);
      expect(result.analysis?.effectiveDisclosureLevel).toBe(4);
    });
  });
});
