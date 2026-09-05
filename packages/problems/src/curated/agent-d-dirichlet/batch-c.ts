import { authorCuratedProblem, type CuratedProblemSpec } from "../../curated-authoring.js";
import { DIRICHLET_CANDIDATE_REVIEW_NOTES, evidence, makeDirichletAdaptive } from "./support.js";

export const oxfordDDiscreteMaximumPrincipleSpec: CuratedProblemSpec = {
  id: "oxford-d-discrete-maximum-principle",
  title: "A Discrete Maximum Principle on a Graph",
  mode: "OXFORD_MATHEMATICS",
  category: "graph theory",
  topics: ["graph theory", "extremal reasoning", "averages"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let G be a finite connected graph with at least two vertices. Put a real number f(v) at every vertex, and suppose each vertex value equals the average of the values at its neighbors. Prove that all vertex values are equal. Then investigate what remains true if the averaging rule is imposed only away from a nonempty set of boundary vertices.",
  givenInformation: ["The graph is finite, connected, and has no isolated vertices.", "Each average is taken over all neighbors of the vertex."],
  approaches: [{ id: "maximum-propagation", label: "Choose an extreme value and propagate equality through connectedness" }],
  milestones: [
    { id: "test-small-harmonic-graphs", description: "Solve the condition on a path, cycle, or star and conjecture that only constant labelings work.", approachIds: ["maximum-propagation"], hintLevels: [1] },
    { id: "choose-global-maximum", description: "Use finiteness to choose a vertex with maximum value M.", approachIds: ["maximum-propagation"], prerequisiteIds: ["test-small-harmonic-graphs"], hintLevels: [2] },
    { id: "force-neighbor-equality", description: "Show an average of numbers all at most M can equal M only when every neighbor also has value M.", approachIds: ["maximum-propagation"], prerequisiteIds: ["choose-global-maximum"], hintLevels: [3] },
    { id: "propagate-through-connectivity", description: "Iterate the neighbor argument along paths to prove every vertex has value M.", approachIds: ["maximum-propagation"], prerequisiteIds: ["force-neighbor-equality"], hintLevels: [4] },
    { id: "derive-boundary-version", description: "When only interior vertices average their neighbors, prove every maximum and minimum is controlled by the boundary unless the labeling is constant.", approachIds: ["maximum-propagation"], prerequisiteIds: ["propagate-through-connectivity"], hintLevels: [5] }
  ],
  edges: [
    { from: "test-small-harmonic-graphs", to: "choose-global-maximum" },
    { from: "choose-global-maximum", to: "force-neighbor-equality" },
    { from: "force-neighbor-equality", to: "propagate-through-connectivity" },
    { from: "propagate-through-connectivity", to: "derive-boundary-version" }
  ],
  commonErrors: [
    { id: "average-less-than-max", description: "Says the average of neighbors is strictly below the maximum without accounting for the case when every neighbor also attains the maximum." },
    { id: "propagation-without-connectivity", description: "Forces equality in the component of a maximum vertex but forgets connectedness is what reaches every vertex." },
    { id: "boundary-constant-overclaim", description: "In the boundary variant, incorrectly concludes all values are constant even though nonconstant harmonic extensions can exist." }
  ],
  followUps: ["Can the same proof use a minimum instead?", "What changes if the graph is disconnected?"],
  extensions: [
    { id: "boundary-maximum-principle", prompt: "Let B be a nonempty set of boundary vertices and impose the averaging rule only on V\B. Prove max_V f<=max_B f and min_V f>=min_B f." },
    { id: "positive-weighted-averages", prompt: "Replace the ordinary average by a positive weighted average of neighbors whose weights sum to 1. Which steps of the proof still work?" }
  ],
  hints: [
    { level: 1, text: "Because the graph is finite, one vertex has a largest label. Start there rather than trying to solve all linear equations.", formulations: ["look at a maximum", "use extremal reasoning"] },
    { level: 2, text: "Call the largest value M and choose v with f(v)=M. Every neighbor has value at most M.", formulations: ["all terms in the neighbor average are at most M", "focus on a maximizing vertex"] },
    { level: 3, text: "An average of finitely many numbers no larger than M equals M only if every one of those numbers equals M.", formulations: ["equality in the average forces equality termwise", "all neighbors of a maximum are also maxima"] },
    { level: 4, text: "Every neighbor of v is also labeled M; repeat along a path from v to any other vertex.", formulations: ["propagate maximum along paths", "connectedness spreads equality"] },
    { level: 5, text: "For a boundary version, suppose an interior vertex exceeds every boundary value. Propagating its maximum must eventually reach the boundary, giving a contradiction.", formulations: ["an interior strict maximum cannot exceed the boundary", "propagate to the boundary"] }
  ],
  canonicalSolution: "Let M=max_v f(v), which exists because G is finite, and choose v with f(v)=M. Every neighbor u of v has f(u)<=M. Since f(v) is the average of these neighbor values and equals M, every neighbor must itself have value M; otherwise the average would be strictly smaller than M. Apply the same argument to each of those neighbors. Along any path starting at v, every successive vertex therefore has value M. Connectedness gives a path from v to every vertex, so f is constant. For the boundary variant, if an interior vertex attained a value larger than every boundary value, choose a global maximum M at an interior vertex. The same equality argument propagates M along every path until a boundary vertex is reached, contradicting the boundary bound. Thus max_V f<=max_B f. Applying the argument to -f gives min_V f>=min_B f. Positive weighted averages work identically provided every neighbor receives positive weight.",
  verificationNotes: "At least two connected vertices ensures each vertex has a nonempty neighbor set. Finiteness supplies a maximum. The propagation argument is exact because all weights in the ordinary average are positive. The boundary extension assumes B is nonempty; connectedness then ensures any interior maximum can be connected to B.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-discrete-maximum-principle",
    domains: ["graph-theory", "elementary-analysis"],
    contentConcepts: ["paths-cycles-connectivity", "inequalities-bounds"],
    prerequisiteConcepts: ["graph-basics", "arithmetic", "equations-inequalities"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("strategic-simplification", "primary"), evidence("proof-construction", "primary"), evidence("generalization", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "maximum-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["graph-theory", "elementary-analysis"], contentConcepts: ["paths-cycles-connectivity", "inequalities-bounds"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "test-small-harmonic-graphs", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["paths-cycles-connectivity"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening" },
      { id: "maximum-core", role: "core", prerequisiteStageIds: ["maximum-opening"], domains: ["graph-theory", "elementary-analysis"], contentConcepts: ["paths-cycles-connectivity", "inequalities-bounds"], skillEvidence: [evidence("strategic-simplification", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "choose-global-maximum", skillEvidence: [evidence("strategic-simplification", "primary")], contentConcepts: ["inequalities-bounds"] },
        { milestoneId: "force-neighbor-equality", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["inequalities-bounds"] },
        { milestoneId: "propagate-through-connectivity", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["paths-cycles-connectivity"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "maximum-transfer", role: "transfer", prerequisiteStageIds: ["maximum-core"], domains: ["graph-theory", "elementary-analysis"], contentConcepts: ["paths-cycles-connectivity", "inequalities-bounds"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "derive-boundary-version", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["inequalities-bounds"] }], extensionIds: ["boundary-maximum-principle", "positive-weighted-averages"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDDiscreteMaximumPrincipleEntry = authorCuratedProblem(oxfordDDiscreteMaximumPrincipleSpec);

export const oxfordDFiniteMapCyclesSpec: CuratedProblemSpec = {
  id: "oxford-d-finite-map-cycles",
  title: "When Does Every Point of a Finite Map Lie on a Cycle?",
  mode: "OXFORD_MATHEMATICS",
  category: "logic and proof",
  topics: ["finite functions", "directed graphs", "iteration"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let X be a finite nonempty set and f:X->X. Draw an arrow x->f(x) from each point. Prove that f is injective if and only if every point of X lies on a directed cycle. Then describe the structure that replaces this statement for an arbitrary function f.",
  givenInformation: ["Every vertex has exactly one outgoing arrow.", "A point lies on a directed cycle if some positive iterate f^r returns it to itself."],
  approaches: [{ id: "functional-digraph", label: "Switch between iteration and the directed graph of a finite function" }],
  milestones: [
    { id: "draw-functional-examples", description: "Draw small maps and distinguish pure cycles from components with tails feeding into cycles.", approachIds: ["functional-digraph"], hintLevels: [1] },
    { id: "use-eventual-repetition", description: "For any x, use finiteness to find i<j with f^i(x)=f^j(x).", approachIds: ["functional-digraph"], prerequisiteIds: ["draw-functional-examples"], hintLevels: [2] },
    { id: "cancel-under-injectivity", description: "When f is injective, cancel iterates from the repetition to prove x itself returns and lies on a cycle.", approachIds: ["functional-digraph"], prerequisiteIds: ["use-eventual-repetition"], hintLevels: [3] },
    { id: "prove-converse-via-predecessors", description: "If every point lies on a cycle, show every point has a predecessor and hence f is surjective, then injective because X is finite.", approachIds: ["functional-digraph"], prerequisiteIds: ["cancel-under-injectivity"], hintLevels: [4] },
    { id: "classify-arbitrary-components", description: "Show every component of an arbitrary finite functional digraph consists of one directed cycle with directed trees feeding into it.", approachIds: ["functional-digraph"], prerequisiteIds: ["prove-converse-via-predecessors"], hintLevels: [5] }
  ],
  edges: [
    { from: "draw-functional-examples", to: "use-eventual-repetition" },
    { from: "use-eventual-repetition", to: "cancel-under-injectivity" },
    { from: "cancel-under-injectivity", to: "prove-converse-via-predecessors" },
    { from: "prove-converse-via-predecessors", to: "classify-arbitrary-components" }
  ],
  commonErrors: [
    { id: "eventual-cycle-is-start-cycle", description: "Uses finiteness to show an orbit eventually repeats and incorrectly concludes the starting point itself lies on the cycle without injectivity." },
    { id: "infinite-surjective-injective", description: "Uses surjective implies injective without noting that this implication relies on finiteness." },
    { id: "multiple-cycles-one-component", description: "Claims a functional-digraph component can contain two cycles despite every vertex having a unique forward orbit." }
  ],
  followUps: ["Give an example where x eventually reaches a cycle but is not on it.", "Why can one weakly connected component not contain two different directed cycles?"],
  extensions: [
    { id: "component-shape", prompt: "Prove each weakly connected component of a finite functional digraph contains exactly one directed cycle." },
    { id: "finite-bijection-equivalence", prompt: "Recover the usual finite-set theorem injective iff surjective from the arrow picture rather than quoting cardinality directly." }
  ],
  hints: [
    { level: 1, text: "Follow x,f(x),f^2(x),... . Finiteness forces two terms to agree, but decide carefully whether the repeated part must include x.", formulations: ["iterate until repetition", "distinguish a tail from a cycle"] },
    { level: 2, text: "There are i<j with f^i(x)=f^j(x). If f is injective, equality f(a)=f(b) lets you cancel one application of f.", formulations: ["injectivity lets you cancel iterates", "pull the repetition backward"] },
    { level: 3, text: "Cancel i times to obtain x=f^{j-i}(x), which puts x on a cycle.", formulations: ["the starting point returns", "injectivity removes the tail"] },
    { level: 4, text: "If x lies on a cycle, the previous vertex on that cycle maps to x. Thus every x has a preimage; on a finite set, a surjection cannot identify two inputs.", formulations: ["cycles give predecessors", "surjective finite map is injective"] },
    { level: 5, text: "For arbitrary f, each forward orbit eventually reaches a cycle. If two cycles lay in one weak component, trace the unique forward arrows from a connecting path to get a contradiction.", formulations: ["one cycle per component", "trees feed into the unique cycle"] }
  ],
  canonicalSolution: "Fix x in X. The sequence x,f(x),f^2(x),... must repeat because X is finite, so f^i(x)=f^j(x) for some 0<=i<j. If f is injective, then every iterate f^i is injective, so cancelling i applications gives x=f^{j-i}(x). Hence x lies on a directed cycle. Since x was arbitrary, every point does. Conversely, suppose every point lies on a directed cycle. For each x, take the vertex immediately preceding x on its cycle; it maps to x. Thus f is surjective. A surjection from a finite set to itself is injective: otherwise two inputs would share an image, leaving too few distinct images to cover X. For arbitrary f, every forward orbit still eventually repeats, so it enters a directed cycle, but it may have a nonempty tail before the cycle. Because every vertex has exactly one outgoing arrow, two distinct directed cycles cannot merge under forward iteration; each weakly connected component therefore consists of one directed cycle with directed in-trees feeding into its cycle vertices.",
  verificationNotes: "The equivalence is finite-only. Eventual periodicity alone does not put the initial point on a cycle; injectivity is what removes the tail. The component description permits arbitrary branching in the incoming trees but exactly one outgoing edge per vertex.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-finite-map-cycles",
    domains: ["set-theory", "functions", "graph-theory"],
    contentConcepts: ["set-maps", "composition-iteration", "paths-cycles-connectivity"],
    prerequisiteConcepts: ["set-notation", "functions-graphs", "graph-basics"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("generalization", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "finite-map-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["set-theory", "functions", "graph-theory"], contentConcepts: ["set-maps", "composition-iteration", "paths-cycles-connectivity"], skillEvidence: [evidence("small-case-exploration", "primary"), evidence("representation-switching", "supporting")], milestones: [{ milestoneId: "draw-functional-examples", skillEvidence: [evidence("small-case-exploration", "primary"), evidence("representation-switching", "supporting")], contentConcepts: ["set-maps", "paths-cycles-connectivity"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening" },
      { id: "finite-map-core", role: "core", prerequisiteStageIds: ["finite-map-opening"], domains: ["set-theory", "functions", "graph-theory"], contentConcepts: ["set-maps", "composition-iteration", "paths-cycles-connectivity"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "use-eventual-repetition", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["composition-iteration"] },
        { milestoneId: "cancel-under-injectivity", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["set-maps", "composition-iteration"] },
        { milestoneId: "prove-converse-via-predecessors", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["set-maps"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "finite-map-transfer", role: "transfer", prerequisiteStageIds: ["finite-map-core"], domains: ["set-theory", "functions", "graph-theory"], contentConcepts: ["set-maps", "composition-iteration", "paths-cycles-connectivity"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "classify-arbitrary-components", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["paths-cycles-connectivity"] }], extensionIds: ["component-shape", "finite-bijection-equivalence"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDFiniteMapCyclesEntry = authorCuratedProblem(oxfordDFiniteMapCyclesSpec);

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
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("extremal-configuration", "supporting")],
    difficulty: { entry: "introductory", core: "introductory-plus", ceiling: "standard" },
    novelty: "moderate",
    abstraction: "low",
    introducesNewDefinition: false,
    stages: [
      { id: "symdiff-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["set-theory", "combinatorics"], contentConcepts: ["set-relations", "parity"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "test-set-pairs", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["set-relations"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening" },
      { id: "symdiff-core", role: "core", prerequisiteStageIds: ["symdiff-opening"], domains: ["set-theory", "combinatorics"], contentConcepts: ["set-relations", "parity", "counting-structure"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "prove-parity-identity", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["parity", "set-relations"] },
        { milestoneId: "identify-complete-bipartite-graph", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["set-relations"] },
        { milestoneId: "bound-pairwise-odd-family", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["parity"] }
      ], extensionIds: [], difficulty: "introductory-plus", timingKind: "core" },
      { id: "symdiff-transfer", role: "transfer", prerequisiteStageIds: ["symdiff-core"], domains: ["set-theory", "combinatorics"], contentConcepts: ["set-relations", "parity", "counting-structure"], skillEvidence: [evidence("proof-construction", "primary"), evidence("generalization", "supporting")], milestones: [{ milestoneId: "bound-pairwise-even-family", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["counting-structure"] }], extensionIds: ["parity-class-count", "odd-distance-graph-properties"], difficulty: "standard", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDOddSymmetricDifferenceEntry = authorCuratedProblem(oxfordDOddSymmetricDifferenceSpec);

export const oxfordDSpanningTreeExchangeSpec: CuratedProblemSpec = {
  id: "oxford-d-spanning-tree-exchange",
  title: "Transforming One Spanning Tree into Another",
  mode: "OXFORD_MATHEMATICS",
  category: "graph theory",
  topics: ["spanning trees", "constructive proof", "exchange arguments"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let T and U be two spanning trees of the same finite connected graph G. Prove that T can be transformed into U by repeatedly adding an edge of U that is not currently present and deleting one edge not in U, while remaining a spanning tree after every step. Make the proof constructive and bound the number of steps.",
  givenInformation: ["A tree has a unique path between any two of its vertices.", "Adding one non-tree edge to a tree creates exactly one cycle."],
  approaches: [{ id: "cycle-exchange", label: "Add a target edge, remove a non-target edge from the unique created cycle, and iterate" }],
  milestones: [
    { id: "try-small-tree-swaps", description: "Experiment on a small graph with two different spanning trees and identify the add-then-delete pattern.", approachIds: ["cycle-exchange"], hintLevels: [1] },
    { id: "add-target-edge-cycle", description: "Choose e in U\T and show T+e contains one cycle.", approachIds: ["cycle-exchange"], prerequisiteIds: ["try-small-tree-swaps"], hintLevels: [2] },
    { id: "find-removable-nontarget-edge", description: "Prove the created cycle contains some edge f in T\U; otherwise U would contain the whole cycle.", approachIds: ["cycle-exchange"], prerequisiteIds: ["add-target-edge-cycle"], hintLevels: [3] },
    { id: "increase-tree-overlap", description: "Replace f by e, prove the result is a spanning tree, and show |T intersect U| increases by one.", approachIds: ["cycle-exchange"], prerequisiteIds: ["find-removable-nontarget-edge"], hintLevels: [4] },
    { id: "iterate-and-transfer-weighted", description: "Conclude in exactly |T\U| exchanges and derive the standard no-cheaper-cycle-swap consequence for a minimum-weight spanning tree.", approachIds: ["cycle-exchange"], prerequisiteIds: ["increase-tree-overlap"], hintLevels: [5] }
  ],
  edges: [
    { from: "try-small-tree-swaps", to: "add-target-edge-cycle" },
    { from: "add-target-edge-cycle", to: "find-removable-nontarget-edge" },
    { from: "find-removable-nontarget-edge", to: "increase-tree-overlap" },
    { from: "increase-tree-overlap", to: "iterate-and-transfer-weighted" }
  ],
  commonErrors: [
    { id: "removes-any-cycle-edge", description: "Deletes an arbitrary edge from the created cycle; it must be chosen outside U to guarantee monotone progress toward U." },
    { id: "cycle-contained-in-u", description: "Fails to use that U is acyclic when proving a removable non-U edge exists." },
    { id: "at-most-not-exact", description: "Says the procedure needs at most |T\U| exchanges but overlooks that each permitted exchange can add only one missing U-edge, so that many are necessary and sufficient." }
  ],
  followUps: ["Why does removing any edge of the created cycle restore a spanning tree?", "What weighted-tree fact follows if a cheaper replacement edge existed?"],
  extensions: [
    { id: "minimum-tree-cycle-property", prompt: "If T is a minimum-weight spanning tree and e is not in T, prove no edge on the T-path between e's endpoints can have weight strictly larger than e." },
    { id: "exchange-distance", prompt: "Prove the minimum number of allowed target-edge exchanges required to turn T into U is exactly |T\U|." }
  ],
  hints: [
    { level: 1, text: "If T is not U, choose an edge e that U has and T lacks. What happens when you temporarily add e to T?", formulations: ["add a missing target edge", "one extra edge creates one cycle"] },
    { level: 2, text: "T+e has a unique cycle C consisting of e plus the T-path between its endpoints.", formulations: ["identify the fundamental cycle", "use the unique tree path"] },
    { level: 3, text: "Not every other edge of C can lie in U, because e is already in U and then U would contain a cycle. Choose f in C that is not in U.", formulations: ["acyclicity of U supplies the edge to delete", "remove a non-target edge from the cycle"] },
    { level: 4, text: "T-f+e is connected and has the right number of edges, hence is a spanning tree. It has one more edge in common with U.", formulations: ["the overlap increases by one", "each exchange makes monotone progress"] },
    { level: 5, text: "Repeat until no U-edge is missing. For weights, if e were lighter than some path edge f, the same swap would produce a cheaper spanning tree.", formulations: ["iterate exactly the symmetric difference away", "reuse the exchange for a weight contradiction"] }
  ],
  canonicalSolution: "If T=U there is nothing to do. Otherwise choose e in U\T. Adding e to T creates a unique cycle C: the edge e plus the unique T-path between its endpoints. Because U is itself a tree and already contains e, C cannot have every other edge in U; otherwise U would contain C. Hence choose f in C with f in T\U. Delete f. The graph T'=T-f+e is still connected because removing one edge from a cycle does not disconnect it, and it has |V|-1 edges, so it is a spanning tree. Moreover T' has gained e from U and lost f outside U, so |T' intersect U|=|T intersect U|+1. Repeating this step eventually reaches U. Each move adds exactly one previously missing edge of U, so exactly |U\T|=|T\U| exchanges are both sufficient and necessary. For the weighted extension, if T is minimum-weight and a non-tree edge e were lighter than some edge f on the T-path between its endpoints, then T-f+e would be a spanning tree of smaller total weight, contradiction.",
  verificationNotes: "The unique-cycle fact is a stated prerequisite. The removable edge f must be in T\U, not merely any T-edge. The equality |T\U|=|U\T| follows because both spanning trees have |V|-1 edges. The weighted extension allows equal weights; only a strict inequality gives a contradiction.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-spanning-tree-exchange",
    domains: ["graph-theory", "combinatorics"],
    contentConcepts: ["paths-cycles-connectivity", "extremal-configuration"],
    prerequisiteConcepts: ["graph-basics"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("proof-construction", "primary"), evidence("invariants", "supporting"), evidence("transfer", "primary")],
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "tree-exchange-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["graph-theory", "combinatorics"], contentConcepts: ["paths-cycles-connectivity", "extremal-configuration"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "try-small-tree-swaps", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["paths-cycles-connectivity"] }], extensionIds: [], difficulty: "introductory-plus", timingKind: "opening" },
      { id: "tree-exchange-core", role: "core", prerequisiteStageIds: ["tree-exchange-opening"], domains: ["graph-theory", "combinatorics"], contentConcepts: ["paths-cycles-connectivity", "extremal-configuration"], skillEvidence: [evidence("proof-construction", "primary"), evidence("invariants", "supporting")], milestones: [
        { milestoneId: "add-target-edge-cycle", skillEvidence: [evidence("proof-construction", "supporting")], contentConcepts: ["paths-cycles-connectivity"] },
        { milestoneId: "find-removable-nontarget-edge", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["paths-cycles-connectivity"] },
        { milestoneId: "increase-tree-overlap", skillEvidence: [evidence("invariants", "primary"), evidence("proof-construction", "supporting")], contentConcepts: ["extremal-configuration"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "tree-exchange-transfer", role: "transfer", prerequisiteStageIds: ["tree-exchange-core"], domains: ["graph-theory", "combinatorics"], contentConcepts: ["paths-cycles-connectivity", "extremal-configuration"], skillEvidence: [evidence("transfer", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "iterate-and-transfer-weighted", skillEvidence: [evidence("transfer", "primary")], contentConcepts: ["extremal-configuration"] }], extensionIds: ["minimum-tree-cycle-property", "exchange-distance"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDSpanningTreeExchangeEntry = authorCuratedProblem(oxfordDSpanningTreeExchangeSpec);

export const oxfordDStableBinaryWordsSpec: CuratedProblemSpec = {
  id: "oxford-d-stable-binary-words",
  title: "Binary Words with No Isolated Run of Ones",
  mode: "OXFORD_MATHEMATICS",
  category: "combinatorics",
  topics: ["counting", "recurrences", "state decomposition"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Call a binary word stable if every maximal run of 1s has length at least 2. Let a_n be the number of stable binary words of length n, with a_0=1 for the empty word. Compute the first few values, derive and prove a recurrence for a_n, and then generalize the mechanism when every run of 1s is required to have length at least L.",
  givenInformation: ["A run is a maximal consecutive block of equal symbols.", "The all-zero word is stable."],
  approaches: [{ id: "final-run-decomposition", label: "Decompose by the final symbol or final run length and compare consecutive counting formulas" }],
  milestones: [
    { id: "enumerate-small-words", description: "Compute a_0 through a_4 and notice why a one-state Fibonacci-style split is insufficient.", approachIds: ["final-run-decomposition"], hintLevels: [1] },
    { id: "split-by-final-zero-or-run", description: "Separate stable words ending in 0 from those ending in a final run of r>=2 ones.", approachIds: ["final-run-decomposition"], prerequisiteIds: ["enumerate-small-words"], hintLevels: [2] },
    { id: "derive-sum-recurrence", description: "Prove a_n=a_{n-1}+1+sum_{j=0}^{n-3}a_j for n>=2, interpreting the all-ones word separately.", approachIds: ["final-run-decomposition"], prerequisiteIds: ["split-by-final-zero-or-run"], hintLevels: [3] },
    { id: "compress-to-order-three", description: "Subtract the formula for a_{n-1} to obtain a_n=2a_{n-1}-a_{n-2}+a_{n-3} for n>=3.", approachIds: ["final-run-decomposition"], prerequisiteIds: ["derive-sum-recurrence"], hintLevels: [4] },
    { id: "generalize-minimum-run", description: "For minimum run length L>=2, derive the analogous recurrence and identify the shifted term.", approachIds: ["final-run-decomposition"], prerequisiteIds: ["compress-to-order-three"], hintLevels: [5] }
  ],
  edges: [
    { from: "enumerate-small-words", to: "split-by-final-zero-or-run" },
    { from: "split-by-final-zero-or-run", to: "derive-sum-recurrence" },
    { from: "derive-sum-recurrence", to: "compress-to-order-three" },
    { from: "compress-to-order-three", to: "generalize-minimum-run" }
  ],
  commonErrors: [
    { id: "naive-fibonacci", description: "Treats a final 1 as an independent legal ending and writes an unjustified two-term Fibonacci recurrence." },
    { id: "forgets-all-ones", description: "In the final-run decomposition, omits the word consisting entirely of 1s." },
    { id: "wrong-prefix-index", description: "Counts a prefix ending in 0 by a_{n-r} instead of a_{n-r-1}; the separator zero must be included explicitly." }
  ],
  followUps: ["Can you derive the recurrence using three ending states instead?", "What initial values are needed for the L-run generalization?"],
  extensions: [
    { id: "three-state-automaton", prompt: "Count with three states: ending in 0, ending in a single 1, and ending in a run of at least two 1s. Derive the same scalar recurrence." },
    { id: "minimum-run-l", prompt: "If every 1-run must have length at least L>=2, prove a_n=2a_{n-1}-a_{n-2}+a_{n-L-1} once the indices are in range, and state suitable initial values." }
  ],
  hints: [
    { level: 1, text: "List the words for n<=4. The issue is that a word may temporarily end in a single 1 even though that state is not yet a valid final word.", formulations: ["small cases reveal a boundary state", "track the last run"] },
    { level: 2, text: "A stable word either ends in 0, or its final run has r>=2 ones. Words ending in 0 are obtained by appending 0 to any stable word.", formulations: ["split by the final run", "ending zero contributes a_{n-1}"] },
    { level: 3, text: "If the final 1-run has length r<n, the symbol before it is 0; before that separator may be any stable word of length n-r-1. Also count the all-ones word.", formulations: ["sum over final run lengths", "remember the all-ones case"] },
    { level: 4, text: "Write the sum formula for n and for n-1 and subtract; nearly the entire cumulative sum cancels.", formulations: ["subtract consecutive formulas", "compress the cumulative recurrence"] },
    { level: 5, text: "With minimum run length L, the final-run sum starts at r=L, so after subtraction the new surviving term is a_{n-L-1}.", formulations: ["shift the lower run bound", "the mechanism generalizes by one index change"] }
  ],
  canonicalSolution: "The first values are a_0=1,a_1=1,a_2=2,a_3=4,a_4=7. For n>=2, a stable word either ends in 0, contributing a_{n-1}, or ends in a run of r>=2 ones. If r=n there is the single all-ones word. If 2<=r<=n-1, the final run is preceded by 0, and the part before that 0 is an arbitrary stable word of length n-r-1, contributing a_{n-r-1}. Hence a_n=a_{n-1}+1+sum_{r=2}^{n-1}a_{n-r-1}=a_{n-1}+1+sum_{j=0}^{n-3}a_j. Subtract the same formula for n-1 to get a_n-a_{n-1}=a_{n-1}-a_{n-2}+a_{n-3}, so a_n=2a_{n-1}-a_{n-2}+a_{n-3} for n>=3. For a minimum allowed 1-run length L>=2, the identical decomposition gives a_n=a_{n-1}+1+sum_{j=0}^{n-L-1}a_j, and subtracting consecutive formulas yields a_n=2a_{n-1}-a_{n-2}+a_{n-L-1} for n>=L+1, with the small values supplied directly.",
  verificationNotes: "Direct enumeration gives 1,1,2,4,7,12,21 for n=0,...,6, matching the recurrence. In the cumulative formula, the all-ones word is the isolated +1. For the L-generalization, the recurrence starts at n>=L+1 and initial values should be enumerated from the definition.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-stable-binary-words",
    domains: ["combinatorics", "sequences-recurrences"],
    contentConcepts: ["counting-structure", "recurrence-decomposition"],
    prerequisiteConcepts: ["counting-principles", "sequences-series"],
    skillEvidence: [evidence("small-case-exploration", "primary"), evidence("representation-switching", "supporting"), evidence("proof-construction", "primary"), evidence("generalization", "primary")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "high",
    abstraction: "low",
    introducesNewDefinition: true,
    stages: [
      { id: "stable-word-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["combinatorics", "sequences-recurrences"], contentConcepts: ["counting-structure", "recurrence-decomposition"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "enumerate-small-words", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["counting-structure"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening", introducesNewDefinition: true },
      { id: "stable-word-core", role: "core", prerequisiteStageIds: ["stable-word-opening"], domains: ["combinatorics", "sequences-recurrences"], contentConcepts: ["counting-structure", "recurrence-decomposition"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "split-by-final-zero-or-run", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["recurrence-decomposition"] },
        { milestoneId: "derive-sum-recurrence", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["counting-structure", "recurrence-decomposition"] },
        { milestoneId: "compress-to-order-three", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["recurrence-decomposition"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "stable-word-transfer", role: "transfer", prerequisiteStageIds: ["stable-word-core"], domains: ["combinatorics", "sequences-recurrences"], contentConcepts: ["counting-structure", "recurrence-decomposition"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "generalize-minimum-run", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["recurrence-decomposition"] }], extensionIds: ["three-state-automaton", "minimum-run-l"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDStableBinaryWordsEntry = authorCuratedProblem(oxfordDStableBinaryWordsSpec);

export const oxfordDDirectedFlowDecompositionSpec: CuratedProblemSpec = {
  id: "oxford-d-directed-flow-decomposition",
  title: "Cycles Plus One Directed Flow Path",
  mode: "OXFORD_MATHEMATICS",
  category: "graph theory",
  topics: ["directed graphs", "cycle decomposition", "constructive proof"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "In a finite directed graph, suppose two distinct vertices s and t satisfy outdeg(s)=indeg(s)+1 and indeg(t)=outdeg(t)+1, while every other vertex has equal indegree and outdegree. Prove that the entire edge set can be partitioned into directed cycles together with one directed path from s to t. Build the proof from a balanced-graph lemma rather than invoking Euler-tour theory as a black box.",
  givenInformation: ["Edges are treated as distinct; parallel directed edges cause no difficulty.", "No connectivity assumption is made."],
  approaches: [{ id: "balance-and-add-edge", label: "First decompose balanced digraphs into cycles, then add one artificial edge to balance the two exceptional vertices" }],
  milestones: [
    { id: "find-cycle-in-balanced-graph", description: "In a nonempty balanced digraph, follow outgoing edges until a vertex repeats and extract a directed cycle.", approachIds: ["balance-and-add-edge"], hintLevels: [1] },
    { id: "prove-cycle-decomposition", description: "Remove a directed cycle, observe balance is preserved, and induct on the number of edges.", approachIds: ["balance-and-add-edge"], prerequisiteIds: ["find-cycle-in-balanced-graph"], hintLevels: [2] },
    { id: "add-artificial-return-edge", description: "Add one artificial edge t->s and verify every vertex in the augmented graph becomes balanced.", approachIds: ["balance-and-add-edge"], prerequisiteIds: ["prove-cycle-decomposition"], hintLevels: [3] },
    { id: "extract-s-to-t-path", description: "In the augmented cycle decomposition, locate the unique cycle containing the artificial edge and remove that edge to obtain a directed s-to-t path.", approachIds: ["balance-and-add-edge"], prerequisiteIds: ["add-artificial-return-edge"], hintLevels: [4] },
    { id: "generalize-r-unit-imbalance", description: "If the imbalance is r rather than 1, add r artificial t->s edges and deduce a decomposition into r s-to-t paths plus cycles.", approachIds: ["balance-and-add-edge"], prerequisiteIds: ["extract-s-to-t-path"], hintLevels: [5] }
  ],
  edges: [
    { from: "find-cycle-in-balanced-graph", to: "prove-cycle-decomposition" },
    { from: "prove-cycle-decomposition", to: "add-artificial-return-edge" },
    { from: "add-artificial-return-edge", to: "extract-s-to-t-path" },
    { from: "extract-s-to-t-path", to: "generalize-r-unit-imbalance" }
  ],
  commonErrors: [
    { id: "gets-stuck-following-edge", description: "Follows an incoming edge into a balanced vertex but does not explain why that vertex must have an outgoing edge available." },
    { id: "balance-after-removal", description: "Deletes a cycle without explicitly noting that each cycle vertex loses one incoming and one outgoing edge." },
    { id: "wrong-artificial-direction", description: "Adds s->t instead of t->s, doubling rather than cancelling the prescribed imbalances." }
  ],
  followUps: ["Why does a nonempty balanced directed graph necessarily contain a directed cycle?", "What changes if the imbalance at s and t is r instead of 1?"],
  extensions: [
    { id: "r-path-decomposition", prompt: "Assume outdeg(s)=indeg(s)+r and indeg(t)=outdeg(t)+r for r>=1, with balance elsewhere. Prove a decomposition into r directed s-to-t paths and directed cycles." },
    { id: "many-sources-sinks", prompt: "Conjecture the corresponding decomposition when several vertices have positive or negative integer imbalance whose total sums to zero." }
  ],
  hints: [
    { level: 1, text: "In a balanced graph, once you arrive at a vertex along an edge, its positive indegree forces positive outdegree. Keep following arrows until a vertex repeats.", formulations: ["balanced means you can keep walking", "finiteness produces a directed cycle"] },
    { level: 2, text: "Delete the edges of one directed cycle. At each cycle vertex, one incoming and one outgoing edge disappear, so balance remains.", formulations: ["cycle removal preserves balance", "induct on edge count"] },
    { level: 3, text: "The surplus at s is one outgoing edge; the deficit at t is one incoming edge. Add an artificial edge t->s to fix both.", formulations: ["balance the graph with a return edge", "add t to s, not s to t"] },
    { level: 4, text: "Decompose the augmented graph into cycles. Exactly one decomposition cycle contains the artificial edge; deleting it from that cycle leaves a directed path beginning at s and ending at t.", formulations: ["break the cycle at the artificial edge", "recover the one flow path"] },
    { level: 5, text: "For imbalance r, add r distinguishable artificial t->s edges and break the r cycles that contain them.", formulations: ["repeat the balancing trick r times", "obtain r paths plus cycles"] }
  ],
  canonicalSolution: "First prove the balanced lemma. If a finite directed graph is balanced at every vertex and has at least one edge, start by following any directed edge. Whenever the walk arrives at a vertex, that vertex has positive indegree and therefore, by balance, positive outdegree, so the walk can continue. Finiteness eventually repeats a vertex; the segment between first occurrences gives a directed cycle. Remove the edges of that cycle. Every vertex on it loses one incoming and one outgoing edge, so the remaining graph is still balanced. Induction on the number of edges decomposes every balanced digraph into edge-disjoint directed cycles. Now return to the stated graph and add one artificial edge t->s. At s the extra incoming edge cancels its outgoing surplus, and at t the extra outgoing edge cancels its incoming surplus; all vertices are balanced. Decompose the augmented edge set into directed cycles. The artificial edge belongs to one such cycle. Removing it from that directed cycle leaves a directed path from s to t; every other cycle remains unchanged. Thus the original edges partition into that path and directed cycles. If the imbalance is r, add r artificial t->s edges and apply the same argument, breaking the r cycles that contain those artificial edges into r directed s-to-t paths.",
  verificationNotes: "The balanced-cycle lemma does not require connectedness. The repeated-vertex segment can be chosen as a directed simple cycle by stopping at the first repetition. Adding t->s is the correct direction. With r artificial edges, a cycle decomposition places each artificial edge in some cycle; if a cycle contains multiple artificial edges, breaking at all of them produces the corresponding number of s-to-t paths, so the total is still r.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-directed-flow-decomposition",
    domains: ["graph-theory"],
    contentConcepts: ["degree-structure", "paths-cycles-connectivity"],
    prerequisiteConcepts: ["graph-basics", "induction"],
    skillEvidence: [evidence("proof-construction", "primary"), evidence("strategic-simplification", "primary"), evidence("transfer", "supporting"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "flow-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["graph-theory"], contentConcepts: ["degree-structure", "paths-cycles-connectivity"], skillEvidence: [evidence("proof-construction", "supporting")], milestones: [{ milestoneId: "find-cycle-in-balanced-graph", skillEvidence: [evidence("proof-construction", "supporting")], contentConcepts: ["degree-structure", "paths-cycles-connectivity"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening" },
      { id: "flow-core", role: "core", prerequisiteStageIds: ["flow-opening"], domains: ["graph-theory"], contentConcepts: ["degree-structure", "paths-cycles-connectivity"], skillEvidence: [evidence("strategic-simplification", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "prove-cycle-decomposition", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["degree-structure", "paths-cycles-connectivity"] },
        { milestoneId: "add-artificial-return-edge", skillEvidence: [evidence("strategic-simplification", "primary")], contentConcepts: ["degree-structure"] },
        { milestoneId: "extract-s-to-t-path", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["paths-cycles-connectivity"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "flow-transfer", role: "transfer", prerequisiteStageIds: ["flow-core"], domains: ["graph-theory"], contentConcepts: ["degree-structure", "paths-cycles-connectivity"], skillEvidence: [evidence("transfer", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "generalize-r-unit-imbalance", skillEvidence: [evidence("transfer", "primary")], contentConcepts: ["degree-structure", "paths-cycles-connectivity"] }], extensionIds: ["r-path-decomposition", "many-sources-sinks"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDDirectedFlowDecompositionEntry = authorCuratedProblem(oxfordDDirectedFlowDecompositionSpec);

export const dirichletBatchCEntries = Object.freeze([
  oxfordDDiscreteMaximumPrincipleEntry,
  oxfordDFiniteMapCyclesEntry,
  oxfordDOddSymmetricDifferenceEntry,
  oxfordDSpanningTreeExchangeEntry,
  oxfordDStableBinaryWordsEntry,
  oxfordDDirectedFlowDecompositionEntry
] as const);
