import {
  buildCantorEntry,
  cantorSkills,
  cantorTiming,
  type CantorFamilyAuthoring
} from "./oxford-cantor-authoring.js";

export const cantorFunctionFamiliesA: readonly CantorFamilyAuthoring[] = [
  {
    id: "oxford-cantor-reciprocal-paired-inputs",
    title: "A Rational Function on the Positive Reals",
    category: "functions and graph sketching",
    topics: ["functions","graphs","algebra","inequalities"],
    prompt:
      "For x>0 define f(x)=x/(1+x)². Sketch the graph as efficiently as possible, determine its exact range, and characterize precisely when two different positive inputs give the same output.",
    givenInformation: [],
    approaches: [
      { id: "reciprocal-symmetry", label: "Exploit the transformation x↦1/x before differentiating" },
      { id: "inequality-range", label: "Use a sharp inequality to obtain the maximum and then infer inverse branches" }
    ],
    milestones: [
      {
        id: "endpoint-behavior",
        description: "Determine the behavior as x→0+ and x→∞ and identify positivity.",
        skills: cantorSkills(["graph-sketching", "supporting"], ["precision-checking", "supporting"]),
        concepts: ["qualitative-function-behavior", "asymptotic-behavior"]
      },
      {
        id: "reciprocal-invariance",
        description: "Prove f(1/x)=f(x) and interpret the symmetry as pairing inputs.",
        skills: cantorSkills(["pattern-recognition", "primary"], ["representation-switching", "supporting"]),
        concepts: ["function-transformations", "inverse-functions"]
      },
      {
        id: "sharp-maximum",
        description: "Prove f(x)≤1/4 with equality only at x=1.",
        skills: cantorSkills(["proof-construction", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["inequalities-bounds", "turning-points-extrema"]
      },
      {
        id: "equal-output-classification",
        description: "Show algebraically that f(x)=f(y) implies x=y or xy=1 for positive x,y.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "primary"]),
        concepts: ["inverse-functions", "equations-inequalities"]
      },
      {
        id: "scaled-family",
        description: "Transfer the reciprocal pairing and range analysis to x/(a+x)² for a>0.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"]),
        concepts: ["parameter-dependent-curves", "function-transformations", "turning-points-extrema"]
      }
    ],
    commonErrors: [
      {
        id: "claim-graph-axis-symmetry",
        description: "Treats f(1/x)=f(x) as ordinary reflection symmetry in the x-y plane rather than a pairing under reciprocal x-coordinates."
      },
      {
        id: "miss-equal-input-case",
        description: "States xy=1 for every equal-output pair and forgets the trivial possibility x=y."
      }
    ],
    followUps: [
      "Can you describe the two inverse branches without solving a quadratic explicitly?",
      "What pairing replaces xy=1 for f_a(x)=x/(a+x)²?"
    ],
    extensions: [
      {
        id: "scaled-denominator",
        prompt: "For a>0, analyze f_a(x)=x/(a+x)² on x>0: find its maximum, range, and equal-output pairing."
      },
      {
        id: "inverse-branch-geometry",
        prompt: "Describe how the branches x<1 and x>1 encode the two-valued inverse relation and how reciprocal pairing joins them."
      }
    ],
    hints: [
      {
        text: "Before differentiating, inspect what happens when x is replaced by 1/x.",
        formulations: ["try reciprocal input substitution", "the denominator transforms in a useful way"]
      },
      {
        text: "A short simplification gives f(1/x)=f(x).",
        formulations: ["reciprocal inputs have equal heights", "the graph pairs x with 1/x"]
      },
      {
        text: "(1+x)²≥4x immediately bounds f(x).",
        formulations: ["use a square or AM-GM on the denominator", "look for a sharp inequality with equality at x=1"]
      },
      {
        text: "Cross-multiply f(x)=f(y) and factor the result.",
        formulations: ["the equality simplifies to a product of two factors", "separate x=y from the nontrivial pairing"]
      },
      {
        text: "For x/(a+x)², try the transformation x↦a²/x.",
        formulations: ["the reciprocal map acquires a scale", "expect equal-output pairs with product a²"]
      }
    ],
    canonicalSolution:
      "As x→0+ and x→∞, f(x)→0, and f(x)>0. Also f(1/x)=x/(1+x)²=f(x), so reciprocal inputs are paired. Since (1+x)²≥4x, f(x)≤1/4 with equality exactly at x=1; continuity then gives range (0,1/4]. For equal outputs, x(1+y)²=y(1+x)². Expanding and simplifying gives (x-y)(1-xy)=0, so either x=y or xy=1. Thus each value in (0,1/4) has exactly two positive preimages, reciprocal to one another. For f_a(x)=x/(a+x)², one has f_a(a²/x)=f_a(x), the maximum is 1/(4a) at x=a, and nontrivial equal-output pairs satisfy xy=a².",
    verificationNotes:
      "Domain is x>0 throughout. Verify the factorization of equal outputs exactly. The scaled family has maximum 1/(4a), not 1/(4a²), and its reciprocal pairing is x↦a²/x.",
    domains: ["functions", "graph-sketching", "algebra", "elementary-analysis"],
    contentConcepts: [
      "qualitative-function-behavior",
      "asymptotic-behavior",
      "function-transformations",
      "inverse-functions",
      "turning-points-extrema",
      "inequalities-bounds",
      "equations-inequalities",
      "parameter-dependent-curves"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "equations-inequalities", "functions-graphs"],
    skills: cantorSkills(
      ["graph-sketching", "supporting"],
      ["precision-checking", "primary"],
      ["pattern-recognition", "primary"],
      ["representation-switching", "supporting"],
      ["proof-construction", "primary"],
      ["strategic-simplification", "supporting"],
      ["generalization", "primary"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 4], [14, 22], [11, 19], [4, 7], 22),
    stageTiming: [
      cantorTiming([1, 2], [4, 6], [3, 5], undefined, 6),
      cantorTiming([1, 4], [7, 13], [5, 11], undefined, 13),
      cantorTiming([1, 3], [4, 8], [3, 7], [3, 6], 8)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "moderate",
    similarityClusterId: "cantor-reciprocal-symmetry",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-exponential-rotating-line",
    title: "An Exponential and a Line",
    category: "functions and calculus",
    topics: ["functions","exponentials","graphs","calculus"],
    prompt:
      "For a>0, investigate the number of real solutions of e^x=a x. Do this graphically and then justify the transition values of a exactly. Explain what happens at the transition and how the result changes for e^{b x}=a x with b>0.",
    givenInformation: [
      "You may use basic differentiation of e^x."
    ],
    approaches: [
      { id: "ratio-minimum", label: "On x>0 minimize e^x/x" },
      { id: "line-tangency", label: "Interpret the transition as a line through the origin becoming tangent to y=e^x" }
    ],
    milestones: [
      {
        id: "exclude-negative-x",
        description: "Show any solution must have x>0.",
        skills: cantorSkills(["precision-checking", "supporting"], ["strategic-simplification", "supporting"]),
        concepts: ["roots-intersections", "qualitative-function-behavior"]
      },
      {
        id: "graphical-regimes",
        description: "Sketch y=e^x together with lines y=ax and predict zero, one, or two intersections.",
        skills: cantorSkills(["graph-sketching", "primary"], ["visualization", "supporting"]),
        concepts: ["parameter-dependent-curves", "roots-intersections"]
      },
      {
        id: "minimize-ratio",
        description: "Rewrite the equation as a=e^x/x and find the unique minimum of that ratio.",
        skills: cantorSkills(["representation-switching", "primary"], ["technique", "primary"]),
        concepts: ["optimization-extrema", "derivative-structure"]
      },
      {
        id: "classify-a",
        description: "Prove there are no solutions for a<e, one at a=e, and two for a>e.",
        skills: cantorSkills(["proof-construction", "primary"], ["case-analysis", "supporting"]),
        concepts: ["roots-intersections", "turning-points-extrema", "qualitative-function-behavior"]
      },
      {
        id: "scale-exponent",
        description: "Transfer the argument to e^{b x}=a x and identify the threshold a=be.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"]),
        concepts: ["parameter-dependent-algebra", "function-transformations"]
      }
    ],
    commonErrors: [
      {
        id: "allow-negative-solution",
        description: "Searches on x<0 even though e^x>0 and ax<0 there for a>0."
      },
      {
        id: "threshold-e-over-b",
        description: "Scales the generalized threshold incorrectly; for e^{bx}=ax the minimum of e^{bx}/x is be."
      }
    ],
    followUps: [
      "Can you recover the threshold without differentiating e^x/x directly?",
      "What is the geometric meaning of the double solution when a=e?"
    ],
    extensions: [
      {
        id: "scaled-exponent",
        prompt: "For b>0 classify the solutions of e^{bx}=a x and explain the scaling from the b=1 case."
      },
      {
        id: "tangent-condition",
        prompt: "At the threshold, derive the tangency point and slope using simultaneous value and derivative conditions."
      }
    ],
    hints: [
      {
        text: "First use signs: for a>0 there cannot be a solution with x≤0.",
        formulations: ["restrict the domain before optimizing", "the two sides have incompatible signs on negative x"]
      },
      {
        text: "Think of lines through the origin with slope a intersecting y=e^x.",
        formulations: ["rotate a line through the origin", "there should be a tangency threshold"]
      },
      {
        text: "For x>0, rewrite the equation as a=e^x/x.",
        formulations: ["turn the parameter into the output of one function", "minimize the slope required to reach the exponential"]
      },
      {
        text: "The derivative of e^x/x has the sign of x-1.",
        formulations: ["the ratio falls then rises", "its unique minimum occurs at x=1"]
      },
      {
        text: "For e^{bx}/x, the minimum occurs at x=1/b and equals be.",
        formulations: ["rescale the critical point by b", "the threshold slope scales linearly with b"]
      }
    ],
    canonicalSolution:
      "Because e^x>0, any solution of e^x=ax with a>0 must have x>0. There the equation is a=h(x)=e^x/x. We have h'(x)=e^x(x-1)/x², so h decreases on (0,1), increases on (1,∞), and has unique minimum h(1)=e. Also h(x)→∞ at both endpoints of (0,∞). Hence a<e gives no solution, a=e gives exactly one solution x=1 (a tangency), and a>e gives exactly two solutions. For e^{bx}=a x, minimize h_b(x)=e^{bx}/x; h_b'(x)=e^{bx}(bx-1)/x², so the minimum occurs at x=1/b and equals be. Thus the threshold is a=be.",
    verificationNotes:
      "The x=0 case is not a solution. The two-solution claim for a>e uses continuity plus strict monotonicity on each side of x=1. In the scaled case evaluate e^{b(1/b)}/(1/b)=be.",
    domains: ["functions", "graph-sketching", "calculus", "elementary-analysis", "algebra"],
    contentConcepts: [
      "parameter-dependent-curves",
      "roots-intersections",
      "optimization-extrema",
      "derivative-structure",
      "turning-points-extrema",
      "qualitative-function-behavior",
      "parameter-dependent-algebra",
      "function-transformations"
    ],
    prerequisiteConcepts: ["functions-graphs", "exponentials-logarithms", "differentiation", "algebraic-manipulation"],
    skills: cantorSkills(
      ["precision-checking", "supporting"],
      ["strategic-simplification", "supporting"],
      ["graph-sketching", "primary"],
      ["visualization", "supporting"],
      ["representation-switching", "primary"],
      ["technique", "primary"],
      ["proof-construction", "primary"],
      ["case-analysis", "supporting"],
      ["generalization", "primary"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 4], [13, 21], [10, 18], [3, 6], 21),
    stageTiming: [
      cantorTiming([1, 2], [4, 6], [3, 5], undefined, 6),
      cantorTiming([1, 3], [7, 12], [5, 10], undefined, 12),
      cantorTiming([1, 3], [4, 7], [3, 6], [2, 5], 7)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "low",
    abstraction: "moderate",
    provenance: { originType: "classic-problem", sourceCategory: "secondary-reference" },
    originalityRisk: "high",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-mobius-recurrence",
    title: "A Fractional Recurrence",
    category: "sequences and functions",
    topics: ["sequences","recurrences","functions","algebra"],
    prompt:
      "Let x_0<1 and define x_{n+1}=1/(2-x_n). Explore the sequence numerically for a few starting values, conjecture its long-term behavior, and then find a change of variables that makes the recurrence completely explicit.",
    givenInformation: [],
    approaches: [
      { id: "fixed-point-error-transform", label: "Track a reciprocal of the distance from the fixed point 1" },
      { id: "cobweb-graph", label: "Use the graph of y=1/(2-x) to predict behavior before finding an exact transform" }
    ],
    milestones: [
      {
        id: "small-starts",
        description: "Compute several terms from different x_0<1 and conjecture convergence toward 1.",
        skills: cantorSkills(["small-case-exploration", "primary"], ["conjecture-formation", "supporting"]),
        concepts: ["recurrence-structure", "sequence-convergence"]
      },
      {
        id: "fixed-point-view",
        description: "Identify x=1 as a fixed point and examine how 1-x_{n+1} relates to 1-x_n.",
        skills: cantorSkills(["pattern-recognition", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["continuity-fixed-points", "recurrence-structure"]
      },
      {
        id: "reciprocal-error",
        description: "Set y_n=1/(1-x_n) and derive y_{n+1}=y_n+1.",
        skills: cantorSkills(["representation-switching", "primary"], ["technique", "supporting"]),
        concepts: ["recurrence-structure", "composition-iteration"]
      },
      {
        id: "explicit-form-and-limit",
        description: "Solve the translated recurrence, obtain an exact formula for x_n, and use it to prove monotonicity, boundedness, and convergence to 1 for x_0<1.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "supporting"], ["representation-switching", "supporting"]),
        concepts: ["recurrence-structure", "monotonicity-boundedness", "sequence-convergence"]
      },
      {
        id: "starting-above-one-transfer",
        description: "Classify starting values x_0>1 by tracking when the transformed arithmetic progression reaches the pole, and distinguish failure from eventual convergence.",
        skills: cantorSkills(["case-analysis", "primary"], ["generalization", "primary"], ["precision-checking", "primary"]),
        concepts: ["recurrence-structure", "qualitative-function-behavior", "sequence-convergence"]
      }
    ],
    commonErrors: [
      {
        id: "guess-geometric-error",
        description: "Assumes the error 1-x_n is multiplied by a constant each step; it is not."
      },
      {
        id: "forget-domain-extension",
        description: "Extends the result to x_0>1 without checking whether a future denominator can vanish."
      }
    ],
    followUps: [
      "Can you see the convergence in a cobweb diagram?",
      "What exactly can go wrong when x_0>1?"
    ],
    extensions: [
      {
        id: "starting-above-one",
        prompt: "Classify x_0>1: determine when the recurrence becomes undefined and what happens otherwise."
      },
      {
        id: "shifted-fixed-point",
        prompt: "Construct a similar fractional-linear recurrence with fixed point c whose transformed error increases by 1 each step."
      }
    ],
    hints: [
      {
        text: "Try x_0=0 and x_0=1/2; the sequence seems to approach a simple fixed point.",
        formulations: ["compute a few low-complexity starts", "look for the fixed point suggested by numerics"]
      },
      {
        text: "Compute 1-x_{n+1} exactly rather than x_{n+1}-x_n first.",
        formulations: ["track error from 1", "the fixed-point error has a factorable expression"]
      },
      {
        text: "Taking the reciprocal of 1-x_n turns the recurrence into addition.",
        formulations: ["set y_n=1/(1-x_n)", "reciprocal error linearizes the update"]
      },
      {
        text: "You should obtain y_n=y_0+n, hence x_n=1-1/(y_0+n); for x_0<1 the positivity of y_0 then proves the monotone limit.",
        formulations: ["solve the arithmetic progression and translate back", "the explicit formula settles domain, monotonicity, and convergence together"]
      },
      {
        text: "For x_0>1, y_0<0; the recurrence fails precisely if some transformed term reaches -1 before the next update.",
        formulations: ["audit the pole in the y_n=y_0+n arithmetic progression", "negative-integer transformed starts are the exceptional cases"]
      }
    ],
    canonicalSolution:
      "The fixed point equation x=1/(2-x) gives (x-1)²=0, so 1 is the unique fixed point. Moreover 1-x_{n+1}=1-1/(2-x_n)=(1-x_n)/(2-x_n). Set y_n=1/(1-x_n). Then y_{n+1}=(2-x_n)/(1-x_n)=1+y_n. Hence y_n=y_0+n with y_0=1/(1-x_0)>0, and x_n=1-1/(n+y_0). This is strictly increasing and always below 1, so x_n→1. If x_0>1 then y_0<0; the same formula is valid while defined. The recurrence fails exactly when y_0 is a negative integer, because then some n+y_0 reaches -1 at a term x_n=2 and the next denominator vanishes. Otherwise the orbit remains defined and eventually approaches 1.",
    verificationNotes:
      "For the extension, if y_0=-m with positive integer m, then y_{m-1}=-1 corresponds to x_{m-1}=2 and x_m is undefined. If y_0 is not a negative integer, no iterate equals 2 and the affine y-recurrence remains valid.",
    domains: ["sequences-recurrences", "functions", "elementary-analysis"],
    contentConcepts: [
      "recurrence-structure",
      "sequence-convergence",
      "monotonicity-boundedness",
      "composition-iteration",
      "continuity-fixed-points",
      "qualitative-function-behavior"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "sequences-series", "functions-graphs"],
    skills: cantorSkills(
      ["small-case-exploration", "primary"],
      ["conjecture-formation", "supporting"],
      ["pattern-recognition", "primary"],
      ["strategic-simplification", "supporting"],
      ["representation-switching", "primary"],
      ["technique", "supporting"],
      ["proof-construction", "primary"],
      ["precision-checking", "supporting"],
      ["generalization", "supporting"],
      ["guided-adaptation", "supporting"],
      ["case-analysis", "primary"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [15, 24], [12, 20], [4, 8], 23),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 4], [8, 14], [6, 12], undefined, 14),
      cantorTiming([1, 3], [4, 9], [3, 7], [3, 6], 9)
    ],
    openingRole: "warm-up",
    finalRole: "stretch",
    novelty: "moderate",
    abstraction: "moderate",
    provenance: { originType: "classic-problem", sourceCategory: "secondary-reference" },
    similarityClusterId: "mobius-iteration",
    originalityRisk: "high",
    correctnessRisk: "medium",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-squared-error-recurrence",
    title: "A Quadratic Recurrence",
    category: "sequences and recurrences",
    topics: ["sequences","recurrences","convergence","algebra"],
    prompt:
      "Let 0<x_0<1 and define x_{n+1}=x_n(2-x_n). Explore the first few terms, prove the sequence converges, and then find an exact formula revealing how fast it approaches its limit.",
    givenInformation: [],
    approaches: [
      { id: "difference-and-bound", label: "First prove monotone convergence directly" },
      { id: "error-squaring", label: "Track the error from the fixed point and solve exactly" }
    ],
    milestones: [
      {
        id: "numerical-conjecture",
        description: "Compute examples and conjecture that x_n increases rapidly toward 1.",
        skills: cantorSkills(["small-case-exploration", "primary"], ["conjecture-formation", "supporting"]),
        concepts: ["recurrence-structure", "sequence-convergence"]
      },
      {
        id: "monotone-bounded",
        description: "Show x_{n+1}-x_n=x_n(1-x_n)>0 and that the interval (0,1) is invariant.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "supporting"]),
        concepts: ["monotonicity-boundedness", "recurrence-structure"]
      },
      {
        id: "fixed-point-limit",
        description: "Use convergence and the fixed-point equation to identify the limit as 1.",
        skills: cantorSkills(["proof-construction", "supporting"], ["technique", "supporting"]),
        concepts: ["continuity-fixed-points", "sequence-convergence"]
      },
      {
        id: "error-square-and-exact-rate",
        description: "Discover 1-x_{n+1}=(1-x_n)², iterate it to obtain the exact formula, and interpret the resulting convergence rate.",
        skills: cantorSkills(["pattern-recognition", "primary"], ["strategic-simplification", "primary"], ["representation-switching", "primary"]),
        concepts: ["recurrence-structure", "composition-iteration", "sequence-convergence"]
      },
      {
        id: "basin-and-tolerance-transfer",
        description: "Transfer the error formula to starting values in [0,2] and to quantitative tolerance bounds.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["precision-checking", "supporting"]),
        concepts: ["sequence-convergence", "inequalities-bounds", "recurrence-structure"]
      }
    ],
    commonErrors: [
      {
        id: "fixed-point-zero",
        description: "Finds fixed points 0 and 1 but does not use the initial interval to rule out convergence to 0."
      },
      {
        id: "exponent-n-not-power-two",
        description: "Writes the error as (1-x_0)^{2n} rather than repeatedly squaring to exponent 2^n."
      }
    ],
    followUps: [
      "What happens for 1<x_0<2?",
      "How many iterations are needed to make the error smaller than a specified tolerance?"
    ],
    extensions: [
      {
        id: "basin-zero-two",
        prompt: "Classify all starting values x_0 in [0,2] and determine which converge to 1 and which do not."
      },
      {
        id: "tolerance-bound",
        prompt: "Given 0<x_0<1 and ε>0, derive a bound on n ensuring 1-x_n<ε."
      }
    ],
    hints: [
      {
        text: "Compare x_{n+1} with x_n and test whether the interval (0,1) is preserved.",
        formulations: ["prove the numerical trend before seeking a formula", "look at x_n(1-x_n)"]
      },
      {
        text: "x_{n+1}-x_n=x_n(1-x_n), while 1-x_{n+1} has an even cleaner form.",
        formulations: ["there are two useful difference identities", "the error from 1 simplifies strongly"]
      },
      {
        text: "A monotone bounded sequence has a limit; substitute that limit into L=L(2-L).",
        formulations: ["use the fixed-point equation only after convergence is justified", "the initial interval selects the correct fixed point"]
      },
      {
        text: "Expand 1-x_n(2-x_n), then iterate the perfect-square error identity; repeated squaring produces exponents 1,2,4,8,...",
        formulations: ["derive both the identity and exact rate in one representation", "the error after n steps is the initial error to power 2^n"]
      },
      {
        text: "For 1<x_0<2 the first squared error becomes positive and less than 1; the same exact formula then controls the basin and tolerance questions.",
        formulations: ["extend the error representation rather than restarting the recurrence proof", "check the endpoints 0 and 2 separately"]
      }
    ],
    canonicalSolution:
      "For 0<x_n<1, x_{n+1}-x_n=x_n(1-x_n)>0 and x_{n+1}=1-(1-x_n)²<1, so by induction the sequence is increasing and bounded above by 1. Hence it converges to some L∈(0,1], and L=L(2-L) gives L=0 or 1; monotonicity from x_0>0 rules out 0, so L=1. More strongly, e_n=1-x_n satisfies e_{n+1}=e_n². Thus e_n=e_0^{2^n} and x_n=1-(1-x_0)^{2^n}. If 0<x_0<2, then |1-x_0|<1; after one step the error is nonnegative and thereafter the same argument gives convergence to 1. The endpoints 0 and 2 both lead to 0 rather than 1.",
    verificationNotes:
      "For x_0=2, x_1=0 and the sequence stays 0. For 1<x_0<2, e_0 is negative but e_1=e_0²∈(0,1), so x_1∈(0,1). Exponent is exactly 2^n.",
    domains: ["sequences-recurrences", "functions", "elementary-analysis", "algebra"],
    contentConcepts: [
      "recurrence-structure",
      "sequence-convergence",
      "monotonicity-boundedness",
      "continuity-fixed-points",
      "composition-iteration",
      "inequalities-bounds"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "sequences-series"],
    skills: cantorSkills(
      ["small-case-exploration", "primary"],
      ["conjecture-formation", "supporting"],
      ["proof-construction", "primary"],
      ["precision-checking", "supporting"],
      ["technique", "supporting"],
      ["pattern-recognition", "primary"],
      ["strategic-simplification", "primary"],
      ["representation-switching", "primary"],
      ["generalization", "supporting"],
      ["transfer", "primary"]
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
    provenance: { originType: "classic-problem", sourceCategory: "secondary-reference" },
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  }
];

export const cantorFunctionEntriesA = Object.freeze(cantorFunctionFamiliesA.map(buildCantorEntry));
