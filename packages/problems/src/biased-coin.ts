import {
  DisclosureIdSchema,
  type InterviewProblem
} from "../../domain/src/index.js";
import { assertInterviewProblemIntegrity } from "./problem-integrity.js";

const pairConditioningDisclosure = DisclosureIdSchema.parse("disclosure_biased_coin_pair_conditioning");
const expectedFlipsDisclosure = DisclosureIdSchema.parse("disclosure_biased_coin_expected_flips");

export const biasedCoinProblem: InterviewProblem = {
  id: "quant-von-neumann-coin",
  version: "1.0.0",
  public: {
    prompt: "Suppose you have a biased coin that lands on Heads with unknown probability p in (0,1) and Tails with probability 1 - p. (a) How can you simulate a perfectly fair coin (Heads and Tails with probability exactly 1/2) using this biased coin? (b) Calculate the expected number of coin tosses required to produce one fair outcome.",
    givenInformation: [
      "Tosses are independent identically distributed (i.i.d.) Bernoulli(p) trials.",
      "The parameter p is strictly between 0 and 1 but unknown."
    ]
  },
  interviewer: {
    topics: ["probability", "information theory", "bernoulli trials", "expected value", "simulation"],
    difficulty: "quant-research",
    reasoningGraph: {
      version: "1.0.0",
      approaches: [
        { id: "pairwise-symmetry", label: "von Neumann pairwise symmetry" },
        { id: "entropy-extraction", label: "Algorithmic randomness extraction" }
      ],
      milestones: [
        {
          id: "toss-in-pairs-concept",
          description: "Consider tossing the biased coin in independent consecutive pairs: (H,H), (H,T), (T,H), (T,T).",
          approachIds: ["pairwise-symmetry", "entropy-extraction"],
          optionalPrerequisiteIds: [],
          protectedDisclosureIds: []
        },
        {
          id: "symmetry-observation",
          description: "Observe that Pr(HT) = p(1-p) and Pr(TH) = (1-p)p, which are equal for all p.",
          approachIds: ["pairwise-symmetry"],
          optionalPrerequisiteIds: ["toss-in-pairs-concept"],
          protectedDisclosureIds: [pairConditioningDisclosure]
        },
        {
          id: "mapping-rule",
          description: "Define the decision rule: HT maps to Fair Heads, TH maps to Fair Tails, and HH/TT are discarded to re-toss.",
          approachIds: ["pairwise-symmetry"],
          optionalPrerequisiteIds: ["symmetry-observation"],
          protectedDisclosureIds: []
        },
        {
          id: "expected-value-derivation",
          description: "Model the number of pairs until a discordant outcome as a geometric distribution with success probability 2p(1-p), giving expected tosses E[N] = 1 / (p(1-p)).",
          approachIds: ["pairwise-symmetry", "entropy-extraction"],
          optionalPrerequisiteIds: ["mapping-rule"],
          protectedDisclosureIds: [expectedFlipsDisclosure]
        }
      ],
      edges: [
        { from: "toss-in-pairs-concept", to: "symmetry-observation" },
        { from: "symmetry-observation", to: "mapping-rule" },
        { from: "mapping-rule", to: "expected-value-derivation" }
      ],
      commonErrors: [
        { id: "single-flip-normalization", description: "Attempts to estimate p first rather than using exact algebraic cancellation in paired flips." },
        { id: "wrong-geometric-factor", description: "Calculates the expected number of pairs (1 / (2p(1-p))) but forgets to multiply by 2 tosses per pair." }
      ],
      extensions: [
        { id: "iterated-von-neumann", prompt: "Can you improve the efficiency by extracting randomness from the discarded HH and TT pairs?" }
      ]
    },
    protectedDisclosures: [
      {
        id: pairConditioningDisclosure,
        fact: "Toss the coin in pairs and compare the probabilities of HT and TH.",
        minimumDisclosureLevel: 2,
        equivalentFormulations: [
          "toss in pairs",
          "compare HT and TH",
          "P(HT) equals P(TH)",
          "probability of HT is p(1-p) and TH is (1-p)p",
          "Pr(HT) = Pr(TH) = p(1-p)"
        ]
      },
      {
        id: expectedFlipsDisclosure,
        fact: "The pair outcomes HT and TH each occur with probability p(1-p), giving expected tosses equal to 1 / (p(1-p)).",
        minimumDisclosureLevel: 4,
        equivalentFormulations: [
          "1 / (p(1-p))",
          "1/(p(1-p))",
          "expected tosses 1/(p(1-p))",
          "geometric distribution with parameter 2p(1-p)",
          "2 / (2p(1-p)) = 1 / (p(1-p))"
        ]
      }
    ]
  },
  private: {
    canonicalSolution: "(a) Flip the coin in pairs. Pr(HT) = p(1-p) and Pr(TH) = (1-p)p = p(1-p). Since Pr(HT) = Pr(TH), map HT -> Fair Heads and TH -> Fair Tails. If HH or TT occurs, discard and flip a new pair. (b) In each pair, a valid outcome occurs with probability P_success = Pr(HT) + Pr(TH) = 2p(1-p). The number of pairs K until success follows a Geometric(2p(1-p)) distribution with E[K] = 1 / (2p(1-p)). Since each pair consists of 2 tosses, total expected tosses E[N] = 2 * E[K] = 2 / (2p(1-p)) = 1 / (p(1-p)).",
    verificationNotes: "Ensure the student correctly multiplies the expected number of pairs by 2 to obtain the total number of single tosses."
  }
};

assertInterviewProblemIntegrity(biasedCoinProblem);
