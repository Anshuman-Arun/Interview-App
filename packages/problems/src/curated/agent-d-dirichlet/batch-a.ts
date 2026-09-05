import { authorCuratedProblem, type CuratedProblemSpec } from "../../curated-authoring.js";
import { DIRICHLET_CANDIDATE_REVIEW_NOTES, evidence, makeDirichletAdaptive } from "./support.js";

export const oxfordDGcdDescentNetworkSpec: CuratedProblemSpec = {
  id: "oxford-d-gcd-descent-network",
  title: "Euclidean Descent on a Network",
  mode: "OXFORD_MATHEMATICS",
  category: "number theory",
  topics: ["divisibility", "graph theory", "invariants"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Take any finite connected graph and put a positive integer at every vertex. A legal move chooses an edge whose endpoint labels are x>y and replaces the larger label x by x-y, leaving every other label unchanged. If legal moves are repeated whenever possible, prove that the process must stop, describe every possible terminal position, and determine the terminal label from the starting labels.",
  givenInformation: ["The graph is finite and connected.", "All vertex labels are positive integers.", "At each move only the larger endpoint label changes."],
  approaches: [{ id: "monovariant-gcd", label: "Combine a decreasing quantity with a preserved gcd" }],
  milestones: [
    { id: "test-small-networks", description: "Explore paths or triangles and notice both descent and Euclidean-algorithm behavior.", approachIds: ["monovariant-gcd"], hintLevels: [1] },
    { id: "find-decreasing-sum", description: "Show the sum of all vertex labels is a positive integer that strictly decreases after every legal move.", approachIds: ["monovariant-gcd"], prerequisiteIds: ["test-small-networks"], hintLevels: [2] },
    { id: "prove-gcd-invariant", description: "Show replacing x by x-y preserves the gcd of the entire collection of labels.", approachIds: ["monovariant-gcd"], prerequisiteIds: ["find-decreasing-sum"], hintLevels: [3] },
    { id: "classify-terminal-state", description: "Use the absence of legal moves and connectedness to prove every terminal labeling is constant.", approachIds: ["monovariant-gcd"], prerequisiteIds: ["prove-gcd-invariant"], hintLevels: [4] },
    { id: "identify-terminal-gcd", description: "Combine constancy with gcd invariance to identify the common terminal value as the original gcd.", approachIds: ["monovariant-gcd"], prerequisiteIds: ["classify-terminal-state"], hintLevels: [5] }
  ],
  edges: [
    { from: "test-small-networks", to: "find-decreasing-sum" },
    { from: "find-decreasing-sum", to: "prove-gcd-invariant" },
    { from: "prove-gcd-invariant", to: "classify-terminal-state" },
    { from: "classify-terminal-state", to: "identify-terminal-gcd" }
  ],
  commonErrors: [
    { id: "gcd-with-only-edge", description: "Checks the gcd of just the chosen edge instead of the gcd of all labels, leaving a gap in the invariant argument." },
    { id: "forgets-connectivity", description: "Concludes all terminal labels are equal without using connectedness; disconnected components can terminate at different constants." },
    { id: "claims-value-decreases", description: "Assumes the largest label always decreases globally; another vertex may remain larger, so the total sum is the clean monovariant." }
  ],
  followUps: ["What changes if the graph is disconnected?", "Can different legal-move choices change the number of moves even though the final labels are forced?"],
  extensions: [
    { id: "componentwise-terminal", prompt: "Drop connectedness. Characterize the terminal label on each connected component." },
    { id: "choice-dependent-duration", prompt: "Find one starting graph and labeling for which two legal move sequences have different lengths." }
  ],
  hints: [
    { level: 1, text: "Try the rule on two vertices first, then on a three-vertex path. Which familiar arithmetic process appears on an edge?", formulations: ["compare with repeated subtraction", "start with a small path"] },
    { level: 2, text: "Look for a positive integer quantity that drops after every move; the sum of all labels changes by exactly -y.", formulations: ["track the total sum", "the sum strictly decreases"] },
    { level: 3, text: "For any integers x and y, gcd(x,y)=gcd(x-y,y). Apply that observation while keeping the untouched vertex labels in the gcd.", formulations: ["the global gcd is invariant", "subtracting one label preserves common divisors"] },
    { level: 4, text: "At a terminal position, the two labels on every edge must be equal. Connectedness then propagates one value through the graph.", formulations: ["terminal edges have equal endpoints", "connected terminal labeling is constant"] },
    { level: 5, text: "If every terminal vertex has label c, the gcd of all terminal labels is c; invariance therefore forces c to be the starting gcd.", formulations: ["the final constant equals the invariant gcd", "terminal label is the original gcd"] }
  ],
  canonicalSolution: "Let S be the sum of all vertex labels. A legal move replaces x>y by x-y, so S decreases by y, a positive integer. Hence no infinite sequence of moves is possible. The gcd g of all vertex labels is invariant: replacing x by x-y does not change the set of common divisors of x and y, and all other labels are untouched. When the process stops, no edge can have unequal endpoint labels, because the larger endpoint would admit a legal subtraction. Thus every edge has equal labels at its ends. Since the graph is connected, all vertices have one common label c. The gcd of a constant list c,c,...,c is c, so invariance gives c=g, the gcd of the starting labels. Therefore every legal sequence terminates at the constant labeling by the original gcd, although the number of moves can depend on choices.",
  verificationNotes: "Check positivity: x>y implies x-y>=1. Termination uses an integer-valued monovariant bounded below. Gcd invariance is global, not merely edge-local. Connectedness is essential only for forcing one terminal constant; on a disconnected graph the argument applies componentwise. No uniqueness of the move sequence is claimed.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-gcd-descent-network",
    domains: ["number-theory", "graph-theory"],
    contentConcepts: ["divisibility", "paths-cycles-connectivity"],
    prerequisiteConcepts: ["arithmetic", "divisibility", "graph-basics"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("invariants", "primary"), evidence("proof-construction", "primary"), evidence("precision-checking", "supporting"), evidence("generalization", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "standard" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      {
        id: "network-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["number-theory", "graph-theory"], contentConcepts: ["divisibility", "paths-cycles-connectivity"],
        skillEvidence: [evidence("small-case-exploration", "primary")],
        milestones: [{ milestoneId: "test-small-networks", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["divisibility"] }],
        extensionIds: [], difficulty: "introductory"
      },
      {
        id: "network-core", role: "core", prerequisiteStageIds: ["network-opening"], domains: ["number-theory", "graph-theory"], contentConcepts: ["divisibility", "paths-cycles-connectivity"],
        skillEvidence: [evidence("invariants", "primary"), evidence("proof-construction", "primary")],
        milestones: [
          { milestoneId: "find-decreasing-sum", skillEvidence: [evidence("invariants", "primary")], contentConcepts: [] },
          { milestoneId: "prove-gcd-invariant", skillEvidence: [evidence("invariants", "primary"), evidence("proof-construction", "supporting")], contentConcepts: ["divisibility"] },
          { milestoneId: "classify-terminal-state", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["paths-cycles-connectivity"] }
        ],
        extensionIds: [], difficulty: "standard"
      },
      {
        id: "network-transfer", role: "transfer", prerequisiteStageIds: ["network-core"], domains: ["number-theory", "graph-theory"], contentConcepts: ["divisibility", "paths-cycles-connectivity"],
        skillEvidence: [evidence("precision-checking", "primary"), evidence("generalization", "supporting")],
        milestones: [{ milestoneId: "identify-terminal-gcd", skillEvidence: [evidence("precision-checking", "primary")], contentConcepts: ["divisibility"] }],
        extensionIds: ["componentwise-terminal", "choice-dependent-duration"], difficulty: "standard"
      }
    ]
  })
};
export const oxfordDGcdDescentNetworkEntry = authorCuratedProblem(oxfordDGcdDescentNetworkSpec);

export const oxfordDThirdsClosedIntegersSpec: CuratedProblemSpec = {
  id: "oxford-d-thirds-closed-integers",
  title: "A Finite Set Closed Under Integer Trisection",
  mode: "OXFORD_MATHEMATICS",
  category: "number theory",
  topics: ["modular arithmetic", "case analysis", "classification"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Call a finite nonempty set S of integers thirds-closed if, whenever x and y in S satisfy x≡y (mod 3), both trisection points (2x+y)/3 and (x+2y)/3 also belong to S. Classify all thirds-closed sets. Pay particular attention to what changes between sets of size at most three and sets of size at least four.",
  givenInformation: ["If x≡y (mod 3), both displayed trisection points are integers.", "The two trisection points lie strictly between distinct x<y."],
  approaches: [{ id: "ordered-residue-trisection", label: "Order the set, constrain residue patterns, then force equal gaps" }],
  milestones: [
    { id: "classify-tiny-sizes", description: "Test one-, two-, and three-element sets and determine which residue repetitions are impossible.", approachIds: ["ordered-residue-trisection"], hintLevels: [1] },
    { id: "forbid-nearby-residue-repeat", description: "In an ordered set with at least four elements, show entries one or two places apart cannot have the same residue modulo 3.", approachIds: ["ordered-residue-trisection"], prerequisiteIds: ["classify-tiny-sizes"], hintLevels: [2] },
    { id: "force-three-residue-cycle", description: "Deduce that consecutive residues cycle through all three classes, so every fourth entry has the same residue as the first.", approachIds: ["ordered-residue-trisection"], prerequisiteIds: ["forbid-nearby-residue-repeat"], hintLevels: [3] },
    { id: "force-equal-gaps", description: "Apply the closure rule to four consecutive ordered elements and show the two interior elements must be the exact trisection points.", approachIds: ["ordered-residue-trisection"], prerequisiteIds: ["force-three-residue-cycle"], hintLevels: [4] },
    { id: "prove-classification-converse", description: "Prove every arithmetic progression with common difference not divisible by 3 is thirds-closed and state the small-size exceptions exactly.", approachIds: ["ordered-residue-trisection"], prerequisiteIds: ["force-equal-gaps"], hintLevels: [5] }
  ],
  edges: [
    { from: "classify-tiny-sizes", to: "forbid-nearby-residue-repeat" },
    { from: "forbid-nearby-residue-repeat", to: "force-three-residue-cycle" },
    { from: "force-three-residue-cycle", to: "force-equal-gaps" },
    { from: "force-equal-gaps", to: "prove-classification-converse" }
  ],
  commonErrors: [
    { id: "misses-small-exceptions", description: "States only the arithmetic-progression classification and overlooks valid sets of size one, two, or three." },
    { id: "only-one-trisection-point", description: "Uses the existence of one interior point but forgets the rule requires both distinct trisection points for distinct congruent endpoints." },
    { id: "residue-cycle-without-order", description: "Claims residues must repeat 0,1,2 without first ruling out congruent entries separated by fewer than three ordered positions." }
  ],
  followUps: ["What are the exact conditions for sizes 1, 2, and 3?", "What analogue would you conjecture if thirds were replaced by q equal parts for a prime q?"],
  extensions: [
    { id: "small-size-boundary", prompt: "Give a complete if-and-only-if description of thirds-closed sets of sizes one, two, and three." },
    { id: "q-section-conjecture", prompt: "Replace 3 by a prime q: if congruent endpoints force all q-1 internal q-section points, what pattern do you conjecture once the set is large enough?" }
  ],
  hints: [
    { level: 1, text: "Sort the set. If two distinct elements with the same residue mod 3 are too close in the sorted order, where could their two required trisection points go?", formulations: ["order the set first", "congruent endpoints need two interior members"] },
    { level: 2, text: "Two entries one or two places apart cannot be congruent mod 3, because there are fewer than two set elements strictly between them.", formulations: ["nearby residues must differ", "no residue repeat within two ordered steps"] },
    { level: 3, text: "Therefore every three consecutive residues are all different; overlapping triples force r_{i+3}=r_i.", formulations: ["residues cycle with period three", "every fourth ordered element has the first residue"] },
    { level: 4, text: "For four consecutive elements a_i<a_{i+1}<a_{i+2}<a_{i+3}, the endpoints are congruent. Their two trisection points must be exactly the only two interior set elements.", formulations: ["four consecutive terms are equally spaced", "the interior pair must be the trisection pair"] },
    { level: 5, text: "Overlapping blocks of four force one common gap d, and d is not divisible by 3. Conversely, equal spacing by such a d makes congruent terms occur exactly at index distances divisible by 3, so the trisection indices stay in the progression.", formulations: ["an arithmetic progression with 3 not dividing d works", "finish both necessity and converse"] }
  ],
  canonicalSolution: "Write S={a_1<...<a_m}. If two distinct elements with the same residue mod 3 occur with fewer than two elements of S between them, the two distinct trisection points required by the rule cannot both lie in S. Thus for m>=3, any three consecutive residues are distinct whenever such a triple exists. In particular, for m>=4, overlapping triples imply a_{i+3}≡a_i (mod 3). Apply the closure rule to the four consecutive values a_i<a_{i+1}<a_{i+2}<a_{i+3}. The endpoints are congruent, and the only two elements of S strictly between them are a_{i+1},a_{i+2}; hence these must be the two trisection points. Therefore a_{i+1}-a_i=a_{i+2}-a_{i+1}=a_{i+3}-a_{i+2}. Overlapping four-term blocks force all adjacent gaps to be one common d, and d is not divisible by 3 because adjacent residues differ. Conversely, if S is a finite arithmetic progression with common difference d not divisible by 3, two terms are congruent mod 3 exactly when their index difference is a multiple of 3; the one-third and two-thirds index positions are then integers lying between them, so both trisection points belong to S. For m=1 every singleton works. For m=2 the two residues must be distinct, and that condition is sufficient. For m=3 all three residues must be distinct, and that condition is sufficient. Thus these are exactly the small exceptions, while every thirds-closed set of size at least four is an arithmetic progression with step not divisible by 3.",
  verificationNotes: "The small-cardinality cases are essential. For distinct congruent endpoints the two trisection points are distinct and strictly interior. The ordered-residue argument yields r_{i+3}=r_i only once there are overlapping triples. The converse uses that d is invertible modulo 3, so congruent terms have index difference divisible by 3.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-thirds-closed-integers",
    similarityClusterId: "closure-classification-residue-affine",
    domains: ["number-theory", "logic-proof"],
    contentConcepts: ["modular-reasoning", "logical-structure"],
    prerequisiteConcepts: ["arithmetic", "modular-arithmetic", "logical-quantifiers"],
    skillEvidence: [evidence("small-case-exploration", "primary"), evidence("case-analysis", "primary"), evidence("pattern-recognition", "supporting"), evidence("proof-construction", "primary"), evidence("generalization", "supporting"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "strong" },
    novelty: "high",
    abstraction: "moderate",
    introducesNewDefinition: true,
    stages: [
      { id: "thirds-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["number-theory", "logic-proof"], contentConcepts: ["modular-reasoning", "logical-structure"], skillEvidence: [evidence("small-case-exploration", "primary"), evidence("case-analysis", "supporting")], milestones: [{ milestoneId: "classify-tiny-sizes", skillEvidence: [evidence("small-case-exploration", "primary"), evidence("case-analysis", "supporting")], contentConcepts: ["modular-reasoning"] }], extensionIds: [], difficulty: "introductory-plus", introducesNewDefinition: true },
      { id: "thirds-core", role: "core", prerequisiteStageIds: ["thirds-opening"], domains: ["number-theory", "logic-proof"], contentConcepts: ["modular-reasoning", "logical-structure"], skillEvidence: [evidence("pattern-recognition", "primary"), evidence("proof-construction", "primary"), evidence("case-analysis", "supporting")], milestones: [
        { milestoneId: "forbid-nearby-residue-repeat", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "force-three-residue-cycle", skillEvidence: [evidence("pattern-recognition", "primary")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "force-equal-gaps", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["logical-structure"] }
      ], extensionIds: [], difficulty: "strong" },
      { id: "thirds-transfer", role: "transfer", prerequisiteStageIds: ["thirds-core"], domains: ["number-theory", "logic-proof"], contentConcepts: ["modular-reasoning", "logical-structure"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "prove-classification-converse", skillEvidence: [evidence("precision-checking", "primary"), evidence("generalization", "supporting")], contentConcepts: ["logical-structure", "modular-reasoning"] }], extensionIds: ["small-size-boundary", "q-section-conjecture"], difficulty: "strong" }
    ]
  })
};
export const oxfordDThirdsClosedIntegersEntry = authorCuratedProblem(oxfordDThirdsClosedIntegersSpec);

export const oxfordDBalancingTransfersSpec: CuratedProblemSpec = {
  id: "oxford-d-balancing-transfers",
  title: "Balancing Counters One Transfer at a Time",
  mode: "OXFORD_MATHEMATICS",
  category: "combinatorics",
  topics: ["invariants", "extremal reasoning", "counterexamples"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "There are n>=2 boxes containing nonnegative integer numbers of counters. A legal move chooses two boxes with counts a>=b+2 and transfers one counter from the fuller box to the emptier one. Prove that every sequence of legal moves stops. Show that, although the choices of moves may differ, the multiset of counts in every terminal position is determined solely by the total number of counters.",
  givenInformation: ["A move changes (a,b) to (a-1,b+1).", "Any pair of boxes may be chosen when its counts differ by at least 2."],
  approaches: [{ id: "convex-monovariant", label: "Use sum as an invariant and sum of squares as a strict monovariant" }],
  milestones: [
    { id: "experiment-balancing", description: "Test small configurations and conjecture that terminal counts differ by at most one.", approachIds: ["convex-monovariant"], hintLevels: [1] },
    { id: "preserve-total", description: "Identify the total number of counters as an invariant.", approachIds: ["convex-monovariant"], prerequisiteIds: ["experiment-balancing"], hintLevels: [2] },
    { id: "decrease-squares", description: "Compute the change in the sum of squared box counts and prove it decreases by at least 2 on every move.", approachIds: ["convex-monovariant"], prerequisiteIds: ["preserve-total"], hintLevels: [3] },
    { id: "classify-terminal-multiset", description: "Show terminal positions have all counts differing by at most one and use Euclidean division of the total by n to determine the multiplicities.", approachIds: ["convex-monovariant"], prerequisiteIds: ["decrease-squares"], hintLevels: [4] },
    { id: "test-local-move-variant", description: "Restrict moves to adjacent boxes on a path and produce a counterexample to uniqueness of the terminal multiset.", approachIds: ["convex-monovariant"], prerequisiteIds: ["classify-terminal-multiset"], hintLevels: [5] }
  ],
  edges: [
    { from: "experiment-balancing", to: "preserve-total" },
    { from: "preserve-total", to: "decrease-squares" },
    { from: "decrease-squares", to: "classify-terminal-multiset" },
    { from: "classify-terminal-multiset", to: "test-local-move-variant" }
  ],
  commonErrors: [
    { id: "range-not-strict", description: "Tracks max-min without proving it strictly decreases on every move; it need not." },
    { id: "finite-state-only", description: "Says there are finitely many configurations but does not rule out cycles; a strict monovariant is still needed." },
    { id: "overgeneralizes-local-version", description: "Assumes the unique terminal multiset remains true when only adjacent transfers are allowed." }
  ],
  followUps: ["Can two move sequences have different lengths?", "What survives if legal moves are allowed only between adjacent boxes in a path?"],
  extensions: [
    { id: "path-local-counterexample", prompt: "For adjacent-only moves on three boxes, analyze the start (0,4,2) and show two different terminal multisets are possible." },
    { id: "graph-local-termination", prompt: "Allow transfers only along edges of a fixed graph. Which parts of the termination proof survive, and what replaces the global terminal classification?" }
  ],
  hints: [
    { level: 1, text: "The total stays fixed, but that alone cannot prove termination. Try a quantity that penalizes unevenness more strongly.", formulations: ["look at squares", "seek a strict measure of imbalance"] },
    { level: 2, text: "A transfer changes a+b by 0, so the total number of counters is invariant.", formulations: ["the sum is fixed", "preserve total mass"] },
    { level: 3, text: "For a>=b+2, compare (a-1)^2+(b+1)^2 with a^2+b^2; the change is -2(a-b)+2<=-2.", formulations: ["sum of squares strictly decreases", "compute the quadratic change"] },
    { level: 4, text: "No legal move remains exactly when max-min<=1. If the total is qn+r with 0<=r<n, how many boxes must contain q+1?", formulations: ["terminal counts are q and q+1", "use division with remainder"] },
    { level: 5, text: "For the adjacent-only variant, (0,4,2) can transfer left twice to reach (2,2,2), or transfer right and then left to reach (1,2,3).", formulations: ["local restriction destroys terminal uniqueness", "use the start 0,3,1"] }
  ],
  canonicalSolution: "The total T of all counts is invariant. Let Q be the sum of the squares of the counts. If a>=b+2 and one counter moves from a to b, then Q changes by (a-1)^2+(b+1)^2-a^2-b^2=-2(a-b)+2<=-2. Thus Q is a nonnegative integer that strictly decreases, so every move sequence terminates. A position is terminal exactly when no pair differs by 2 or more, equivalently all counts differ by at most 1. Write T=qn+r with 0<=r<n. Any n nonnegative integers with total T and pairwise differences at most 1 must consist of n-r copies of q and r copies of q+1. Hence the terminal multiset is uniquely determined by T and n. The unrestricted-pair hypothesis matters: with adjacent-only moves on a three-box path, (0,4,2) may move twice on the left edge, (0,4,2)->(1,3,2)->(2,2,2), which is terminal, or first move on the right edge and then on the left, (0,4,2)->(0,3,3)->(1,2,3), which is also terminal. The terminal multisets {2,2,2} and {1,2,3} differ.",
  verificationNotes: "The sum-of-squares change is at most -2 because a-b>=2. Nonnegativity and integrality of Q prove termination. Terminal uniqueness is only as a multiset; box identities can differ. The adjacent-only extension deliberately fails uniqueness: from (0,4,2), the terminal multisets {2,2,2} and {1,2,3} are both reachable.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-balancing-transfers",
    domains: ["combinatorics", "algebra"],
    contentConcepts: ["extremal-configuration", "inequalities-bounds"],
    prerequisiteConcepts: ["arithmetic", "algebraic-manipulation"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("invariants", "primary"), evidence("proof-construction", "primary"), evidence("counterexample-construction", "primary"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "low",
    introducesNewDefinition: false,
    stages: [
      { id: "balancing-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["combinatorics", "algebra"], contentConcepts: ["extremal-configuration", "inequalities-bounds"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "experiment-balancing", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["extremal-configuration"] }], extensionIds: [], difficulty: "introductory" },
      { id: "balancing-core", role: "core", prerequisiteStageIds: ["balancing-opening"], domains: ["combinatorics", "algebra"], contentConcepts: ["extremal-configuration", "inequalities-bounds"], skillEvidence: [evidence("invariants", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "preserve-total", skillEvidence: [evidence("invariants", "supporting")], contentConcepts: [] },
        { milestoneId: "decrease-squares", skillEvidence: [evidence("invariants", "primary"), evidence("proof-construction", "supporting")], contentConcepts: ["inequalities-bounds"] },
        { milestoneId: "classify-terminal-multiset", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["extremal-configuration"] }
      ], extensionIds: [], difficulty: "standard" },
      { id: "balancing-transfer", role: "transfer", prerequisiteStageIds: ["balancing-core"], domains: ["combinatorics", "algebra"], contentConcepts: ["extremal-configuration", "inequalities-bounds"], skillEvidence: [evidence("counterexample-construction", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "test-local-move-variant", skillEvidence: [evidence("counterexample-construction", "primary")], contentConcepts: ["extremal-configuration"] }], extensionIds: ["path-local-counterexample", "graph-local-termination"], difficulty: "strong"
      }
    ]
  })
};
export const oxfordDBalancingTransfersEntry = authorCuratedProblem(oxfordDBalancingTransfersSpec);

export const oxfordDCubeTwistEquivalenceSpec: CuratedProblemSpec = {
  id: "oxford-d-cube-twist-equivalence",
  title: "An Asymmetric-Looking Cube Relation",
  mode: "OXFORD_MATHEMATICS",
  category: "number theory",
  topics: ["prime factorization", "equivalence relations", "perfect powers"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "For positive integers a and b, define a relation a~b by saying that ab^2 is a perfect cube. The definition looks asymmetric. Determine whether ~ is actually an equivalence relation, characterize its equivalence classes as concretely as possible, and then look for the correct r-th-power analogue.",
  givenInformation: ["You may use unique prime factorization.", "A positive integer is a perfect cube exactly when every prime exponent in its factorization is divisible by 3."],
  approaches: [{ id: "exponent-residue-vectors", label: "Translate perfect-power conditions into congruences on prime exponents" }],
  milestones: [
    { id: "test-relation-examples", description: "Check reflexivity and small examples, noticing that symmetry is not obvious from the surface formula.", approachIds: ["exponent-residue-vectors"], hintLevels: [1] },
    { id: "translate-prime-exponents", description: "For each prime p, translate ab^2 being a cube into e_p(a)+2e_p(b)≡0 mod 3.", approachIds: ["exponent-residue-vectors"], prerequisiteIds: ["test-relation-examples"], hintLevels: [2] },
    { id: "discover-equal-residue-vectors", description: "Simplify the congruence to e_p(a)≡e_p(b) mod 3 for every prime.", approachIds: ["exponent-residue-vectors"], prerequisiteIds: ["translate-prime-exponents"], hintLevels: [3] },
    { id: "prove-equivalence-and-classes", description: "Use exponent-residue equality to prove reflexive, symmetric, and transitive behavior and identify classes by cube-free kernels.", approachIds: ["exponent-residue-vectors"], prerequisiteIds: ["discover-equal-residue-vectors"], hintLevels: [4] },
    { id: "generalize-rth-power", description: "Show that a~_r b defined by a b^{r-1} being an r-th power compares prime exponents modulo r.", approachIds: ["exponent-residue-vectors"], prerequisiteIds: ["prove-equivalence-and-classes"], hintLevels: [5] }
  ],
  edges: [
    { from: "test-relation-examples", to: "translate-prime-exponents" },
    { from: "translate-prime-exponents", to: "discover-equal-residue-vectors" },
    { from: "discover-equal-residue-vectors", to: "prove-equivalence-and-classes" },
    { from: "prove-equivalence-and-classes", to: "generalize-rth-power" }
  ],
  commonErrors: [
    { id: "assumes-symmetry-from-notation", description: "Treats ~ as symmetric merely because a symmetric-looking relation symbol was used." },
    { id: "squarefree-instead-cubefree", description: "Reduces exponents only modulo 2; cube classes require exponent residues modulo 3." },
    { id: "forgets-all-primes", description: "Checks the exponent congruence for primes dividing only one displayed example rather than stating it uniformly for every prime." }
  ],
  followUps: ["Which positive integers are equivalent to 1?", "What changes if the exponent 2 on b is replaced by 1?"],
  extensions: [
    { id: "identity-class", prompt: "Characterize the equivalence class of 1 and explain why it is exactly the perfect cubes." },
    { id: "rth-power-relation", prompt: "For r>=2, define a~_r b when a b^{r-1} is a perfect r-th power. Prove the analogue and describe the class invariant." }
  ],
  hints: [
    { level: 1, text: "Do not try to prove symmetry directly from ab^2. Write a and b using prime exponents and ask what a cube means prime by prime.", formulations: ["move to prime exponents", "test the definition valuation by valuation"] },
    { level: 2, text: "For each prime p, the condition is e_p(a)+2e_p(b)≡0 (mod 3).", formulations: ["cube means exponent sum divisible by three", "write exponent congruences"] },
    { level: 3, text: "Because 2≡-1 (mod 3), the condition is equivalent to e_p(a)≡e_p(b) (mod 3).", formulations: ["the asymmetry disappears modulo three", "prime exponent residues must match"] },
    { level: 4, text: "Remove all cube factors from an integer. The remaining cubefree exponent pattern 0,1,2 is exactly the invariant labeling an equivalence class.", formulations: ["same cubefree kernel", "classify by exponent residues modulo three"] },
    { level: 5, text: "For r-th powers, e_p(a)+(r-1)e_p(b)≡e_p(a)-e_p(b) (mod r), so the same argument works modulo r.", formulations: ["replace three by r", "a b^{r-1} compares exponents mod r"] }
  ],
  canonicalSolution: "Write e_p(n) for the exponent of a prime p in n. The condition that ab^2 is a perfect cube is e_p(a)+2e_p(b)≡0 mod 3 for every p. Since 2≡-1 mod 3, this is exactly e_p(a)≡e_p(b) mod 3 for every p. Equality of these residue vectors is plainly reflexive, symmetric, and transitive, so the original relation is an equivalence relation despite its asymmetric surface form. Every positive integer n can be written uniquely as c t^3 where c has prime exponents only 0,1,2; call c its cubefree kernel. Two integers are related exactly when they have the same cubefree kernel. In particular the class of 1 is the set of perfect cubes. More generally, for r>=2, a b^{r-1} is a perfect r-th power iff e_p(a)+(r-1)e_p(b)≡e_p(a)-e_p(b)≡0 mod r for every p, so the r-th-power analogue is again equality of prime-exponent residue vectors modulo r.",
  verificationNotes: "Unique prime factorization is an explicit prerequisite. The cubefree kernel here retains exponents 0,1,2 modulo 3; it is not the squarefree kernel. The r-th-power generalization is valid for every integer r>=2 because r-1≡-1 mod r. The relation with ab instead of ab^2 is not reflexive in general, which is a useful boundary check.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-cube-twist-equivalence",
    domains: ["number-theory", "set-theory", "logic-proof"],
    contentConcepts: ["prime-structure", "divisibility", "relations-operations", "logical-structure"],
    prerequisiteConcepts: ["prime-factorization", "divisibility", "modular-arithmetic", "logical-quantifiers"],
    skillEvidence: [evidence("definition-exploration", "primary"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("generalization", "supporting"), evidence("pattern-recognition", "supporting"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: true,
    stages: [
      { id: "cube-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["number-theory", "set-theory", "logic-proof"], contentConcepts: ["prime-structure", "relations-operations", "logical-structure"], skillEvidence: [evidence("definition-exploration", "primary")], milestones: [{ milestoneId: "test-relation-examples", skillEvidence: [evidence("definition-exploration", "primary")], contentConcepts: ["relations-operations"] }], extensionIds: [], difficulty: "introductory-plus", introducesNewDefinition: true },
      { id: "cube-core", role: "core", prerequisiteStageIds: ["cube-opening"], domains: ["number-theory", "set-theory", "logic-proof"], contentConcepts: ["prime-structure", "divisibility", "relations-operations", "logical-structure"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("pattern-recognition", "supporting")], milestones: [
        { milestoneId: "translate-prime-exponents", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["prime-structure"] },
        { milestoneId: "discover-equal-residue-vectors", skillEvidence: [evidence("pattern-recognition", "primary")], contentConcepts: ["divisibility"] },
        { milestoneId: "prove-equivalence-and-classes", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["relations-operations", "logical-structure"] }
      ], extensionIds: [], difficulty: "standard" },
      { id: "cube-transfer", role: "transfer", prerequisiteStageIds: ["cube-core"], domains: ["number-theory", "set-theory", "logic-proof"], contentConcepts: ["prime-structure", "divisibility", "relations-operations", "logical-structure"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "generalize-rth-power", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["prime-structure", "relations-operations"] }], extensionIds: ["identity-class", "rth-power-relation"], difficulty: "strong"
      }
    ]
  })
};
export const oxfordDCubeTwistEquivalenceEntry = authorCuratedProblem(oxfordDCubeTwistEquivalenceSpec);

export const dirichletBatchAEntries = Object.freeze([
  oxfordDGcdDescentNetworkEntry,
  oxfordDThirdsClosedIntegersEntry,
  oxfordDBalancingTransfersEntry,
  oxfordDCubeTwistEquivalenceEntry
] as const);
