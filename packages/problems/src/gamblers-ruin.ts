import {
  DisclosureIdSchema,
  type InterviewProblem
} from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";

const gamblerRecurrenceDisclosure = DisclosureIdSchema.parse("disclosure_gambler_ruin_recurrence");
const gamblerSolutionDisclosure = DisclosureIdSchema.parse("disclosure_gambler_ruin_solution");

export const gamblersRuinProblem: InterviewProblem = {
  id: "quant-gamblers-ruin",
  version: "1.0.0",
  public: {
    prompt: "A gambler starts with £k (where 0 <= k <= N) and plays repeated independent rounds. In each round, the gambler wins £1 with probability p and loses £1 with probability q = 1 - p. The game terminates when fortune reaches £0 (ruin) or £N (victory). (a) Set up a recurrence relation for P_k, the probability of ultimate ruin starting from £k. (b) Solve this recurrence with boundary conditions for both p = 1/2 (fair coin) and p != 1/2 (biased coin).",
    givenInformation: [
      "The game stops at k = 0 (ruin) or k = N (target).",
      "Steps are independent with Pr(up) = p and Pr(down) = q = 1 - p."
    ]
  },
  interviewer: {
    topics: ["probability", "markov chains", "difference equations", "random walks", "martingales"],
    difficulty: "quant-trading",
    reasoningGraph: {
      version: "1.0.0",
      approaches: [
        { id: "difference-equation", label: "Second-order linear recurrence" }
      ],
      milestones: [
        {
          id: "total-probability-step",
          description: "Condition on the outcome of the first round to establish P_k = p * P_{k+1} + q * P_{k-1} for 1 <= k <= N-1.",
          approachIds: ["difference-equation"],
          optionalPrerequisiteIds: [],
          protectedDisclosureIds: [gamblerRecurrenceDisclosure]
        },
        {
          id: "boundary-conditions",
          description: "State the absorbing boundary conditions P_0 = 1 (certain ruin) and P_N = 0 (victory achieved).",
          approachIds: ["difference-equation"],
          optionalPrerequisiteIds: ["total-probability-step"],
          protectedDisclosureIds: []
        },
        {
          id: "solve-fair-game",
          description: "Solve the linear recurrence for p = 1/2, yielding P_k = 1 - k / N.",
          approachIds: ["difference-equation"],
          optionalPrerequisiteIds: ["boundary-conditions"],
          protectedDisclosureIds: []
        },
        {
          id: "solve-biased-game",
          description: "Solve the characteristic equation for p != 1/2 with roots 1 and q/p to obtain P_k = ((q/p)^k - (q/p)^N) / (1 - (q/p)^N).",
          approachIds: ["difference-equation"],
          optionalPrerequisiteIds: ["boundary-conditions"],
          protectedDisclosureIds: [gamblerSolutionDisclosure]
        }
      ],
      edges: [
        { from: "total-probability-step", to: "boundary-conditions" },
        { from: "boundary-conditions", to: "solve-fair-game" },
        { from: "boundary-conditions", to: "solve-biased-game" }
      ],
      commonErrors: [
        { id: "ignore-boundary", description: "Attempts to solve recurrence without setting absorbing boundary conditions at 0 and N." },
        { id: "conflate-p-half", description: "Applies the p != 1/2 characteristic formula to p = 1/2 without handling the repeated root (r = 1)." }
      ],
      extensions: [
        { id: "expected-duration", prompt: "How would you calculate E[T_k], the expected duration of the game starting from £k?" }
      ]
    },
    protectedDisclosures: [
      {
        id: gamblerRecurrenceDisclosure,
        fact: "Condition on the first coin flip to establish the recurrence relation P_k = p * P_{k+1} + q * P_{k-1}.",
        minimumDisclosureLevel: 2,
        equivalentFormulations: [
          "P_k = p P_{k+1} + q P_{k-1}",
          "P_k = p * P_{k+1} + q * P_{k-1}",
          "condition on the first step",
          "difference equation for ruin probability",
          "recurrence relation P_k = p P_{k+1} + q P_{k-1}"
        ]
      },
      {
        id: gamblerSolutionDisclosure,
        fact: "The characteristic roots are 1 and q/p, giving P_k = ((q/p)^k - (q/p)^N) / (1 - (q/p)^N) when p != 1/2.",
        minimumDisclosureLevel: 4,
        equivalentFormulations: [
          "characteristic roots 1 and q/p",
          "((q/p)^k - (q/p)^N) / (1 - (q/p)^N)",
          "((q/p)^k - (q/p)^N)/(1 - (q/p)^N)",
          "ruin probability formula ((q/p)^k - (q/p)^N)/(1 - (q/p)^N)"
        ]
      }
    ]
  },
  private: {
    canonicalSolution: "By the law of total probability, P_k = p P_{k+1} + q P_{k-1} with P_0 = 1 and P_N = 0. When p = 1/2, the characteristic equation has repeated root 1, yielding linear solution P_k = 1 - k/N. When p != 1/2, characteristic roots are 1 and q/p, so general solution is P_k = A + B (q/p)^k. Applying boundary conditions yields A = -(q/p)^N / (1 - (q/p)^N) and B = 1 / (1 - (q/p)^N), so P_k = ((q/p)^k - (q/p)^N) / (1 - (q/p)^N).",
    verificationNotes: "Ensure the student distinguishes the repeated root case (p = 1/2) from the distinct root case (p != 1/2) and applies boundary conditions cleanly."
  }
};

assertInterviewProblemIntegrity(gamblersRuinProblem);
