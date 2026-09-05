import {
  buildCantorEntry,
  cantorSkills,
  cantorTiming,
  type CantorFamilyAuthoring
} from "./oxford-cantor-authoring.js";

export const cantorFunctionFamiliesB: readonly CantorFamilyAuthoring[] = [
  {
    id: "oxford-cantor-three-cycle-map",
    title: "Iterating a Fractional Function",
    category: "functions and iteration",
    topics: ["functions","iteration","algebra","domains"],
    prompt:
      "Consider f(x)=1-1/x. Determine the largest real set on which repeated iteration can continue indefinitely, explore f(f(x)) and f(f(f(x))), and classify the real orbit structure on that set.",
    givenInformation: [],
    approaches: [
      { id: "direct-composition", label: "Compute successive compositions and simplify" },
      { id: "orbit-experiments", label: "Generate a few numerical orbits and conjecture a common period" }
    ],
    milestones: [
      {
        id: "safe-iteration-domain",
        description: "Show that S=R\\{0,1} is invariant under f and is the natural real set for indefinite iteration.",
        skills: cantorSkills(["precision-checking", "primary"], ["definition-exploration", "supporting"]),
        concepts: ["composition-iteration", "qualitative-function-behavior"]
      },
      {
        id: "sample-orbits",
        description: "Compute several three-step orbits and conjecture that every orbit returns after three applications.",
        skills: cantorSkills(["small-case-exploration", "primary"], ["conjecture-formation", "supporting"]),
        concepts: ["composition-iteration", "qualitative-function-behavior"]
      },
      {
        id: "second-iterate",
        description: "Simplify f²(x)=1/(1-x) while preserving its domain restrictions.",
        skills: cantorSkills(["technique", "supporting"], ["representation-switching", "supporting"]),
        concepts: ["composition-iteration", "function-transformations"]
      },
      {
        id: "exact-period-three",
        description: "Prove f³(x)=x on S, rule out real fixed points, and conclude that every admissible real orbit has exact period three.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "supporting"]),
        concepts: ["composition-iteration", "fixed-point-constraints"]
      },
      {
        id: "shifted-cycle-transfer",
        description: "Transfer the three-cycle structure to a horizontally shifted fractional map and derive simple relations within one orbit.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"]),
        concepts: ["composition-iteration", "function-transformations", "composition-constraints"]
      }
    ],
    commonErrors: [
      {
        id: "use-r-minus-zero-only",
        description: "Uses R\\{0} as the iteration domain and misses that starting from x=1 reaches 0 on the first step."
      },
      {
        id: "period-divides-three-only",
        description: "Stops after proving f³=id without ruling out period-one real orbits."
      }
    ],
    followUps: [
      "Can a real orbit have period exactly two?",
      "How does shifting the exceptional points change the formula while preserving the three-cycle structure?"
    ],
    extensions: [
      {
        id: "shifted-three-cycle",
        prompt: "For a real c, analyze g_c(x)=c+1-1/(x-c) and identify its invariant iteration domain and orbit period."
      },
      {
        id: "orbit-symmetric-relations",
        prompt: "For one orbit x,f(x),f²(x), find simple algebraic relations among the three values."
      }
    ],
    hints: [
      {
        text: "Starting at x=1 is also unsafe because the first image is 0.",
        formulations: ["iteration needs more than the one-step domain", "remove points whose future orbit hits a pole"]
      },
      {
        text: "Try x=2 and x=3 to see whether a short cycle appears.",
        formulations: ["compute three consecutive values", "small examples suggest a universal period"]
      },
      {
        text: "Carefully simplify 1-1/(1-1/x).",
        formulations: ["the second iterate is another simple fractional-linear map", "f²(x)=1/(1-x)"]
      },
      {
        text: "Apply f once more to 1/(1-x), then solve f(x)=x; f³=id and the absence of real fixed points together force exact period three.",
        formulations: ["prove return and exclude shorter real orbits in the same core argument", "period divides three, then rule out period one"]
      },
      {
        text: "For g_c(x)=c+1-1/(x-c), translate y=x-c so the shifted problem becomes the same three-cycle map.",
        formulations: ["conjugate by a horizontal translation", "the exceptional points move from {0,1} to {c,c+1}"]
      }
    ],
    canonicalSolution:
      "The one-step formula is defined for x≠0, but x=1 maps to 0, so indefinite real iteration requires S=R\\{0,1}. If x∈S, then f(x)=1-1/x is neither 0 (which would force x=1) nor 1, so S is invariant. Direct calculation gives f²(x)=1/(1-x) and f³(x)=1-1/(1/(1-x))=x. Thus every orbit has period dividing 3. A fixed point would satisfy x=1-1/x, i.e. x²-x+1=0, which has no real roots. Period 2 is impossible because a period must divide 3. Hence every real orbit in S has exact period 3. For g_c(x)=c+1-1/(x-c), translating y=x-c reduces the map to f(y)+c; its safe domain is R\\{c,c+1} and every orbit again has exact period 3.",
    verificationNotes:
      "Check invariance of S explicitly. The statement about period two follows because g³=id: if g²(x)=x, then applying g gives g³(x)=g(x), so x=g(x), contradicting absence of fixed points.",
    domains: ["functions", "functional-equations", "algebra"],
    contentConcepts: [
      "composition-iteration",
      "qualitative-function-behavior",
      "function-transformations",
      "fixed-point-constraints",
      "composition-constraints"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "functions-graphs", "equations-inequalities"],
    skills: cantorSkills(
      ["precision-checking", "primary"],
      ["definition-exploration", "supporting"],
      ["small-case-exploration", "primary"],
      ["conjecture-formation", "supporting"],
      ["technique", "supporting"],
      ["representation-switching", "supporting"],
      ["proof-construction", "primary"],
      ["generalization", "primary"],
      ["transfer", "supporting"],
      ["guided-adaptation", "supporting"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 4], [13, 21], [10, 18], [3, 7], 21),
    stageTiming: [
      cantorTiming([1, 2], [4, 6], [3, 5], undefined, 6),
      cantorTiming([1, 3], [7, 12], [5, 10], undefined, 12),
      cantorTiming([1, 3], [4, 8], [3, 7], [2, 5], 8)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "low",
    abstraction: "moderate",
    similarityClusterId: "mobius-iteration",
    provenance: { originType: "classic-problem", sourceCategory: "secondary-reference" },
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-quartic-horizontal-levels",
    title: "Horizontal Levels of a Quartic",
    category: "functions and graph sketching",
    topics: ["quartics","graphs","equations","parameters"],
    prompt:
      "For a>0 let Q_a(x)=x⁴-2a x². Sketch the graph, then classify the number of distinct real solutions of Q_a(x)=c for every real c. Finally show how all values of a>0 are rescaled versions of one master graph.",
    givenInformation: [],
    approaches: [
      { id: "u-equals-x-squared", label: "View the quartic equation as a quadratic in u=x²" },
      { id: "derivative-shape", label: "Use derivative and symmetry to build the graph first" }
    ],
    milestones: [
      {
        id: "even-symmetry",
        description: "Identify even symmetry, factor Q_a=x²(x²-2a), and locate the x-axis intersections.",
        skills: cantorSkills(["graph-sketching", "supporting"], ["technique", "supporting"]),
        concepts: ["symmetry-periodicity", "roots-intersections", "polynomial-structure"]
      },
      {
        id: "critical-points",
        description: "Find critical points 0 and ±sqrt(a) and classify their heights.",
        skills: cantorSkills(["technique", "primary"], ["precision-checking", "supporting"]),
        concepts: ["derivative-structure", "turning-points-extrema"]
      },
      {
        id: "level-count-picture",
        description: "Use the sketch to predict solution counts across levels c relative to -a² and 0.",
        skills: cantorSkills(["visualization", "primary"], ["case-analysis", "supporting"]),
        concepts: ["roots-intersections", "qualitative-function-behavior"]
      },
      {
        id: "algebraic-count-proof",
        description: "Set u=x²≥0 and prove the predicted counts algebraically, including the equality levels.",
        skills: cantorSkills(["representation-switching", "primary"], ["proof-construction", "primary"]),
        concepts: ["equations-inequalities", "roots-intersections"]
      },
      {
        id: "master-scaling",
        description: "Show Q_a(x)=a²Q_1(x/sqrt(a)) and interpret the horizontal and vertical scaling.",
        skills: cantorSkills(["generalization", "primary"], ["representation-switching", "supporting"]),
        concepts: ["function-transformations", "parameter-dependent-curves"]
      }
    ],
    commonErrors: [
      {
        id: "four-solutions-at-zero",
        description: "Counts multiplicity and says c=0 has four solutions instead of the three distinct values x=0,±sqrt(2a)."
      },
      {
        id: "forget-u-nonnegative",
        description: "Solves the quadratic in u but counts negative u roots as real x values."
      }
    ],
    followUps: [
      "Which solution-count transitions correspond to tangencies with horizontal lines?",
      "Can you derive the scaling before doing any calculus?"
    ],
    extensions: [
      {
        id: "scaled-master-graph",
        prompt: "Use the master graph Q_1 to reconstruct Q_a for arbitrary a>0 and translate every critical coordinate."
      },
      {
        id: "tilted-quartic-question",
        prompt: "Predict which symmetries and root-count shortcuts disappear if a small linear term bx is added."
      }
    ],
    hints: [
      {
        text: "Factor x² and use that the graph is even.",
        formulations: ["start with symmetry and roots", "there is a double root at 0"]
      },
      {
        text: "Q_a'(x)=4x(x²-a), so the nonzero critical points are ±sqrt(a).",
        formulations: ["differentiate after exploiting symmetry", "evaluate the quartic at its three critical points"]
      },
      {
        text: "The two minima have height -a² while the central local maximum has height 0.",
        formulations: ["slide a horizontal line through those two special levels", "there are five level regimes"]
      },
      {
        text: "For a proof, let u=x²≥0; then u²-2a u-c=0.",
        formulations: ["turn the quartic into a quadratic with a sign constraint", "each positive u yields two x-values and u=0 yields one"]
      },
      {
        text: "Substitute x=sqrt(a)z and factor out a².",
        formulations: ["normalize the parameter by rescaling x", "all a>0 graphs have the same shape"]
      }
    ],
    canonicalSolution:
      "Q_a is even and equals x²(x²-2a), so its zeros are 0 and ±sqrt(2a). Differentiating gives Q_a'=4x(x²-a), so x=0 is a local maximum of height 0 and x=±sqrt(a) are minima of height -a². Thus c<-a² gives 0 solutions; c=-a² gives 2; -a²<c<0 gives 4; c=0 gives 3 distinct solutions; c>0 gives 2. Algebraically, setting u=x²≥0 gives u²-2a u-c=0 and reproduces the same count after enforcing u≥0. Finally Q_a(sqrt(a)z)=a²(z⁴-2z²), so Q_a(x)=a²Q_1(x/sqrt(a)): horizontally stretch Q_1 by sqrt(a) and vertically scale by a².",
    verificationNotes:
      "At c=-a², the quadratic in u has one repeated positive root u=a, giving two distinct x values. At c=0, u=0 and u=2a give 1+2=3 distinct x values.",
    domains: ["functions", "graph-sketching", "calculus", "algebra"],
    contentConcepts: [
      "symmetry-periodicity",
      "roots-intersections",
      "polynomial-structure",
      "derivative-structure",
      "turning-points-extrema",
      "qualitative-function-behavior",
      "equations-inequalities",
      "function-transformations",
      "parameter-dependent-curves"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "polynomial-factorization", "functions-graphs", "differentiation"],
    skills: cantorSkills(
      ["graph-sketching", "supporting"],
      ["technique", "primary"],
      ["precision-checking", "supporting"],
      ["visualization", "primary"],
      ["case-analysis", "supporting"],
      ["representation-switching", "primary"],
      ["proof-construction", "primary"],
      ["generalization", "primary"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 4], [14, 22], [11, 19], [4, 7], 22),
    stageTiming: [
      cantorTiming([1, 2], [4, 6], [3, 5], undefined, 6),
      cantorTiming([1, 4], [7, 13], [5, 11], undefined, 13),
      cantorTiming([1, 3], [4, 8], [3, 7], [3, 6], 8)
    ],
    openingRole: "technique-check",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-reciprocal-increment-recurrence",
    title: "A Reciprocal-Increment Recurrence",
    category: "sequences and recurrences",
    topics: ["sequences","recurrences","asymptotics","inequalities"],
    prompt:
      "Let a_0>0 and define a_{n+1}=a_n+1/a_n. Prove that the sequence grows without bound, then determine its asymptotic size as precisely as you can. A useful target is to decide whether a_n/sqrt(2n) has a limit.",
    givenInformation: [
      "If you need it for a reciprocal-sum bound, you may use this sum-integral comparison: for a positive decreasing function h, sum_{k=1}^{n-1} h(k) ≤ h(1)+∫_1^n h(t)dt. You may also prove the integral comparison directly from the graph rather than treat it as prior knowledge."
    ],
    approaches: [
      { id: "square-the-update", label: "Square the recurrence to expose a nearly telescoping relation" },
      { id: "growth-bounds", label: "Build lower and upper bounds strong enough to squeeze the normalized sequence" }
    ],
    milestones: [
      {
        id: "monotone-growth",
        description: "Show a_n remains positive and is strictly increasing.",
        skills: cantorSkills(["proof-construction", "supporting"], ["precision-checking", "supporting"]),
        concepts: ["monotonicity-boundedness", "recurrence-structure"]
      },
      {
        id: "square-identity",
        description: "Derive a_{n+1}²=a_n²+2+1/a_n².",
        skills: cantorSkills(["strategic-simplification", "primary"], ["technique", "supporting"]),
        concepts: ["recurrence-structure", "telescoping-structure"]
      },
      {
        id: "linear-lower-bound",
        description: "Iterate the square identity to prove a_n²≥a_0²+2n and hence divergence.",
        skills: cantorSkills(["proof-construction", "primary"], ["invariants", "supporting"]),
        concepts: ["inequalities-bounds", "recurrence-structure"]
      },
      {
        id: "error-sum-and-limit",
        description: "Sum the square identity, bound the reciprocal-square error by a self-contained integral comparison, and conclude a_n/sqrt(2n)→1.",
        skills: cantorSkills(["representation-switching", "primary"], ["proof-construction", "primary"], ["precision-checking", "supporting"]),
        concepts: ["telescoping-structure", "inequalities-bounds", "limiting-arguments", "sequence-convergence"]
      },
      {
        id: "scaled-step-transfer",
        description: "Transfer the argument to a_{n+1}=a_n+c/a_n and use the exact sum to discuss the smaller logarithmic correction beyond the leading term.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["recurrence-structure", "limiting-arguments", "telescoping-structure"]
      }
    ],
    commonErrors: [
      {
        id: "ignore-cumulative-error",
        description: "Drops the positive term 1/a_n² and asserts a_n²=a_0²+2n exactly."
      },
      {
        id: "bound-error-by-n",
        description: "Uses only 1/a_k²≤1/a_0², producing an O(n) error that is too weak for the target asymptotic."
      }
    ],
    followUps: [
      "Why is a logarithmic cumulative error negligible compared with 2n?",
      "What changes if the reciprocal increment is c/a_n with c>0?"
    ],
    extensions: [
      {
        id: "scaled-reciprocal-step",
        prompt: "For c>0 and a_{n+1}=a_n+c/a_n, prove a_n/sqrt(2cn)→1."
      },
      {
        id: "second-order-question",
        prompt: "Use the exact summed identity to discuss why a logarithmic correction to a_n² is plausible even though the leading term is 2n."
      }
    ],
    hints: [
      {
        text: "Positivity makes every increment 1/a_n positive, so begin with monotonicity.",
        formulations: ["the sequence can never hit zero", "growth is immediate but its rate is not"]
      },
      {
        text: "Square a_{n+1}=a_n+1/a_n.",
        formulations: ["squaring reveals a constant increment plus a small error", "look at a_n² rather than a_n"]
      },
      {
        text: "The identity immediately gives a_k²≥a_0²+2k.",
        formulations: ["discard only the positive error term for a lower bound", "this also proves divergence"]
      },
      {
        text: "Sum the exact identity, use 1/a_k²≤1/(a_0²+2k), and apply the supplied decreasing-sum/integral comparison; that error is logarithmic and therefore negligible after division by n.",
        formulations: ["the reciprocal-linear sum grows much more slowly than n", "normalize the squared sequence before taking positive square roots"]
      },
      {
        text: "For increment c/a_n, squaring changes the main increment to 2c and the residual to c²/a_n²; the same comparison controls the error.",
        formulations: ["the leading scale becomes sqrt(2cn)", "the exact summed identity also explains why a logarithmic second-order correction is plausible"]
      }
    ],
    canonicalSolution:
      "Since a_0>0 and a_{n+1}=a_n+1/a_n, all terms are positive and strictly increasing. Squaring gives a_{n+1}²=a_n²+2+1/a_n². Hence a_n²≥a_0²+2n, so a_n→∞. Summing exactly gives a_n²=a_0²+2n+sum_{k=0}^{n-1}1/a_k². The lower bound implies 1/a_k²≤1/(a_0²+2k). This reciprocal-linear sum is at most C+(1/2)log n for a constant C depending on a_0, for example by an integral comparison after finitely many initial terms. Thus 0≤a_n²-(a_0²+2n)=O(log n), so a_n²/(2n)→1 and, since a_n>0, a_n/sqrt(2n)→1. For a_{n+1}=a_n+c/a_n, squaring gives an increment 2c+c²/a_n², leading similarly to a_n/sqrt(2cn)→1.",
    verificationNotes:
      "Avoid relying on big-O as an unexplained theorem in the interview: an explicit bound C+(1/2)log n is enough. For the c-extension, the lower bound becomes a_n²≥a_0²+2cn and the error sum is c² sum 1/a_k²=O(log n).",
    domains: ["sequences-recurrences", "elementary-analysis", "algebra"],
    contentConcepts: [
      "recurrence-structure",
      "monotonicity-boundedness",
      "telescoping-structure",
      "inequalities-bounds",
      "limiting-arguments",
      "sequence-convergence"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "sequences-series", "limits-continuity"],
    skills: cantorSkills(
      ["proof-construction", "primary"],
      ["precision-checking", "supporting"],
      ["strategic-simplification", "primary"],
      ["technique", "supporting"],
      ["invariants", "supporting"],
      ["representation-switching", "primary"],
      ["generalization", "primary"],
      ["transfer", "supporting"],
      ["guided-adaptation", "supporting"]
    ),
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "stretch" },
    timing: cantorTiming([2, 5], [17, 28], [13, 23], [5, 10], 25),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 5], [10, 18], [8, 15], undefined, 18),
      cantorTiming([2, 4], [6, 11], [5, 9], [4, 8], 11)
    ],
    openingRole: "warm-up",
    finalRole: "stretch",
    novelty: "moderate",
    abstraction: "high",
    provenance: { originType: "classic-problem", sourceCategory: "secondary-reference" },
    originalityRisk: "high",
    correctnessRisk: "medium",
    calibrationRisk: "high"
  },
  {
    id: "oxford-cantor-mobius-involution",
    title: "A Parameterized Fractional Function",
    category: "functions and graph sketching",
    topics: ["functions","fractional functions","graphs","parameters"],
    prompt:
      "For real a define T_a(x)=(a-x)/(1+x), wherever this makes sense. Investigate the graph and the effect of applying T_a twice. Classify how the fixed points change with a, paying special attention to the exceptional value a=-1.",
    givenInformation: [],
    approaches: [
      { id: "implicit-hyperbola", label: "Rewrite y=T_a(x) as a symmetric implicit equation" },
      { id: "direct-composition", label: "Compose the fractional-linear formula and isolate exceptional parameters" }
    ],
    milestones: [
      {
        id: "implicit-form",
        description: "Rewrite y=(a-x)/(1+x) as (x+1)(y+1)=a+1.",
        skills: cantorSkills(["representation-switching", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["analytic-curve-geometry", "function-transformations"]
      },
      {
        id: "graph-symmetry",
        description: "For a≠-1, identify the rectangular-hyperbola structure centered at (-1,-1), asymptotes x=-1 and y=-1, and symmetry under x↔y.",
        skills: cantorSkills(["graph-sketching", "primary"], ["visualization", "supporting"]),
        concepts: ["asymptotic-behavior", "symmetry-periodicity", "qualitative-function-behavior"]
      },
      {
        id: "involution",
        description: "Prove T_a(T_a(x))=x for a≠-1 and every x in the domain.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "primary"]),
        concepts: ["composition-iteration", "composition-constraints"]
      },
      {
        id: "fixed-points-and-exception",
        description: "Classify fixed points from (x+1)²=a+1 and separately prove that a=-1 collapses the map to the constant -1 on its domain, so the self-inverse property fails there.",
        skills: cantorSkills(["case-analysis", "primary"], ["technique", "supporting"], ["precision-checking", "primary"]),
        concepts: ["fixed-point-constraints", "roots-intersections", "parameter-dependent-algebra", "qualitative-function-behavior"]
      },
      {
        id: "self-inverse-transfer",
        description: "Use graph reflection to explain the self-inverse relation and construct a shifted fractional-linear example S satisfying S(S(x))=x on its valid domain.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["graph-sketching", "supporting"]),
        concepts: ["composition-iteration", "function-transformations", "analytic-curve-geometry"]
      }
    ],
    commonErrors: [
      {
        id: "claim-involution-at-minus-one",
        description: "Cancels a+1 in the composition and falsely extends T_a²=id to a=-1."
      },
      {
        id: "count-invalid-fixed-root",
        description: "At a=-1 solves (x+1)²=0 and counts x=-1 even though it is outside the function domain."
      }
    ],
    followUps: [
      "Why does symmetry of the graph about y=x naturally suggest an inverse relation?",
      "How is the fixed-point count visible as intersections of the hyperbola with y=x?"
    ],
    extensions: [
      {
        id: "inverse-graph-explanation",
        prompt: "Explain directly from graph reflection why T_a is its own inverse when a≠-1."
      },
      {
        id: "shifted-scaled-involution",
        prompt: "Construct another nontrivial fractional-linear function S by shifting the center so that S(S(x))=x wherever both sides are defined, and describe its fixed-point regimes."
      }
    ],
    hints: [
      {
        text: "Cross-multiply and add x+y+1 to both sides until the expression factors.",
        formulations: ["seek a symmetric equation in x and y", "(x+1)(y+1)=a+1"]
      },
      {
        text: "For a≠-1 the implicit equation is a translated reciprocal hyperbola, symmetric in x and y.",
        formulations: ["read asymptotes and inverse symmetry from the implicit form", "the center is (-1,-1)"]
      },
      {
        text: "When composing T_a with itself, keep the factor a+1 visible instead of canceling immediately.",
        formulations: ["the exceptional parameter should remain visible", "simplify numerator and denominator in parallel"]
      },
      {
        text: "The fixed-point equation is (x+1)²=a+1, but at a=-1 simplify the original formula directly before using any generic cancellation.",
        formulations: ["classify the fixed points and exceptional degeneration together", "T_{-1} is constant on its domain, so applying it twice is not a valid identity"]
      },
      {
        text: "Here 'self-inverse' means exactly S(S(x))=x wherever both applications are defined; shift the symmetric hyperbola picture to construct another example.",
        formulations: ["do not make terminology a prerequisite", "graph reflection across y=x suggests the composition identity directly"]
      }
    ],
    canonicalSolution:
      "Writing y=(a-x)/(1+x) gives y+xy=a-x, hence (x+1)(y+1)=a+1. For a≠-1 this is a rectangular hyperbola centered at (-1,-1) with asymptotes x=-1 and y=-1, symmetric in x and y. Direct composition gives T_a(T_a(x))=x for every x≠-1 when a≠-1; equivalently, the graph symmetry means the function equals its inverse. Fixed points satisfy (x+1)²=a+1. Thus a>-1 gives two fixed points x=-1±sqrt(a+1), while a<-1 gives none. At a=-1, the original formula simplifies to T_{-1}(x)=(-1-x)/(1+x)=-1 for x≠-1. It has no fixed point because its only apparent fixed value -1 is outside the domain, and applying it twice is not even defined after the first step. This is exactly why the exceptional parameter must be separated before cancellation.",
    verificationNotes:
      "For a≠-1, verify T_a(x) never equals -1: that equality would force a=-1. Therefore the second application is defined whenever the first is. At a=-1 the map is constant -1 on R\\{-1} and iteration stops immediately.",
    domains: ["functions", "functional-equations", "graph-sketching", "coordinate-geometry", "algebra"],
    contentConcepts: [
      "analytic-curve-geometry",
      "function-transformations",
      "asymptotic-behavior",
      "symmetry-periodicity",
      "qualitative-function-behavior",
      "composition-iteration",
      "composition-constraints",
      "fixed-point-constraints",
      "roots-intersections",
      "parameter-dependent-algebra",
      "parameter-dependent-curves"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "equations-inequalities", "functions-graphs", "coordinate-geometry-basics"],
    skills: cantorSkills(
      ["representation-switching", "primary"],
      ["strategic-simplification", "supporting"],
      ["graph-sketching", "primary"],
      ["visualization", "supporting"],
      ["proof-construction", "primary"],
      ["precision-checking", "primary"],
      ["case-analysis", "primary"],
      ["technique", "supporting"],
      ["error-recovery", "supporting"],
      ["generalization", "primary"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "strong" },
    timing: cantorTiming([3, 6], [17, 26], [13, 22], [4, 8], 24),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 5], [9, 15], [7, 13], undefined, 15),
      cantorTiming([1, 3], [4, 9], [3, 7], [3, 6], 9)
    ],
    openingRole: "technique-check",
    finalRole: "transfer",
    novelty: "high",
    abstraction: "high",
    similarityClusterId: "mobius-iteration",
    originalityRisk: "medium",
    correctnessRisk: "medium",
    calibrationRisk: "high"
  }
];

export const cantorFunctionEntriesB = Object.freeze(cantorFunctionFamiliesB.map(buildCantorEntry));
