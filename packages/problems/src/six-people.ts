import {
  DisclosureIdSchema,
  type InterviewProblem
} from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";

const choosePersonDisclosure = DisclosureIdSchema.parse("disclosure_choose_person_pigeonhole");
const completeTriangleDisclosure = DisclosureIdSchema.parse("disclosure_complete_monochromatic_triangle");

export const sixPeopleProblem: InterviewProblem = {
  id: "oxford-six-people",
  version: "1.0.0",
  public: {
    prompt: "In a group of six people, prove that there are either three mutual acquaintances or three mutual strangers.",
    givenInformation: ["Acquaintance is symmetric."]
  },
  interviewer: {
    topics: ["combinatorics", "graph theory", "pigeonhole principle"],
    difficulty: "introductory-oxford",
    reasoningGraph: {
      version: "1.0.0",
      approaches: [
        { id: "two-colour-graph", label: "Two-colour complete graph" },
        { id: "graph-complement", label: "Graph and complement" }
      ],
      milestones: [
        { id: "model-relations", description: "Represent each pair by one of two relation types.", approachIds: ["two-colour-graph", "graph-complement"], optionalPrerequisiteIds: [], protectedDisclosureIds: [] },
        { id: "choose-vertex", description: "Choose one person and identify three incident relations of the same type.", approachIds: ["two-colour-graph", "graph-complement"], optionalPrerequisiteIds: ["model-relations"], protectedDisclosureIds: [choosePersonDisclosure] },
        { id: "close-triangle", description: "Analyze the three people to obtain a monochromatic triangle.", approachIds: ["two-colour-graph"], optionalPrerequisiteIds: ["choose-vertex"], protectedDisclosureIds: [completeTriangleDisclosure] },
        { id: "complement-case", description: "Express the same dichotomy through a graph and its complement.", approachIds: ["graph-complement"], optionalPrerequisiteIds: ["choose-vertex"], protectedDisclosureIds: [completeTriangleDisclosure] },
        { id: "verify", description: "Justify both relation cases and the symmetry assumption.", approachIds: ["two-colour-graph", "graph-complement"], optionalPrerequisiteIds: ["close-triangle", "complement-case"], protectedDisclosureIds: [] }
      ],
      edges: [
        { from: "model-relations", to: "choose-vertex" },
        { from: "choose-vertex", to: "close-triangle" },
        { from: "choose-vertex", to: "complement-case" },
        { from: "close-triangle", to: "verify" },
        { from: "complement-case", to: "verify" }
      ],
      commonErrors: [
        { id: "assume-transitivity", description: "Assumes acquaintance or stranger relations are transitive." }
      ],
      extensions: [
        { id: "five-counterexample", prompt: "Why is the analogous statement false for five people?" }
      ]
    },
    protectedDisclosures: [
      {
        id: choosePersonDisclosure,
        fact: "Choose any person; among five incident relationships, at least three have the same type by pigeonhole.",
        minimumDisclosureLevel: 2,
        equivalentFormulations: [
          "choose any person",
          "at least three edges have the same colour",
          "at least three edges have the same color",
          "at least three edges share the same color",
          "at least three edges share the same colour",
          "use the pigeonhole principle on five relationships",
          "by the pigeonhole principle"
        ]
      },
      {
        id: completeTriangleDisclosure,
        fact: "Among those three people, a matching internal relation closes one triangle; otherwise all three opposite relations form the other triangle.",
        minimumDisclosureLevel: 4,
        equivalentFormulations: [
          "if any internal edge matches",
          "otherwise the other three form a triangle",
          "complete the monochromatic triangle",
          "what happens if any edge between them shares that color",
          "what happens if none of them do"
        ]
      }
    ]
  },
  private: {
    canonicalSolution: "Two-colour the edges of K6. At any vertex, three incident edges share a colour. If an edge among their other endpoints has that colour, it closes such a triangle; otherwise all three edges among them have the opposite colour.",
    verificationNotes: "Check that acquaintance is treated only as a symmetric binary relation; no transitivity is assumed."
  }
};

assertInterviewProblemIntegrity(sixPeopleProblem);
