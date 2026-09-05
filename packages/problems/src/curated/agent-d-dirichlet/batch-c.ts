import { authorCuratedProblem, type CuratedProblemSpec } from "../../curated-authoring.js";
import { DIRICHLET_CANDIDATE_REVIEW_NOTES, evidence, makeDirichletAdaptive } from "./support.js";

export const oxfordDOddSymmetricDifferenceSpec: CuratedProblemSpec = {
  id: "oxford-d-odd-symmetric-difference",
  title: "Parity Geometry of Symmetric Difference",
  mode: "OXFORD_MATHEMATICS",
  category: "combinatorics",
  topics: ["set systems", "parity", "extremal families"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let U be a nonempty finite set. Build a graph whose vertices are all subsets of U, joining A and B when |A triangle B| is odd, where triangle denotes symmetric difference. Describe this graph completely. Deduce the largest possible family of subsets with every pair at odd symmetric-difference distance, and the largest possible family with every pair at even symmetric-difference distance.",
  givenInformation: ["A triangle B contains the elements that lie in exactly one of A and B.", "The ground set U has at least one element."],
  approaches: [{ id: "cardinality-parity-collapse", label: "Reduce symmetric-difference parity to the parity of the two set sizes" }],
  milestones: [
    { id: "test-set-pairs", description: "Compute symmetric differences for small subsets and look for a rule depending only on |A| and |B| modulo 2.", approachIds: ["cardinality-parity-collapse"], hintLevels: [1] },
    { id: "prove-parity-identity", description: "Prove |A triangle B|≡|A|+|B| mod 2.", approachIds: ["cardinality-parity-collapse"], prerequisiteIds: ["test-set-pairs"], hintLevels: [2] },
    { id: "identify-complete-bipartite-graph", description: "Partition all subsets into even-cardinality and odd-cardinality sides and prove all and only cross edges occur.", approachIds: ["cardinality-parity-collapse"], prerequisiteIds: ["prove-parity-identity"], hintLevels: [3] },
    { id: "bound-pairwise-odd-family", description: "Show a pairwise-odd family has at most two members and construct an example attaining two.", approachIds: ["cardinality-parity-collapse"], prerequisiteIds: ["identify-complete-bipartite-graph"], hintLevels: [4] },
    { id: "bound-pairwise-even-family", description: "Show a pairwise-even family lies entirely in one parity class and has size at most 2^{|U|-1}, with equality constructions.", approachIds: ["cardinality-parity-collapse"], prerequisiteIds: ["bound-pairwise-odd-family"], hintLevels: [5] }
  ],
  edges: [
    { from: "test-set-pairs", to: "prove-parity-identity" },
    { from: "prove-parity-identity", to: "identify-complete-bipartite-graph" },
    { from: "identify-complete-bipartite-graph", to: "bound-pairwise-odd-family" },
    { from: "bound-pairwise-odd-family", to: "bound-pairwise-even-family" }
  ],
  commonErrors: [
    { id: "uses-exact-distance", description: "Tries to classify exact symmetric-difference sizes even though only parity matters." },
    { id: "triangle-counterexample-missed", description: "Proposes three pairwise-odd sets without noticing two of the three must have the same cardinality parity." },
    { id: "half-power-set-no-proof", description: "States there are 2^{n-1} even subsets without giving a simple parity-pairing argument." }
  ],
  followUps: ["Why can there be no triangle in the odd-distance graph?", "How can you pair the power set to show exactly half the subsets have even size?"],
  extensions: [
    { id: "parity-class-count", prompt: "Prove directly, without the binomial theorem, that U has exactly 2^{|U|-1} even-cardinality subsets and the same number of odd-cardinality subsets." },
    { id: "odd-distance-graph-properties", prompt: "Use the complete-bipartite description to determine connectivity, diameter, and clique number of the odd-distance graph." }
  ],
  hints: [
    { level: 1, text: "Use |A triangle B|=|A|+|B|-2|A intersect B| and reduce modulo 2.", formulations: ["intersection contributes an even correction", "symmetric-difference parity ignores the overlap"] },
    { level: 2, text: "Modulo 2, |A triangle B| has the same parity as |A|+|B|.", formulations: ["odd distance means opposite set-size parity", "reduce to two parity classes"] },
    { level: 3, text: "Every even-sized subset is adjacent to every odd-sized subset, and there are no edges within either class.", formulations: ["the graph is complete bipartite", "partition by cardinality parity"] },
    { level: 4, text: "A clique in a bipartite graph has size at most 2, so a pairwise-odd family has at most two members.", formulations: ["pairwise odd means a clique", "two parity classes cannot host three pairwise cross pairs"] },
    { level: 5, text: "Pair each subset A with A triangle {u} for one fixed u in U. This bijection flips cardinality parity, so each parity class has 2^{|U|-1} members.", formulations: ["toggle one fixed element", "half the power set is even-sized"] }
  ],
  canonicalSolution: "The identity |A triangle B|=|A|+|B|-2|A intersect B| shows |A triangle B|≡|A|+|B| mod 2. Therefore A and B are adjacent exactly when their cardinalities have opposite parity. The graph is the complete bipartite graph whose two sides are the even-cardinality and odd-cardinality subsets of U. A family with every pair at odd distance is a clique in this bipartite graph, so it has at most two sets; two are attainable, for example the empty set and any singleton. A family with every pair at even distance must have all its sets in one parity class, so its size is at most the size of that class. Fix u in U. The involution A -> A triangle {u} pairs each even subset with an odd subset, proving the two classes have equal size 2^{|U|-1}. Thus the pairwise-even maximum is 2^{|U|-1}, attained by all even subsets or all odd subsets.",
  verificationNotes: "The nonempty-ground-set assumption is needed for the 2^{n-1} formula and for the size-2 odd-distance construction. Symmetric-difference parity depends only on set cardinality parity. The result is elementary but must still undergo Agent H's external near-neighbor review.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-odd-symmetric-difference",
    domains: ["set-theory", "combinatorics"],
    contentConcepts: ["set-relations", "parity", "counting-structure"],
    prerequisiteConcepts: ["set-notation", "counting-principles", "modular-arithmetic"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("case-analysis", "supporting"), evidence("generalization", "supporting")],
    difficulty: { entry: "introductory", core: "introductory-plus", ceiling: "standard" },
    novelty: "moderate",
    abstraction: "low",
    introducesNewDefinition: false,
    stages: [
      { id: "symdiff-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["set-theory", "combinatorics"], contentConcepts: ["set-relations", "parity"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "test-set-pairs", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["set-relations"] }], extensionIds: [], difficulty: "introductory" },
      { id: "symdiff-core", role: "core", prerequisiteStageIds: ["symdiff-opening"], domains: ["set-theory", "combinatorics"], contentConcepts: ["set-relations", "parity", "counting-structure"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "prove-parity-identity", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["parity", "set-relations"] },
        { milestoneId: "identify-complete-bipartite-graph", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["set-relations"] },
        { milestoneId: "bound-pairwise-odd-family", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["parity"] }
      ], extensionIds: [], difficulty: "introductory-plus" },
      { id: "symdiff-transfer", role: "transfer", prerequisiteStageIds: ["symdiff-core"], domains: ["set-theory", "combinatorics"], contentConcepts: ["set-relations", "parity", "counting-structure"], skillEvidence: [evidence("proof-construction", "primary"), evidence("generalization", "supporting")], milestones: [{ milestoneId: "bound-pairwise-even-family", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["counting-structure"] }], extensionIds: ["parity-class-count", "odd-distance-graph-properties"], difficulty: "standard"
      }
    ]
  })
};
export const oxfordDOddSymmetricDifferenceEntry = authorCuratedProblem(oxfordDOddSymmetricDifferenceSpec);

export const dirichletBatchCEntries = Object.freeze([
  oxfordDOddSymmetricDifferenceEntry,
] as const);
