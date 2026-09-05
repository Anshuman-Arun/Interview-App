import {
  buildCantorEntry,
  cantorSkills,
  cantorTiming,
  type CantorFamilyAuthoring
} from "./oxford-cantor-authoring.js";

export const cantorFunctionFamiliesA: readonly CantorFamilyAuthoring[] = [
  {
    id: "oxford-cantor-reciprocal-paired-inputs",
    title: "A Function that Pairs Reciprocal Inputs",
    category: "functions and graph sketching",
    topics: ["reciprocal symmetry", "inverse branches", "range", "generalization"],
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
    timing: cantorTiming([2, 5], [18, 28], [14, 24], [4, 8], 26),
    stageTiming: [
      cantorTiming([1, 3], [5, 8], [4, 7], undefined, 8),
      cantorTiming([2, 4], [9, 15], [7, 12], undefined, 15),
      cantorTiming([2, 4], [6, 10], [5, 8], [3, 6], 10)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-tangent-intersection-locus",
    title: "Where Two Parabola Tangents Meet",
    category: "calculus and coordinate geometry",
    topics: ["tangent lines", "moving intersections", "loci", "parameter generalization"],
    prompt:
      "On the parabola y=x², take the tangent at x=u and the tangent at x=u+1. As u varies, their intersection moves. Determine and sketch the locus of that intersection. Then replace the separation 1 by a fixed positive separation h.",
    givenInformation: [],
    approaches: [
      { id: "line-equations", label: "Write both tangent equations and eliminate u" },
      { id: "midpoint-structure", label: "First discover where the x-coordinate of two tangent intersections lies relative to their contact points" }
    ],
    milestones: [
      {
        id: "tangent-at-u",
        description: "Write the tangent line to y=x² at a general point u.",
        skills: cantorSkills(["technique", "primary"], ["precision-checking", "supporting"]),
        concepts: ["derivative-structure", "analytic-curve-geometry"]
      },
      {
        id: "intersect-two-tangents",
        description: "Solve for the intersection of tangents at u and v and notice its x-coordinate is (u+v)/2.",
        skills: cantorSkills(["strategic-simplification", "supporting"], ["representation-switching", "primary"]),
        concepts: ["loci-coordinate-constraints", "equations-inequalities"]
      },
      {
        id: "fixed-gap-coordinates",
        description: "Set v=u+1 and express the moving intersection coordinates in terms of u.",
        skills: cantorSkills(["technique", "supporting"], ["pattern-recognition", "supporting"]),
        concepts: ["parameter-dependent-curves", "loci-coordinate-constraints"]
      },
      {
        id: "eliminate-parameter",
        description: "Eliminate u and prove the locus is y=x²-1/4.",
        skills: cantorSkills(["proof-construction", "primary"], ["graph-sketching", "primary"]),
        concepts: ["analytic-curve-geometry", "parameter-dependent-curves"]
      },
      {
        id: "general-gap",
        description: "For gap h, derive y=x²-h²/4 and explain the geometric effect of increasing h.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["visualization", "supporting"]),
        concepts: ["parameter-dependent-curves", "function-transformations"]
      }
    ],
    commonErrors: [
      {
        id: "wrong-tangent-constant",
        description: "Writes y=2ux+u² instead of y=2ux-u²."
      },
      {
        id: "locus-only-inclusion",
        description: "Shows every generated intersection lies on the proposed parabola but does not check every point of that parabola is reached by some u."
      }
    ],
    followUps: [
      "Why is the intersection x-coordinate always the midpoint of the contact x-coordinates?",
      "How is the locus related to the original parabola as h varies?"
    ],
    extensions: [
      {
        id: "arbitrary-gap",
        prompt: "For tangency points u and u+h with fixed h>0, derive the entire intersection locus and prove it is fully attained."
      },
      {
        id: "scaled-parabola",
        prompt: "Repeat the calculation for y=cx² with c>0 and describe how the locus changes."
      }
    ],
    hints: [
      {
        text: "The tangent at x=u is y=2ux-u².",
        formulations: ["differentiate and use point-slope form", "the tangent line has slope 2u"]
      },
      {
        text: "For tangents at u and v, subtract the two line equations before solving fully.",
        formulations: ["the intersection x-coordinate simplifies first", "factor u-v after equating the lines"]
      },
      {
        text: "The intersection of tangents at u and v is ((u+v)/2, uv).",
        formulations: ["the coordinates have midpoint-product form", "use v=u+1 after obtaining the symmetric formula"]
      },
      {
        text: "With v=u+1, set X=u+1/2 and rewrite u(u+1) in terms of X.",
        formulations: ["complete the square in the parameter", "eliminate u through the midpoint coordinate"]
      },
      {
        text: "For separation h, use X=u+h/2 and u(u+h)=X²-h²/4.",
        formulations: ["the gap creates a vertical shift of h²/4", "generalize the completed-square identity"]
      }
    ],
    canonicalSolution:
      "The tangent at u is y=2ux-u². For tangents at u and v, equality gives 2(u-v)x=(u-v)(u+v), so for u≠v their intersection has X=(u+v)/2. Substituting back gives Y=uv. With v=u+1, X=u+1/2 and Y=u(u+1)=(u+1/2)²-1/4=X²-1/4. Since u ranges over all reals, X does too, so the full locus is y=x²-1/4. For a fixed gap h>0, X=u+h/2 and Y=u(u+h)=X²-h²/4, so increasing h shifts the locus downward by h²/4. For y=cx², the same derivation gives Y=cX²-c h²/4.",
    verificationNotes:
      "The u=v cancellation is not used in the fixed positive gap case, but mention it if deriving the symmetric formula. Prove surjectivity onto the locus via X=u+h/2 ranging over all real numbers.",
    domains: ["calculus", "coordinate-geometry", "graph-sketching", "functions", "algebra"],
    contentConcepts: [
      "derivative-structure",
      "loci-coordinate-constraints",
      "analytic-curve-geometry",
      "parameter-dependent-curves",
      "function-transformations",
      "equations-inequalities"
    ],
    prerequisiteConcepts: ["differentiation", "coordinate-geometry-basics", "algebraic-manipulation", "functions-graphs"],
    skills: cantorSkills(
      ["technique", "primary"],
      ["precision-checking", "supporting"],
      ["strategic-simplification", "supporting"],
      ["representation-switching", "primary"],
      ["pattern-recognition", "supporting"],
      ["proof-construction", "primary"],
      ["graph-sketching", "primary"],
      ["generalization", "primary"],
      ["transfer", "primary"],
      ["visualization", "supporting"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [17, 27], [14, 24], [4, 8], 26),
    stageTiming: [
      cantorTiming([1, 3], [5, 8], [4, 7], undefined, 8),
      cantorTiming([2, 4], [8, 14], [7, 12], undefined, 14),
      cantorTiming([2, 4], [6, 10], [5, 8], [3, 6], 10)
    ],
    openingRole: "technique-check",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "moderate",
    originalityRisk: "high",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-exponential-rotating-line",
    title: "When an Exponential Meets a Rotating Line",
    category: "functions and calculus",
    topics: ["exponential graphs", "parameter root counts", "tangency", "scaling"],
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
    timing: cantorTiming([2, 5], [17, 27], [13, 24], [4, 8], 25),
    stageTiming: [
      cantorTiming([1, 3], [5, 8], [4, 7], undefined, 8),
      cantorTiming([2, 4], [8, 14], [6, 12], undefined, 14),
      cantorTiming([2, 4], [6, 10], [5, 8], [3, 6], 10)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "low",
    abstraction: "moderate",
    originalityRisk: "high",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-mobius-recurrence",
    title: "A Recurrence Hidden Inside a Translation",
    category: "sequences and functions",
    topics: ["fractional-linear recurrence", "fixed points", "convergence", "change of variables"],
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
        id: "explicit-form",
        description: "Solve the translated recurrence and obtain an exact formula for x_n.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "supporting"]),
        concepts: ["recurrence-structure", "sequence-convergence"]
      },
      {
        id: "monotone-limit",
        description: "Use the explicit form to prove monotonicity, boundedness, and convergence to 1 for x_0<1.",
        skills: cantorSkills(["proof-construction", "primary"], ["generalization", "supporting"]),
        concepts: ["monotonicity-boundedness", "sequence-convergence"]
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
        text: "You should obtain y_n=y_0+n, hence x_n=1-1/(y_0+n).",
        formulations: ["solve the arithmetic progression", "translate the explicit y_n formula back"]
      },
      {
        text: "For x_0<1, y_0>0, so the denominator y_0+n grows steadily and never vanishes.",
        formulations: ["positivity makes the domain and monotonicity transparent", "the explicit formula proves the limit"]
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
      "continuity-fixed-points"
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
      ["guided-adaptation", "supporting"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([3, 6], [19, 30], [15, 26], [5, 9], 28),
    stageTiming: [
      cantorTiming([2, 4], [6, 9], [5, 8], undefined, 9),
      cantorTiming([2, 5], [9, 16], [7, 14], undefined, 16),
      cantorTiming([2, 4], [7, 12], [5, 10], [4, 7], 12)
    ],
    openingRole: "warm-up",
    finalRole: "stretch",
    novelty: "high",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "medium",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-squared-error-recurrence",
    title: "A Recurrence that Squares Its Own Error",
    category: "sequences and recurrences",
    topics: ["nonlinear recurrence", "convergence", "error transformation", "rapid convergence"],
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
        id: "square-the-error",
        description: "Discover and prove 1-x_{n+1}=(1-x_n)².",
        skills: cantorSkills(["pattern-recognition", "primary"], ["strategic-simplification", "primary"]),
        concepts: ["recurrence-structure", "composition-iteration"]
      },
      {
        id: "exact-rate",
        description: "Iterate the error identity to obtain x_n=1-(1-x_0)^{2^n} and interpret the double-exponential exponent.",
        skills: cantorSkills(["representation-switching", "primary"], ["generalization", "supporting"]),
        concepts: ["sequence-convergence", "recurrence-structure"]
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
        text: "Expand 1-x_n(2-x_n).",
        formulations: ["the error is a perfect square", "1-x_{n+1}=(1-x_n)²"]
      },
      {
        text: "Repeated squaring produces exponents 1,2,4,8,...",
        formulations: ["the error after n steps is the initial error to power 2^n", "translate back from the error sequence"]
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
      "composition-iteration"
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
      ["generalization", "supporting"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [17, 27], [13, 23], [4, 8], 25),
    stageTiming: [
      cantorTiming([1, 3], [5, 8], [4, 7], undefined, 8),
      cantorTiming([2, 4], [8, 14], [6, 12], undefined, 14),
      cantorTiming([2, 4], [6, 10], [5, 8], [3, 6], 10)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  }
];

export const cantorFunctionEntriesA = Object.freeze(cantorFunctionFamiliesA.map(buildCantorEntry));
