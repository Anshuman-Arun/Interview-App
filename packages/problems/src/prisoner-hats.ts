import {
  DisclosureIdSchema,
  type InterviewProblem
} from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";

const paritySumDisclosure = DisclosureIdSchema.parse("disclosure_prisoner_parity_sum");
const subsequentDeductionDisclosure = DisclosureIdSchema.parse("disclosure_prisoner_subsequent_deduction");

export const prisonerHatsProblem: InterviewProblem = {
  id: "oxford-prisoner-hats",
  version: "1.0.0",
  public: {
    prompt: "One hundred prisoners are lined up in a single file facing forward, each wearing a red or blue hat. Each prisoner can see the hat colours of everyone in front of them, but cannot see their own hat or the hats behind them. Starting from the back of the line (the 100th prisoner who sees 99 hats), each prisoner in turn must guess their own hat colour (saying only 'Red' or 'Blue'). If they are right, they are pardoned; if wrong, they are executed. Everyone hears all previous guesses and whether they lived. Devise a strategy beforehand that guarantees at least 99 prisoners are pardoned.",
    givenInformation: [
      "There are 100 prisoners lined up in single file.",
      "Each hat is either Red or Blue.",
      "Prisoner 100 sees 99 hats; prisoner 1 sees 0 hats.",
      "Every prisoner hears all prior guesses."
    ]
  },
  interviewer: {
    topics: ["invariant theory", "combinatorics", "parity strategy", "modular arithmetic"],
    difficulty: "standard-oxford",
    reasoningGraph: {
      version: "1.0.0",
      approaches: [
        { id: "parity-mod-2", label: "Parity sum modulo 2" },
        { id: "binary-encoding", label: "Binary code reduction" }
      ],
      milestones: [
        {
          id: "communication-constraint",
          description: "Recognize that the 100th prisoner can transmit exactly one bit of collective information to all other prisoners.",
          approachIds: ["parity-mod-2", "binary-encoding"],
          optionalPrerequisiteIds: [],
          protectedDisclosureIds: []
        },
        {
          id: "define-parity-sum",
          description: "Map Red to 0 and Blue to 1, and define the total parity S = sum_{i=1}^{99} h_i (mod 2).",
          approachIds: ["parity-mod-2"],
          optionalPrerequisiteIds: ["communication-constraint"],
          protectedDisclosureIds: [paritySumDisclosure]
        },
        {
          id: "subsequent-deduction",
          description: "Explain how each subsequent prisoner k computes their hat color from the parity of visible hats and past guesses.",
          approachIds: ["parity-mod-2", "binary-encoding"],
          optionalPrerequisiteIds: ["define-parity-sum"],
          protectedDisclosureIds: [subsequentDeductionDisclosure]
        },
        {
          id: "induction-guarantee",
          description: "Prove by induction that prisoners 99 down to 1 are guaranteed 100% survival, ensuring >= 99 pardons.",
          approachIds: ["parity-mod-2", "binary-encoding"],
          optionalPrerequisiteIds: ["subsequent-deduction"],
          protectedDisclosureIds: []
        }
      ],
      edges: [
        { from: "communication-constraint", to: "define-parity-sum" },
        { from: "define-parity-sum", to: "subsequent-deduction" },
        { from: "subsequent-deduction", to: "induction-guarantee" }
      ],
      commonErrors: [
        { id: "individual-guessing", description: "Attempts independent majority voting without using collective parity invariance." },
        { id: "voice-inflection", description: "Attempts side-channel signaling (pitch/volume) rather than mathematical encoding in the spoken word." }
      ],
      extensions: [
        { id: "three-hat-colors", prompt: "How would the strategy generalize if there are 3 possible hat colours instead of 2?" }
      ]
    },
    protectedDisclosures: [
      {
        id: paritySumDisclosure,
        fact: "The first prisoner announces the parity (sum mod 2) of the 99 hats visible ahead of them.",
        minimumDisclosureLevel: 2,
        equivalentFormulations: [
          "parity of the 99 hats",
          "sum of hat colors modulo 2",
          "sum of hat colours modulo 2",
          "first prisoner says the parity",
          "sum mod 2 of all visible hats"
        ]
      },
      {
        id: subsequentDeductionDisclosure,
        fact: "Each subsequent prisoner calculates their hat colour by subtracting visible hats and prior guesses from the announced parity.",
        minimumDisclosureLevel: 4,
        equivalentFormulations: [
          "subtract the visible hats from the announced parity",
          "deduce hat color from parity difference",
          "deduce hat colour from parity difference",
          "known parity minus visible hats"
        ]
      }
    ]
  },
  private: {
    canonicalSolution: "Encode Red as 0 and Blue as 1. Prisoner 100 calculates S = sum_{i=1}^{99} h_i (mod 2) and calls out Red if S=0 or Blue if S=1. Prisoner 99 sees hats 1..98, computes their sum S_{visible}, and deduces h_{99} = S - S_{visible} (mod 2). Each subsequent prisoner k tracks the running sum of already guessed hats plus visible hats to deduce h_k with 100% certainty.",
    verificationNotes: "Check that the student accounts for the modular arithmetic invariant and verifies that prisoner 100 has a 50% survival rate while prisoners 1..99 are 100% guaranteed."
  }
};

assertInterviewProblemIntegrity(prisonerHatsProblem);
