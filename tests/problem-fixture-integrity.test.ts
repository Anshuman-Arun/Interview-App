import { describe, expect, it } from "vitest";
import {
  DisclosureIdSchema,
  type InterviewProblem,
  type ReasoningGraph
} from "../packages/domain/src/index.js";
import {
  assertInterviewProblemIntegrity,
  createProblemCatalog,
  normalizeDisclosureFormulation,
  problemCatalog,
  sixPeopleProblem
} from "../packages/problems/src/index.js";

const disclosureA = DisclosureIdSchema.parse("disclosure_fixture_a");
const disclosureB = DisclosureIdSchema.parse("disclosure_fixture_b");
const missingDisclosure = DisclosureIdSchema.parse("disclosure_fixture_missing");

describe("problem fixture integrity", () => {
  it("accepts the existing Oxford six-person fixture and catalog", () => {
    expect(() => assertInterviewProblemIntegrity(sixPeopleProblem)).not.toThrow();
    const catalogEntry = problemCatalog.find(
      (problem) =>
        problem.id === sixPeopleProblem.id
        && problem.version === sixPeopleProblem.version
    );
    expect(catalogEntry).toEqual(sixPeopleProblem);
    expect(catalogEntry).not.toBe(sixPeopleProblem);
    expect(Object.isFrozen(problemCatalog)).toBe(true);
  });

  it("accepts a valid branched reasoning graph", () => {
    expect(() => assertInterviewProblemIntegrity(validProblem())).not.toThrow();
  });

  it("rejects a duplicate milestone ID", () => {
    const problem = editGraph(validProblem(), (graph) => ({
      ...graph,
      milestones: [
        ...graph.milestones,
        {
          id: "left",
          description: "Duplicate milestone identity",
          approachIds: ["main"],
          optionalPrerequisiteIds: [],
          protectedDisclosureIds: []
        }
      ]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Duplicate milestone ID "left"'
    );
  });

  it("rejects a duplicate approach ID", () => {
    const problem = editGraph(validProblem(), (graph) => ({
      ...graph,
      approaches: [
        ...graph.approaches,
        { id: "main", label: "Duplicate main approach" }
      ]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Duplicate approach ID "main"'
    );
  });

  it("rejects duplicate common-error and extension IDs", () => {
    const duplicateCommonError = editGraph(validProblem(), (graph) => ({
      ...graph,
      commonErrors: [
        ...graph.commonErrors,
        { id: "error-a", description: "Duplicate error" }
      ]
    }));
    expect(() => assertInterviewProblemIntegrity(duplicateCommonError)).toThrow(
      'Duplicate common-error ID "error-a"'
    );

    const duplicateExtension = editGraph(validProblem(), (graph) => ({
      ...graph,
      extensions: [
        ...graph.extensions,
        { id: "extension-a", prompt: "Duplicate extension" }
      ]
    }));
    expect(() => assertInterviewProblemIntegrity(duplicateExtension)).toThrow(
      'Duplicate extension ID "extension-a"'
    );
  });

  it("rejects an unknown approach reference", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      approachIds: ["missing-approach"]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" references unknown approach "missing-approach"'
    );
  });

  it("rejects a duplicate approach reference within one milestone", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      approachIds: ["main", "main"]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" has duplicate approach reference "main"'
    );
  });

  it("rejects an unknown prerequisite", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      optionalPrerequisiteIds: ["missing-milestone"]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" references unknown prerequisite "missing-milestone"'
    );
  });

  it("rejects a self-prerequisite", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      optionalPrerequisiteIds: ["left"]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" cannot require itself as a prerequisite'
    );
  });

  it("rejects duplicate prerequisite references", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      optionalPrerequisiteIds: ["root", "root"]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" has duplicate prerequisite "root"'
    );
  });

  it("rejects a cyclic reasoning graph", () => {
    const problem = editGraph(validProblem(), (graph) => ({
      ...graph,
      edges: [
        ...graph.edges,
        { from: "finish", to: "root" }
      ]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      "Reasoning graph must be acyclic"
    );
  });

  it("rejects a duplicate graph edge", () => {
    const problem = editGraph(validProblem(), (graph) => ({
      ...graph,
      edges: [
        ...graph.edges,
        { from: "root", to: "left" }
      ]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Duplicate reasoning edge "root" -> "left"'
    );
  });

  it("rejects a self graph edge", () => {
    const problem = editGraph(validProblem(), (graph) => ({
      ...graph,
      edges: [
        ...graph.edges,
        { from: "root", to: "root" }
      ]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Reasoning graph cannot contain self-edge "root" -> "root"'
    );
  });

  it("rejects graph edges with unknown endpoints", () => {
    const unknownSource = editGraph(validProblem(), (graph) => ({
      ...graph,
      edges: [...graph.edges, { from: "missing", to: "root" }]
    }));
    expect(() => assertInterviewProblemIntegrity(unknownSource)).toThrow(
      'Reasoning edge references unknown source milestone "missing"'
    );

    const unknownTarget = editGraph(validProblem(), (graph) => ({
      ...graph,
      edges: [...graph.edges, { from: "root", to: "missing" }]
    }));
    expect(() => assertInterviewProblemIntegrity(unknownTarget)).toThrow(
      'Reasoning edge references unknown target milestone "missing"'
    );
  });

  it("rejects an unknown protected disclosure reference", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      protectedDisclosureIds: [missingDisclosure]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" references unknown protected disclosure "disclosure_fixture_missing"'
    );
  });

  it("rejects a duplicate protected disclosure ID", () => {
    const problem = editDisclosures(validProblem(), (disclosures) => [
      ...disclosures,
      {
        id: disclosureA,
        fact: "A second fact under the same identity.",
        minimumDisclosureLevel: 1,
        equivalentFormulations: ["second formulation"]
      }
    ]);

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Duplicate protected disclosure ID "disclosure_fixture_a"'
    );
  });

  it("rejects duplicate protected-disclosure references within one milestone", () => {
    const problem = editMilestone(validProblem(), "left", (milestone) => ({
      ...milestone,
      protectedDisclosureIds: [disclosureA, disclosureA]
    }));

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Milestone "left" has duplicate protected-disclosure reference "disclosure_fixture_a"'
    );
  });

  it("requires nonblank disclosure facts and formulations", () => {
    const blankFact = editDisclosures(validProblem(), (disclosures) =>
      disclosures.map((disclosure) => disclosure.id === disclosureA
        ? { ...disclosure, fact: "   " }
        : disclosure)
    );
    expect(() => assertInterviewProblemIntegrity(blankFact)).toThrow(
      'Protected disclosure "disclosure_fixture_a" fact must be non-empty after trimming'
    );

    const blankFormulation = editDisclosures(validProblem(), (disclosures) =>
      disclosures.map((disclosure) => disclosure.id === disclosureA
        ? { ...disclosure, equivalentFormulations: ["   "] }
        : disclosure)
    );
    expect(() => assertInterviewProblemIntegrity(blankFormulation)).toThrow(
      'Protected disclosure "disclosure_fixture_a" equivalent formulation must be non-empty after trimming'
    );
  });

  it("rejects equivalent formulations duplicated after deterministic normalization", () => {
    expect(normalizeDisclosureFormulation("  SAME\t formulation  ")).toBe(
      "same formulation"
    );

    const problem = editDisclosures(validProblem(), (disclosures) =>
      disclosures.map((disclosure) => disclosure.id === disclosureA
        ? {
          ...disclosure,
          equivalentFormulations: [
            "Same formulation",
            "  SAME   formulation  "
          ]
        }
        : disclosure)
    );

    expect(() => assertInterviewProblemIntegrity(problem)).toThrow(
      'Protected disclosure "disclosure_fixture_a" has duplicate equivalent formulation after normalization: "same formulation"'
    );
  });

  it("rejects blank problem identity and required text fields", () => {
    expect(() => assertInterviewProblemIntegrity({
      ...validProblem(),
      id: " "
    })).toThrow("Problem id must be non-empty after trimming");

    expect(() => assertInterviewProblemIntegrity({
      ...validProblem(),
      version: "\t"
    })).toThrow("Problem version must be non-empty after trimming");

    const blankPrompt = validProblem();
    expect(() => assertInterviewProblemIntegrity({
      ...blankPrompt,
      public: { ...blankPrompt.public, prompt: " " }
    })).toThrow("Public prompt must be non-empty after trimming");

    const blankSolution = validProblem();
    expect(() => assertInterviewProblemIntegrity({
      ...blankSolution,
      private: { ...blankSolution.private, canonicalSolution: "" }
    })).toThrow("Canonical solution must be non-empty after trimming");

    const blankNotes = validProblem();
    expect(() => assertInterviewProblemIntegrity({
      ...blankNotes,
      private: { ...blankNotes.private, verificationNotes: "\n" }
    })).toThrow("Verification notes must be non-empty after trimming");
  });

  it("rejects a duplicate problem id/version pair in the catalog", () => {
    const first = validProblem();
    const duplicate = validProblem();

    expect(() => createProblemCatalog([first, duplicate])).toThrow(
      'Duplicate problem catalog identity "fixture-problem" version "1.0.0"'
    );
  });

  it("allows the same problem id at a different version", () => {
    const first = validProblem();
    const second: InterviewProblem = {
      ...validProblem(),
      version: "2.0.0"
    };

    expect(createProblemCatalog([first, second])).toHaveLength(2);
  });
});

function validProblem(): InterviewProblem {
  return {
    id: "fixture-problem",
    version: "1.0.0",
    public: {
      prompt: "Prove the fixture claim.",
      givenInformation: []
    },
    interviewer: {
      topics: ["fixture"],
      difficulty: "fixture",
      reasoningGraph: {
        version: "1.0.0",
        approaches: [
          { id: "main", label: "Main approach" },
          { id: "alternate", label: "Alternate approach" }
        ],
        milestones: [
          {
            id: "root",
            description: "Establish the setup.",
            approachIds: ["main", "alternate"],
            optionalPrerequisiteIds: [],
            protectedDisclosureIds: []
          },
          {
            id: "left",
            description: "Develop the main branch.",
            approachIds: ["main"],
            optionalPrerequisiteIds: ["root"],
            protectedDisclosureIds: [disclosureA]
          },
          {
            id: "right",
            description: "Develop the alternate branch.",
            approachIds: ["alternate"],
            optionalPrerequisiteIds: ["root"],
            protectedDisclosureIds: [disclosureB]
          },
          {
            id: "finish",
            description: "Finish either route.",
            approachIds: ["main", "alternate"],
            optionalPrerequisiteIds: ["left", "right"],
            protectedDisclosureIds: []
          }
        ],
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "right" },
          { from: "left", to: "finish" },
          { from: "right", to: "finish" }
        ],
        commonErrors: [
          { id: "error-a", description: "A common fixture error." }
        ],
        extensions: [
          { id: "extension-a", prompt: "Extend the fixture." }
        ]
      },
      protectedDisclosures: [
        {
          id: disclosureA,
          fact: "Protected fact A.",
          minimumDisclosureLevel: 1,
          equivalentFormulations: ["protected formulation A"]
        },
        {
          id: disclosureB,
          fact: "Protected fact B.",
          minimumDisclosureLevel: 2,
          equivalentFormulations: ["protected formulation B"]
        }
      ]
    },
    private: {
      canonicalSolution: "Fixture canonical solution.",
      verificationNotes: "Fixture verification notes."
    }
  };
}

function editGraph(
  problem: InterviewProblem,
  edit: (graph: ReasoningGraph) => ReasoningGraph
): InterviewProblem {
  return {
    ...problem,
    interviewer: {
      ...problem.interviewer,
      reasoningGraph: edit(problem.interviewer.reasoningGraph)
    }
  };
}

function editMilestone(
  problem: InterviewProblem,
  milestoneId: string,
  edit: (milestone: ReasoningGraph["milestones"][number]) => ReasoningGraph["milestones"][number]
): InterviewProblem {
  return editGraph(problem, (graph) => ({
    ...graph,
    milestones: graph.milestones.map((milestone) =>
      milestone.id === milestoneId ? edit(milestone) : milestone
    )
  }));
}

function editDisclosures(
  problem: InterviewProblem,
  edit: (
    disclosures: InterviewProblem["interviewer"]["protectedDisclosures"]
  ) => InterviewProblem["interviewer"]["protectedDisclosures"]
): InterviewProblem {
  return {
    ...problem,
    interviewer: {
      ...problem.interviewer,
      protectedDisclosures: edit(problem.interviewer.protectedDisclosures)
    }
  };
}
