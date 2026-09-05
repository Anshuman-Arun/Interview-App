import { authorCuratedProblem, type CuratedProblemSpec } from "../../curated-authoring.js";
import { DIRICHLET_CANDIDATE_REVIEW_NOTES, evidence, makeDirichletAdaptive } from "./support.js";

export const oxfordDPrimeDivisorThreeCyclesSpec: CuratedProblemSpec = {
  id: "oxford-d-prime-divisor-three-cycles",
  title: "Prime Divisors Seen Through Multiplication Cycles",
  mode: "OXFORD_MATHEMATICS",
  category: "number theory",
  topics: ["modular arithmetic", "prime divisors", "orbits"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let p be a prime other than 3, and suppose p divides n^2+n+1 for some integer n. Determine what this forces about p modulo 3. Give a proof by studying what repeated multiplication by n does to the nonzero residue classes modulo p, rather than quoting a theorem about multiplicative orders.",
  givenInformation: ["p is prime and p!=3.", "You may use that multiplication by a nonzero residue modulo p permutes the nonzero residue classes."],
  approaches: [{ id: "multiplication-orbits", label: "Turn the polynomial congruence into fixed-length orbits on nonzero residues" }],
  milestones: [
    { id: "derive-cubic-congruence", description: "Use (n-1)(n^2+n+1)=n^3-1 to prove n^3≡1 mod p.", approachIds: ["multiplication-orbits"], hintLevels: [1] },
    { id: "exclude-short-period", description: "Use p!=3 to exclude n≡1 mod p and then exclude periods one and two for multiplication by n.", approachIds: ["multiplication-orbits"], prerequisiteIds: ["derive-cubic-congruence"], hintLevels: [2] },
    { id: "build-three-cycles", description: "Consider x,nx,n^2x for every nonzero residue x and prove these form disjoint three-cycles.", approachIds: ["multiplication-orbits"], prerequisiteIds: ["exclude-short-period"], hintLevels: [3] },
    { id: "count-residue-orbits", description: "Partition the p-1 nonzero residues into three-cycles and conclude 3 divides p-1.", approachIds: ["multiplication-orbits"], prerequisiteIds: ["build-three-cycles"], hintLevels: [4] },
    { id: "transfer-four-cycles", description: "Apply the same orbit idea to an odd prime divisor of n^2+1 and derive a congruence modulo 4.", approachIds: ["multiplication-orbits"], prerequisiteIds: ["count-residue-orbits"], hintLevels: [5] }
  ],
  edges: [
    { from: "derive-cubic-congruence", to: "exclude-short-period" },
    { from: "exclude-short-period", to: "build-three-cycles" },
    { from: "build-three-cycles", to: "count-residue-orbits" },
    { from: "count-residue-orbits", to: "transfer-four-cycles" }
  ],
  commonErrors: [
    { id: "forgets-p-three", description: "Concludes n is not 1 modulo p without isolating the exceptional prime p=3." },
    { id: "assumes-cycles-length-three", description: "Uses n^3≡1 to claim every orbit has length three without ruling out shorter periods." },
    { id: "quotes-group-order", description: "Invokes Lagrange or multiplicative-order machinery instead of explaining the elementary cycle partition requested by the family." }
  ],
  followUps: ["Why is p=3 the only exception to n not being 1 modulo p?", "What happens for an odd prime divisor of n^2+1?"],
  extensions: [
    { id: "four-cycle-transfer", prompt: "If an odd prime p divides n^2+1, use multiplication-by-n orbits to prove p≡1 (mod 4)." },
    { id: "geometric-sum-conjecture", prompt: "For 1+n+...+n^{q-1} with prime q, state the analogous conclusion you expect after excluding exceptional cases." }
  ],
  hints: [
    { level: 1, text: "Multiply n^2+n+1 by n-1. The product is n^3-1.", formulations: ["turn the quadratic into n cubed equals one", "use the geometric-series factorization"] },
    { level: 2, text: "If n≡1 mod p, then n^2+n+1≡3 mod p, forcing p=3. Also a period of two together with period three would force period one.", formulations: ["rule out shorter multiplication periods", "p not equal three excludes n equals one"] },
    { level: 3, text: "For nonzero x, examine x -> nx -> n^2x -> n^3x=x. The three displayed residues are distinct.", formulations: ["partition by multiplication orbits", "each nonzero residue sits in a three-cycle"] },
    { level: 4, text: "The p-1 nonzero residues are partitioned into blocks of size 3, so p-1 is divisible by 3.", formulations: ["count the three-cycles", "three divides p minus one"] },
    { level: 5, text: "For n^2≡-1 mod p with p odd, multiplication by n returns after four steps and cannot return after one or two; count four-cycles.", formulations: ["repeat with four-cycles", "derive p equals one mod four"] }
  ],
  canonicalSolution: "Since p divides n^2+n+1, the identity (n-1)(n^2+n+1)=n^3-1 gives n^3≡1 mod p. Also n is nonzero mod p. If n≡1 mod p, then n^2+n+1≡3 mod p, so p=3, contrary to the hypothesis. Thus multiplication by n is not the identity on nonzero residues. It cannot have period two either: n^2≡1 together with n^3≡1 would imply n≡1. Therefore, for every nonzero residue x, the three residues x,nx,n^2x are distinct and multiplication by n cycles through them. These cycles partition all p-1 nonzero residues, so 3 divides p-1 and p≡1 mod 3. For the extension, if odd p divides n^2+1, then n^2≡-1 and n^4≡1. The multiplication map has no period one or two because n^2 is not 1, so its nonzero residues split into four-cycles; hence 4 divides p-1.",
  verificationNotes: "The exception p=3 is essential: n≡1 mod 3 makes n^2+n+1 divisible by 3. For p!=3, n cannot be zero or one modulo p. The orbit proof avoids assuming group-order results but is mathematically equivalent to an order-3 argument. This family has a known theorem-level near-neighbor and is explicitly high-risk for Agent H.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-prime-divisor-three-cycles",
    domains: ["number-theory"],
    contentConcepts: ["modular-reasoning", "prime-structure", "divisibility"],
    prerequisiteConcepts: ["arithmetic", "divisibility", "modular-arithmetic"],
    skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("case-analysis", "supporting"), evidence("transfer", "supporting"), evidence("generalization", "supporting")],
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "stretch" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "prime-cycle-opening", role: "technique-check", prerequisiteStageIds: [], domains: ["number-theory"], contentConcepts: ["modular-reasoning", "divisibility"], skillEvidence: [evidence("proof-construction", "supporting")], milestones: [{ milestoneId: "derive-cubic-congruence", skillEvidence: [evidence("proof-construction", "supporting")], contentConcepts: ["divisibility", "modular-reasoning"] }], extensionIds: [], difficulty: "introductory-plus", timingKind: "opening" },
      { id: "prime-cycle-core", role: "core", prerequisiteStageIds: ["prime-cycle-opening"], domains: ["number-theory"], contentConcepts: ["modular-reasoning", "prime-structure"], skillEvidence: [evidence("case-analysis", "primary"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "exclude-short-period", skillEvidence: [evidence("case-analysis", "primary")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "build-three-cycles", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "count-residue-orbits", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["prime-structure"] }
      ], extensionIds: [], difficulty: "strong", timingKind: "core" },
      { id: "prime-cycle-transfer", role: "transfer", prerequisiteStageIds: ["prime-cycle-core"], domains: ["number-theory"], contentConcepts: ["modular-reasoning", "prime-structure"], skillEvidence: [evidence("transfer", "primary"), evidence("generalization", "supporting")], milestones: [{ milestoneId: "transfer-four-cycles", skillEvidence: [evidence("transfer", "primary")], contentConcepts: ["modular-reasoning", "prime-structure"] }], extensionIds: ["four-cycle-transfer", "geometric-sum-conjecture"], difficulty: "stretch", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDPrimeDivisorThreeCyclesEntry = authorCuratedProblem(oxfordDPrimeDivisorThreeCyclesSpec);

export const oxfordDSlidingWindowParitySpec: CuratedProblemSpec = {
  id: "oxford-d-sliding-window-parity",
  title: "Equal-Parity Windows Around a Circle",
  mode: "OXFORD_MATHEMATICS",
  category: "combinatorics",
  topics: ["parity", "cyclic sequences", "gcd"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Arrange n lamps in a circle, each either off or on. Fix 1<=k<=n. Suppose every block of k consecutive lamps contains the same parity of on lamps. Characterize all such configurations and count them.",
  givenInformation: ["Blocks wrap around cyclically.", "Only the parity of the number of on lamps in a block is assumed equal, not the exact number."],
  approaches: [{ id: "adjacent-window-cancellation", label: "Compare neighboring windows, then study step-k orbits on the cyclic positions" }],
  milestones: [
    { id: "compare-neighboring-windows", description: "Subtract the parity conditions for two consecutive k-windows and isolate the entering and leaving lamps.", approachIds: ["adjacent-window-cancellation"], hintLevels: [1] },
    { id: "derive-step-k-equality", description: "Prove every valid configuration satisfies x_i=x_{i+k} modulo cyclic indexing.", approachIds: ["adjacent-window-cancellation"], prerequisiteIds: ["compare-neighboring-windows"], hintLevels: [2] },
    { id: "analyze-step-k-orbits", description: "Show step-k motion partitions the n positions into gcd(n,k) residue orbits.", approachIds: ["adjacent-window-cancellation"], prerequisiteIds: ["derive-step-k-equality"], hintLevels: [3] },
    { id: "count-and-prove-converse", description: "Choose one lamp state independently per orbit, count 2^{gcd(n,k)} configurations, and prove every such choice has equal window parity.", approachIds: ["adjacent-window-cancellation"], prerequisiteIds: ["analyze-step-k-orbits"], hintLevels: [4] },
    { id: "classify-odd-common-parity", description: "Determine when configurations with every k-window odd exist and how many there are.", approachIds: ["adjacent-window-cancellation"], prerequisiteIds: ["count-and-prove-converse"], hintLevels: [5] }
  ],
  edges: [
    { from: "compare-neighboring-windows", to: "derive-step-k-equality" },
    { from: "derive-step-k-equality", to: "analyze-step-k-orbits" },
    { from: "analyze-step-k-orbits", to: "count-and-prove-converse" },
    { from: "count-and-prove-converse", to: "classify-odd-common-parity" }
  ],
  commonErrors: [
    { id: "confuses-equal-with-parity", description: "Assumes all k-window sums are numerically equal, a stronger condition than the problem gives." },
    { id: "uses-k-residue-classes", description: "Claims there are k independent position classes; on a circle the number is gcd(n,k)." },
    { id: "necessity-no-converse", description: "Derives x_i=x_{i+k} but does not show this periodicity is sufficient for all window parities to match." }
  ],
  followUps: ["How does the answer simplify when gcd(n,k)=1?", "Among these configurations, when can the common parity be odd?"],
  extensions: [
    { id: "odd-window-count", prompt: "Let d=gcd(n,k). Determine when every k-window can have odd parity and count those configurations." },
    { id: "exact-window-sums", prompt: "Replace equal parity by equal exact numbers of on lamps. Which part of the same orbit argument survives?" }
  ],
  hints: [
    { level: 1, text: "Write the parity of the window starting at i and the one starting at i+1. All shared lamps cancel modulo 2.", formulations: ["compare adjacent windows", "cancel the overlap"] },
    { level: 2, text: "The only lamps that do not cancel are x_i and x_{i+k}, so equal window parity gives x_i=x_{i+k}.", formulations: ["leaving lamp equals entering lamp", "step k preserves the lamp state"] },
    { level: 3, text: "Repeatedly add k to an index modulo n. The number of resulting cycles is d=gcd(n,k).", formulations: ["study step-k orbits", "positions split into gcd classes"] },
    { level: 4, text: "A valid configuration is constant on each of those d orbits, giving 2^d choices. Conversely x_i=x_{i+k} makes every neighboring pair of window parities equal.", formulations: ["one bit per orbit", "prove the periodic condition is sufficient"] },
    { level: 5, text: "Each k-window contains k/d positions from each of the d orbit classes. Its parity is (k/d) times the xor-sum of the orbit bits.", formulations: ["reduce odd-window existence to k divided by d", "if k/d is even every window parity is even"] }
  ],
  canonicalSolution: "Let x_i in {0,1} be the state of lamp i, with indices modulo n, and let W_i be the sum modulo 2 of x_i,...,x_{i+k-1}. Since all W_i are equal, 0=W_{i+1}-W_i=x_{i+k}-x_i modulo 2, so x_{i+k}=x_i for every i. Thus lamp states are constant on the orbits generated by adding k modulo n. There are d=gcd(n,k) such orbits, so there are at most 2^d configurations. Conversely, any assignment of one bit to each step-k orbit satisfies x_{i+k}=x_i; therefore W_{i+1}=W_i for all i and all k-window parities are equal. Hence there are exactly 2^d configurations. For the odd-parity extension, every k-window contains exactly k/d representatives counted with multiplicity from each of the d orbit classes, so its parity is (k/d) times the xor of the d orbit bits. If k/d is even, every valid configuration has even windows and there are no odd-window configurations. If k/d is odd, exactly half of the 2^d orbit assignments have xor 1, giving 2^{d-1} odd-window configurations.",
  verificationNotes: "The statement includes k=n: then d=n and the condition is vacuous because every cyclic n-window is the whole circle, yielding 2^n configurations as the formula predicts. The orbit count is gcd(n,k), not k. The odd-parity extension correctly distinguishes the parity of k/d.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-sliding-window-parity",
    domains: ["combinatorics", "number-theory"],
    contentConcepts: ["parity", "modular-reasoning", "counting-structure"],
    prerequisiteConcepts: ["arithmetic", "modular-arithmetic", "counting-principles"],
    skillEvidence: [evidence("representation-switching", "primary"), evidence("pattern-recognition", "primary"), evidence("proof-construction", "primary"), evidence("generalization", "supporting"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "high",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "window-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["combinatorics", "number-theory"], contentConcepts: ["parity", "modular-reasoning"], skillEvidence: [evidence("representation-switching", "primary")], milestones: [{ milestoneId: "compare-neighboring-windows", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["parity"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening" },
      { id: "window-core", role: "core", prerequisiteStageIds: ["window-opening"], domains: ["combinatorics", "number-theory"], contentConcepts: ["parity", "modular-reasoning", "counting-structure"], skillEvidence: [evidence("pattern-recognition", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "derive-step-k-equality", skillEvidence: [evidence("proof-construction", "supporting")], contentConcepts: ["parity"] },
        { milestoneId: "analyze-step-k-orbits", skillEvidence: [evidence("pattern-recognition", "primary")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "count-and-prove-converse", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["counting-structure"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "window-transfer", role: "transfer", prerequisiteStageIds: ["window-core"], domains: ["combinatorics", "number-theory"], contentConcepts: ["parity", "modular-reasoning", "counting-structure"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "classify-odd-common-parity", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["parity", "counting-structure"] }], extensionIds: ["odd-window-count", "exact-window-sums"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDSlidingWindowParityEntry = authorCuratedProblem(oxfordDSlidingWindowParitySpec);

export const oxfordDWeightedCycleReadingsSpec: CuratedProblemSpec = {
  id: "oxford-d-weighted-cycle-readings",
  title: "Recovering Vertex Labels from Weighted Cycle Readings",
  mode: "OXFORD_MATHEMATICS",
  category: "graph theory",
  topics: ["cyclic equations", "parameter analysis", "case analysis"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Vertices of an n-cycle carry unknown real numbers x_1,...,x_n, and the edges are read clockwise. For a fixed nonzero real parameter t, edge i displays s_i=x_i+t x_{i+1}, with x_{n+1}=x_1. For which choices of n and t do the edge readings determine the vertex labels uniquely for every possible list of readings? Analyze what happens in the exceptional cases.",
  givenInformation: ["n>=3.", "t is a fixed nonzero real number.", "The cycle has a chosen clockwise direction only to define which endpoint receives coefficient t."],
  approaches: [{ id: "cycle-recurrence-closure", label: "Propagate one unknown around the cycle and inspect the closing coefficient" }],
  milestones: [
    { id: "solve-small-cycles", description: "Work through n=3 and n=4 for simple t values and notice parity-sensitive exceptional behavior.", approachIds: ["cycle-recurrence-closure"], hintLevels: [1] },
    { id: "derive-one-step-recurrence", description: "Rewrite each edge equation as x_{i+1}=(s_i-x_i)/t and track how the coefficient of x_1 changes.", approachIds: ["cycle-recurrence-closure"], prerequisiteIds: ["solve-small-cycles"], hintLevels: [2] },
    { id: "close-after-n-steps", description: "Show the closing equation has coefficient 1-(-1/t)^n on x_1.", approachIds: ["cycle-recurrence-closure"], prerequisiteIds: ["derive-one-step-recurrence"], hintLevels: [3] },
    { id: "classify-singular-parameters", description: "Over the reals, solve (-1/t)^n=1 and separate odd and even n.", approachIds: ["cycle-recurrence-closure"], prerequisiteIds: ["close-after-n-steps"], hintLevels: [4] },
    { id: "analyze-exception-consistency", description: "Describe consistency and one-parameter nonuniqueness for t=-1, and for t=1 when n is even.", approachIds: ["cycle-recurrence-closure"], prerequisiteIds: ["classify-singular-parameters"], hintLevels: [5] }
  ],
  edges: [
    { from: "solve-small-cycles", to: "derive-one-step-recurrence" },
    { from: "derive-one-step-recurrence", to: "close-after-n-steps" },
    { from: "close-after-n-steps", to: "classify-singular-parameters" },
    { from: "classify-singular-parameters", to: "analyze-exception-consistency" }
  ],
  commonErrors: [
    { id: "ordinary-sums-only", description: "Analyzes only t=1 and misses the parameter classification." },
    { id: "forgets-existence", description: "Calls a singular case merely nonunique without noting that inconsistent edge readings may have no solution." },
    { id: "complex-roots-over-real", description: "Introduces non-real roots of unity even though t is explicitly real." }
  ],
  followUps: ["Recover the familiar odd/even phenomenon for ordinary edge sums t=1.", "What does t=-1 mean geometrically in terms of edge differences?"],
  extensions: [
    { id: "ordinary-sum-specialization", prompt: "Set t=1. Derive the exact alternating-sum consistency condition for even n and explain why odd n is always uniquely solvable." },
    { id: "difference-specialization", prompt: "Set t=-1. Derive the consistency condition on the readings and explain the one-parameter translation freedom." }
  ],
  hints: [
    { level: 1, text: "Choose x_1 freely and use the first edge to compute x_2, then x_3, and so on. The only issue is whether the final value agrees with x_1.", formulations: ["propagate around the cycle", "reduce to one starting variable"] },
    { level: 2, text: "The recurrence is x_{i+1}=s_i/t-(1/t)x_i, so the coefficient multiplying x_1 is multiplied by -1/t at each step.", formulations: ["track just the x1 coefficient", "each step multiplies the free coefficient by minus one over t"] },
    { level: 3, text: "After n steps, x_{n+1}=(-1/t)^n x_1 plus a known expression in the s_i. Enforce x_{n+1}=x_1.", formulations: ["the closing coefficient is one minus a power", "cycle closure gives one scalar equation"] },
    { level: 4, text: "Uniqueness fails exactly when (-1/t)^n=1. For real t, an odd power equals 1 only at 1; an even power equals 1 at ±1.", formulations: ["solve the singular parameter equation over the reals", "odd and even n behave differently"] },
    { level: 5, text: "For t=-1 the readings are differences and must sum to 0. For t=1 with even n, the alternating sum s_1-s_2+...-s_n must be 0.", formulations: ["write the exceptional consistency conditions", "singular cases have a free additive parameter"] }
  ],
  canonicalSolution: "From s_i=x_i+t x_{i+1}, we have x_{i+1}=s_i/t-x_i/t. Starting from x_1 and iterating, x_{n+1}=(-1/t)^n x_1+C(s_1,...,s_n), where C is determined by the readings. The closure condition x_{n+1}=x_1 is [1-(-1/t)^n]x_1=C. If the coefficient is nonzero, this uniquely determines x_1 for every reading list, and then all other labels are uniquely recovered. Uniqueness for every reading list therefore fails exactly when (-1/t)^n=1. Over real nonzero t: if n is odd, this happens only for t=-1; if n is even, it happens for t=1 or t=-1. In a singular case the closing equation loses x_1, so either the readings violate one consistency relation and there is no solution, or the relation holds and x_1 is free, giving a one-parameter family. For t=-1, s_i=x_i-x_{i+1} and consistency is sum_i s_i=0. For t=1 with even n, consistency is s_1-s_2+s_3-...-s_n=0. Thus odd cycles are uniquely reconstructible for all real t except -1; even cycles are uniquely reconstructible for all real t except ±1.",
  verificationNotes: "The recurrence coefficient is (-1/t)^n; t=0 is excluded in the prompt. The classification is over real t, so there are no additional roots of unity. In singular cases existence depends on one linear relation and, when it holds, exactly one scalar degree of freedom remains.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-weighted-cycle-readings",
    domains: ["graph-theory", "algebra"],
    contentConcepts: ["paths-cycles-connectivity", "parameter-dependent-algebra"],
    prerequisiteConcepts: ["algebraic-manipulation", "equations-inequalities", "graph-basics"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("representation-switching", "primary"), evidence("case-analysis", "primary"), evidence("proof-construction", "primary"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    novelty: "high",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "weighted-cycle-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["graph-theory", "algebra"], contentConcepts: ["paths-cycles-connectivity", "parameter-dependent-algebra"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "solve-small-cycles", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["paths-cycles-connectivity"] }], extensionIds: [], difficulty: "introductory-plus", timingKind: "opening" },
      { id: "weighted-cycle-core", role: "core", prerequisiteStageIds: ["weighted-cycle-opening"], domains: ["graph-theory", "algebra"], contentConcepts: ["paths-cycles-connectivity", "parameter-dependent-algebra"], skillEvidence: [evidence("representation-switching", "primary"), evidence("case-analysis", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "derive-one-step-recurrence", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["parameter-dependent-algebra"] },
        { milestoneId: "close-after-n-steps", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["paths-cycles-connectivity", "parameter-dependent-algebra"] },
        { milestoneId: "classify-singular-parameters", skillEvidence: [evidence("case-analysis", "primary")], contentConcepts: ["parameter-dependent-algebra"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "weighted-cycle-transfer", role: "transfer", prerequisiteStageIds: ["weighted-cycle-core"], domains: ["graph-theory", "algebra"], contentConcepts: ["paths-cycles-connectivity", "parameter-dependent-algebra"], skillEvidence: [evidence("precision-checking", "primary"), evidence("case-analysis", "supporting")], milestones: [{ milestoneId: "analyze-exception-consistency", skillEvidence: [evidence("precision-checking", "primary"), evidence("case-analysis", "supporting")], contentConcepts: ["parameter-dependent-algebra"] }], extensionIds: ["ordinary-sum-specialization", "difference-specialization"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDWeightedCycleReadingsEntry = authorCuratedProblem(oxfordDWeightedCycleReadingsSpec);

export const oxfordDLaminarFamilySpec: CuratedProblemSpec = {
  id: "oxford-d-laminar-family",
  title: "How Large Can a Nested-or-Disjoint Set Family Be?",
  mode: "OXFORD_MATHEMATICS",
  category: "combinatorics",
  topics: ["set systems", "extremal reasoning", "tree representation"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let U be an n-element set with n>=1. A family F of nonempty subsets of U contains U and every singleton, and has the property that for any A,B in F, either A is contained in B, B is contained in A, or A and B are disjoint. Prove a sharp upper bound on |F| and characterize when equality holds.",
  givenInformation: ["The displayed nested-or-disjoint property is sometimes called laminarity, but no prior knowledge of that term is needed."],
  approaches: [{ id: "inclusion-tree", label: "Turn containment into a rooted tree and count leaves versus internal nodes" }],
  milestones: [
    { id: "draw-small-families", description: "Build examples for n=2,3,4 and conjecture the sharp value 2n-1.", approachIds: ["inclusion-tree"], hintLevels: [1] },
    { id: "define-parent-relation", description: "For each set other than U, identify its unique smallest strict superset in F and form an inclusion tree.", approachIds: ["inclusion-tree"], prerequisiteIds: ["draw-small-families"], hintLevels: [2] },
    { id: "identify-leaves-and-children", description: "Show the leaves are exactly the n singletons and every internal node has at least two children whose union is the node.", approachIds: ["inclusion-tree"], prerequisiteIds: ["define-parent-relation"], hintLevels: [3] },
    { id: "count-tree-nodes", description: "Use edge counting in a rooted tree with n leaves and at least two children per internal node to prove |F|<=2n-1.", approachIds: ["inclusion-tree"], prerequisiteIds: ["identify-leaves-and-children"], hintLevels: [4] },
    { id: "characterize-equality", description: "Show equality holds exactly when every non-singleton set splits into exactly two maximal proper members of F.", approachIds: ["inclusion-tree"], prerequisiteIds: ["count-tree-nodes"], hintLevels: [5] }
  ],
  edges: [
    { from: "draw-small-families", to: "define-parent-relation" },
    { from: "define-parent-relation", to: "identify-leaves-and-children" },
    { from: "identify-leaves-and-children", to: "count-tree-nodes" },
    { from: "count-tree-nodes", to: "characterize-equality" }
  ],
  commonErrors: [
    { id: "parent-not-unique", description: "Introduces an inclusion tree without proving the laminar condition makes the minimal strict superset unique." },
    { id: "children-do-not-cover", description: "Counts children without using the singleton assumption to show every element of a non-singleton node lies in some maximal proper child." },
    { id: "equality-not-sharp", description: "Proves the inequality but does not exhibit or characterize full binary hierarchies attaining 2n-1." }
  ],
  followUps: ["Why are singletons important for the leaf count?", "Construct an equality example for every n."],
  extensions: [
    { id: "full-binary-construction", prompt: "Construct a family of size 2n-1 for every n by recursively splitting sets into two nonempty parts." },
    { id: "missing-singletons", prompt: "Drop the assumption that all singletons belong to F. Which part of the proof changes, and what bound remains true for a nonempty laminar family?" }
  ],
  hints: [
    { level: 1, text: "Try drawing each set as a node and connect it to the smallest larger set in F that contains it.", formulations: ["represent containment as a tree", "look for a hierarchy"] },
    { level: 2, text: "Laminarity makes two supersets of the same set comparable, so the smallest strict superset is unique.", formulations: ["prove the parent is unique", "supersets lie on one chain"] },
    { level: 3, text: "The leaves are singletons. For a non-singleton A, maximal proper subsets in F are disjoint, and the singleton containing each element of A lies below one of them, so they cover A.", formulations: ["internal nodes have at least two children", "children partition their parent"] },
    { level: 4, text: "If I is the number of internal nodes and L=n the number of leaves, then the tree has I+L-1 edges, while summing child counts gives at least 2I edges.", formulations: ["compare edges with child counts", "I is at most L minus one"] },
    { level: 5, text: "Equality requires every inequality above to be tight, so every internal node has exactly two children; conversely any full binary hierarchy gives equality.", formulations: ["equality means binary splitting everywhere", "characterize the sharp case"] }
  ],
  canonicalSolution: "Order F by inclusion. Because U is in F, every A!=U has a strict superset in F. Among them choose one minimal by inclusion; it is unique, because any two supersets of A intersect and laminarity therefore makes them comparable. Connect A to this parent. The result is a rooted tree with root U. Its leaves are exactly the singletons: a non-singleton A contains singleton members of F and therefore has descendants. For an internal node A, its children are maximal proper F-subsets of A. They are pairwise disjoint by laminarity. They cover A because each element a in A lies in the singleton {a}, and along the containment chain from {a} to A there is a child of A containing it. Hence every internal node has at least two children. Let L=n be the leaves and I the internal nodes. A tree with I+L vertices has I+L-1 edges, while summing the numbers of children over internal nodes also counts the edges and is at least 2I. Thus I+L-1>=2I, so I<=L-1=n-1 and |F|=I+L<=2n-1. Equality holds exactly when every internal node has exactly two children. Such full binary containment trees exist for every n by repeatedly splitting a non-singleton set into two nonempty pieces, so the bound is sharp.",
  verificationNotes: "For n=1, F={U} and the bound gives 1 with equality. The singleton assumption ensures exactly n leaves and guarantees children cover their parent. The numerical tree inequality is I+L-1>=2I. This theorem is known in laminar-family literature and should be treated as a high-risk originality candidate, not self-approved.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-laminar-family",
    domains: ["combinatorics", "set-theory"],
    contentConcepts: ["extremal-configuration", "set-relations"],
    prerequisiteConcepts: ["set-notation", "counting-principles"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("precision-checking", "supporting"), evidence("generalization", "supporting")],
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "moderate",
    introducesNewDefinition: true,
    stages: [
      { id: "laminar-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["combinatorics", "set-theory"], contentConcepts: ["extremal-configuration", "set-relations"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "draw-small-families", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["set-relations"] }], extensionIds: [], difficulty: "introductory-plus", timingKind: "opening", introducesNewDefinition: true },
      { id: "laminar-core", role: "core", prerequisiteStageIds: ["laminar-opening"], domains: ["combinatorics", "set-theory"], contentConcepts: ["extremal-configuration", "set-relations"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "define-parent-relation", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["set-relations"] },
        { milestoneId: "identify-leaves-and-children", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["set-relations"] },
        { milestoneId: "count-tree-nodes", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["extremal-configuration"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "laminar-transfer", role: "transfer", prerequisiteStageIds: ["laminar-core"], domains: ["combinatorics", "set-theory"], contentConcepts: ["extremal-configuration", "set-relations"], skillEvidence: [evidence("precision-checking", "primary"), evidence("generalization", "supporting")], milestones: [{ milestoneId: "characterize-equality", skillEvidence: [evidence("precision-checking", "primary")], contentConcepts: ["extremal-configuration"] }], extensionIds: ["full-binary-construction", "missing-singletons"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDLaminarFamilyEntry = authorCuratedProblem(oxfordDLaminarFamilySpec);

export const oxfordDMidpointClosedResiduesSpec: CuratedProblemSpec = {
  id: "oxford-d-midpoint-closed-residues",
  title: "Midpoint-Closed Sets Modulo a Prime",
  mode: "OXFORD_MATHEMATICS",
  category: "number theory",
  topics: ["modular arithmetic", "closure", "classification"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "Let p be an odd prime, and let S be a nonempty set of residue classes modulo p. Suppose that whenever x,y are in S, their modular midpoint (x+y)/2 is also in S. Classify all possible S. Then decide what the correct statement becomes for an odd composite modulus.",
  givenInformation: ["Because p is odd, 2 has a multiplicative inverse modulo p.", "All additions and divisions by 2 are taken modulo p."],
  approaches: [{ id: "translate-and-double", label: "Translate one point to zero, recover doubling from midpoint closure, then obtain additive closure" }],
  milestones: [
    { id: "test-small-residue-sets", description: "Explore examples for small odd primes and conjecture that only singletons and the whole residue system occur.", approachIds: ["translate-and-double"], hintLevels: [1] },
    { id: "translate-to-zero", description: "Choose a in S and translate to T=S-a, preserving midpoint closure and ensuring 0 in T.", approachIds: ["translate-and-double"], prerequisiteIds: ["test-small-residue-sets"], hintLevels: [2] },
    { id: "recover-doubling", description: "Use closure under halving and finiteness to prove T is also closed under doubling.", approachIds: ["translate-and-double"], prerequisiteIds: ["translate-to-zero"], hintLevels: [3] },
    { id: "prove-additive-subgroup", description: "Combine averaging and doubling to prove T is closed under addition, then use finiteness to obtain additive inverses.", approachIds: ["translate-and-double"], prerequisiteIds: ["recover-doubling"], hintLevels: [4] },
    { id: "classify-prime-and-composite", description: "Use primality to show a nonzero element generates all residues; then generalize to cosets of additive subgroups for odd composite moduli.", approachIds: ["translate-and-double"], prerequisiteIds: ["prove-additive-subgroup"], hintLevels: [5] }
  ],
  edges: [
    { from: "test-small-residue-sets", to: "translate-to-zero" },
    { from: "translate-to-zero", to: "recover-doubling" },
    { from: "recover-doubling", to: "prove-additive-subgroup" },
    { from: "prove-additive-subgroup", to: "classify-prime-and-composite" }
  ],
  commonErrors: [
    { id: "assumes-doubling", description: "Infers 2x is in the set directly from midpoint closure; this requires a finite-bijection argument after translating to include zero." },
    { id: "forgets-translation", description: "Tries to prove S itself is an additive subgroup even when 0 is not in S; the natural object is the translate S-a." },
    { id: "prime-step-in-composite", description: "Claims every nonzero residue generates the whole additive group for composite moduli." }
  ],
  followUps: ["Why is finiteness needed to turn closure under halving into closure under doubling?", "Give a nontrivial example modulo 9."],
  extensions: [
    { id: "odd-composite-cosets", prompt: "For odd m, prove every nonempty midpoint-closed S modulo m is a coset of an additive subgroup, and conversely." },
    { id: "mod-nine-examples", prompt: "List all midpoint-closed sets modulo 9 up to translation." }
  ],
  hints: [
    { level: 1, text: "Translate S so that one chosen element becomes 0. Midpoint closure is preserved by translation.", formulations: ["move one element to zero", "work with T equals S minus a"] },
    { level: 2, text: "With 0 in T, midpoint closure gives x/2 in T whenever x is in T.", formulations: ["T is closed under halving", "average x with zero"] },
    { level: 3, text: "The map x->x/2 is injective on the finite set T, hence bijective. Its inverse x->2x therefore also maps T to T.", formulations: ["finiteness recovers doubling", "halving is a permutation of T"] },
    { level: 4, text: "For x,y in T, first average to get (x+y)/2 in T and then double to get x+y in T. A finite nonempty subset of a finite group closed under addition is a subgroup.", formulations: ["averaging plus doubling gives addition", "T becomes an additive subgroup"] },
    { level: 5, text: "Modulo a prime, any nonzero residue additively generates every residue. For odd composite m, stop one step earlier: translated solutions are precisely additive subgroups.", formulations: ["prime modulus leaves only trivial subgroups", "composite solutions are subgroup cosets"] }
  ],
  canonicalSolution: "Choose a in S and set T=S-a. Then 0 is in T and T is still midpoint-closed. Averaging x in T with 0 shows x/2 is in T. The map h:T->T given by h(x)=x/2 is injective because 2 is invertible modulo p; since T is finite, h is bijective. Hence its inverse, doubling, also maps T into T. For x,y in T, midpoint closure gives (x+y)/2 in T and doubling gives x+y in T. Thus T is closed under addition. Because T is finite and contains 0, repeated addition of any x eventually returns to 0, so -x is also in T; therefore T is an additive subgroup of Z/pZ. If T={0}, then S is a singleton. Otherwise T contains nonzero x, and because p is prime the multiples 0,x,2x,...,(p-1)x are all residues, so T=Z/pZ and S is the whole residue system. For any odd composite modulus m the same translation, halving, doubling, and addition argument works because 2 remains invertible; the conclusion is that S is a coset of an additive subgroup of Z/mZ. Conversely every such coset is midpoint-closed.",
  verificationNotes: "Oddness of the modulus is essential because division by 2 must be well-defined. The finite-bijection step is necessary before asserting doubling closure. For prime p the additive subgroups are {0} and the full group. For odd composite m the subgroup-coset classification is exact.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-midpoint-closed-residues",
    similarityClusterId: "closure-classification-residue-affine",
    domains: ["number-theory", "set-theory"],
    contentConcepts: ["modular-reasoning", "relations-operations"],
    prerequisiteConcepts: ["modular-arithmetic", "set-notation"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("abstraction", "primary"), evidence("proof-construction", "primary"), evidence("generalization", "primary"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    novelty: "moderate",
    abstraction: "high",
    introducesNewDefinition: true,
    stages: [
      { id: "midpoint-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["number-theory", "set-theory"], contentConcepts: ["modular-reasoning", "relations-operations"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "test-small-residue-sets", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["modular-reasoning"] }], extensionIds: [], difficulty: "introductory-plus", timingKind: "opening", introducesNewDefinition: true },
      { id: "midpoint-core", role: "core", prerequisiteStageIds: ["midpoint-opening"], domains: ["number-theory", "set-theory"], contentConcepts: ["modular-reasoning", "relations-operations"], skillEvidence: [evidence("abstraction", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "translate-to-zero", skillEvidence: [evidence("abstraction", "primary")], contentConcepts: ["relations-operations"] },
        { milestoneId: "recover-doubling", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "prove-additive-subgroup", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["relations-operations"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "midpoint-transfer", role: "transfer", prerequisiteStageIds: ["midpoint-core"], domains: ["number-theory", "set-theory"], contentConcepts: ["modular-reasoning", "relations-operations"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "classify-prime-and-composite", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["modular-reasoning", "relations-operations"] }], extensionIds: ["odd-composite-cosets", "mod-nine-examples"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDMidpointClosedResiduesEntry = authorCuratedProblem(oxfordDMidpointClosedResiduesSpec);

export const oxfordDMirrorOrbitsSpec: CuratedProblemSpec = {
  id: "oxford-d-mirror-orbits",
  title: "Two Mirrors on a Modular Clock",
  mode: "OXFORD_MATHEMATICS",
  category: "number theory",
  topics: ["modular arithmetic", "function composition", "reachability"],
  difficulty: "uncalibrated-oxford-candidate",
  prompt: "A token moves on the residue classes modulo m, starting at 0. Two moves are available: R sends x to -x, and S sends x to c-x, where c is fixed. Which residues are reachable? Exactly when can every residue be reached? Explain the answer by composing the two mirror moves rather than by searching the state space.",
  givenInformation: ["m>=2.", "All positions and formulas are interpreted modulo m."],
  approaches: [{ id: "compose-reflections", label: "Compose two involutions to reveal a translation and then identify its modular orbit" }],
  milestones: [
    { id: "experiment-small-clocks", description: "Trace reachable positions for several pairs (m,c) and conjecture a gcd pattern.", approachIds: ["compose-reflections"], hintLevels: [1] },
    { id: "compose-to-translation", description: "Compute S∘R and R∘S and discover moves by +c and -c.", approachIds: ["compose-reflections"], prerequisiteIds: ["experiment-small-clocks"], hintLevels: [2] },
    { id: "construct-all-multiples", description: "Use repeated compositions to reach every integer multiple of c modulo m.", approachIds: ["compose-reflections"], prerequisiteIds: ["compose-to-translation"], hintLevels: [3] },
    { id: "prove-gcd-obstruction", description: "Let d=gcd(c,m) and prove both mirror moves preserve divisibility by d, so nothing outside that residue subgroup is reachable from 0.", approachIds: ["compose-reflections"], prerequisiteIds: ["construct-all-multiples"], hintLevels: [4] },
    { id: "general-starting-orbit", description: "From an arbitrary start a, describe the union of the translated class a+<c> and its reflected class -a+<c>.", approachIds: ["compose-reflections"], prerequisiteIds: ["prove-gcd-obstruction"], hintLevels: [5] }
  ],
  edges: [
    { from: "experiment-small-clocks", to: "compose-to-translation" },
    { from: "compose-to-translation", to: "construct-all-multiples" },
    { from: "construct-all-multiples", to: "prove-gcd-obstruction" },
    { from: "prove-gcd-obstruction", to: "general-starting-orbit" }
  ],
  commonErrors: [
    { id: "only-forward-c", description: "Finds +c but does not notice the inverse composition gives -c, making the reachable translation orbit transparent." },
    { id: "gcd-count-only", description: "States there are m/gcd(m,c) reachable positions without proving both inclusion directions." },
    { id: "arbitrary-start-coset", description: "For a nonzero start, claims only a+<c> is reachable and forgets that R can also move to the reflected coset -a+<c>." }
  ],
  followUps: ["How many residues are reachable from 0?", "What changes if the token starts at a instead?"],
  extensions: [
    { id: "arbitrary-start", prompt: "Starting at a, prove the orbit is (a+H) union (-a+H), where H is the set of multiples of gcd(c,m)." },
    { id: "orbit-size-boundary", prompt: "For an arbitrary start a, determine when the two cosets in the orbit description coincide and when the orbit has twice the size of H." }
  ],
  hints: [
    { level: 1, text: "Apply the two mirrors one after the other. Two reflections often act like a translation.", formulations: ["compose R and S", "look for a hidden shift"] },
    { level: 2, text: "S(R(x))=c+x, while R(S(x))=x-c.", formulations: ["the compositions add or subtract c", "two moves reveal translations"] },
    { level: 3, text: "Starting from 0, repeated translations reach every multiple kc modulo m.", formulations: ["generate the cyclic subgroup from c", "all multiples of c are constructible"] },
    { level: 4, text: "If d=gcd(c,m), both -x and c-x remain divisible by d whenever x is. The multiples of c modulo m are exactly the multiples of d.", formulations: ["gcd gives the obstruction", "reachable from zero means multiple of d"] },
    { level: 5, text: "From a, translations give a+H; one reflection gives -a+H. Further moves never leave the union of those two cosets.", formulations: ["general orbit is two reflected cosets", "check when the two cosets coincide"] }
  ],
  canonicalSolution: "The key compositions are S(R(x))=S(-x)=c+x and R(S(x))=-(c-x)=x-c. Thus from 0 we can repeatedly add or subtract c, so every multiple kc modulo m is reachable. Let d=gcd(c,m). The set of multiples of c modulo m is exactly the set H of residues divisible by d, and it has m/d elements. Conversely, if x is divisible by d, then R(x)=-x and S(x)=c-x are also divisible by d because d divides c. Starting at 0, no move can leave H. Hence the reachable residues are exactly H, and every residue is reachable exactly when gcd(c,m)=1. From a general starting position a, translations generate a+H; applying R gives -a+H, and R or S preserves the union. Therefore the full orbit is (a+H) union (-a+H). The two cosets coincide exactly when 2a is in H.",
  verificationNotes: "The reachable set from 0 is the cyclic subgroup generated additively by c; no group-theory terminology is required in the interview. The equality between multiples of c and multiples of d=gcd(c,m) is standard Bezout/modular arithmetic. For a general start, the two cosets coincide iff a-(-a)=2a lies in H.",
  reviewStatus: "expert-review",
  reviewNotes: DIRICHLET_CANDIDATE_REVIEW_NOTES,
  oxfordAdaptive: makeDirichletAdaptive({
    familyId: "oxford-d-mirror-orbits",
    domains: ["number-theory", "functions"],
    contentConcepts: ["modular-reasoning", "composition-iteration"],
    prerequisiteConcepts: ["modular-arithmetic", "functions-graphs", "divisibility"],
    skillEvidence: [evidence("small-case-exploration", "supporting"), evidence("representation-switching", "primary"), evidence("proof-construction", "primary"), evidence("generalization", "supporting"), evidence("precision-checking", "supporting")],
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    novelty: "high",
    abstraction: "moderate",
    introducesNewDefinition: false,
    stages: [
      { id: "mirror-opening", role: "warm-up", prerequisiteStageIds: [], domains: ["number-theory", "functions"], contentConcepts: ["modular-reasoning", "composition-iteration"], skillEvidence: [evidence("small-case-exploration", "primary")], milestones: [{ milestoneId: "experiment-small-clocks", skillEvidence: [evidence("small-case-exploration", "primary")], contentConcepts: ["modular-reasoning"] }], extensionIds: [], difficulty: "introductory", timingKind: "opening" },
      { id: "mirror-core", role: "core", prerequisiteStageIds: ["mirror-opening"], domains: ["number-theory", "functions"], contentConcepts: ["modular-reasoning", "composition-iteration"], skillEvidence: [evidence("representation-switching", "primary"), evidence("proof-construction", "primary")], milestones: [
        { milestoneId: "compose-to-translation", skillEvidence: [evidence("representation-switching", "primary")], contentConcepts: ["composition-iteration"] },
        { milestoneId: "construct-all-multiples", skillEvidence: [evidence("proof-construction", "supporting")], contentConcepts: ["modular-reasoning"] },
        { milestoneId: "prove-gcd-obstruction", skillEvidence: [evidence("proof-construction", "primary")], contentConcepts: ["modular-reasoning"] }
      ], extensionIds: [], difficulty: "standard", timingKind: "core" },
      { id: "mirror-transfer", role: "transfer", prerequisiteStageIds: ["mirror-core"], domains: ["number-theory", "functions"], contentConcepts: ["modular-reasoning", "composition-iteration"], skillEvidence: [evidence("generalization", "primary"), evidence("precision-checking", "supporting")], milestones: [{ milestoneId: "general-starting-orbit", skillEvidence: [evidence("generalization", "primary")], contentConcepts: ["composition-iteration", "modular-reasoning"] }], extensionIds: ["arbitrary-start", "orbit-size-boundary"], difficulty: "strong", timingKind: "transfer"
      }
    ]
  })
};
export const oxfordDMirrorOrbitsEntry = authorCuratedProblem(oxfordDMirrorOrbitsSpec);

export const dirichletBatchBEntries = Object.freeze([
  oxfordDPrimeDivisorThreeCyclesEntry,
  oxfordDSlidingWindowParityEntry,
  oxfordDWeightedCycleReadingsEntry,
  oxfordDLaminarFamilyEntry,
  oxfordDMidpointClosedResiduesEntry,
  oxfordDMirrorOrbitsEntry
] as const);
