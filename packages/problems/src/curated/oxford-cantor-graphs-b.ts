import {
  buildCantorEntry,
  cantorSkills,
  cantorTiming,
  type CantorFamilyAuthoring
} from "./oxford-cantor-authoring.js";

export const cantorGraphFamiliesB: readonly CantorFamilyAuthoring[] = [
  {
    id: "oxford-cantor-absolute-quadratic-crossings",
    title: "How Many Times Does a Folded Quadratic Meet a Line?",
    category: "algebra and graph sketching",
    topics: ["absolute-value graphs", "quadratics", "root counts", "parameter levels"],
    prompt:
      "Sketch y=|(x-1)(x+2)| carefully. For a real number c, classify the number of real solutions of |(x-1)(x+2)|=c. Explain every transition value rather than relying only on the picture.",
    givenInformation: [],
    approaches: [
      { id: "fold-quadratic", label: "Sketch the quadratic first, then reflect its negative part" },
      { id: "two-signed-equations", label: "Solve q(x)=c and q(x)=-c and track discriminants" }
    ],
    milestones: [
      {
        id: "base-quadratic",
        description: "Sketch q(x)=(x-1)(x+2), locating its roots and vertex.",
        skills: cantorSkills(["graph-sketching", "primary"], ["technique", "supporting"]),
        concepts: ["roots-intersections", "turning-points-extrema"]
      },
      {
        id: "fold-negative-arc",
        description: "Construct |q(x)| by reflecting only the portion of q below the x-axis.",
        skills: cantorSkills(["visualization", "primary"], ["representation-switching", "supporting"]),
        concepts: ["function-transformations", "qualitative-function-behavior"]
      },
      {
        id: "inner-cap-height",
        description: "Find the height 9/4 of the reflected inner arch and identify it as the key transition.",
        skills: cantorSkills(["strategic-simplification", "supporting"], ["precision-checking", "supporting"]),
        concepts: ["turning-points-extrema", "roots-intersections"]
      },
      {
        id: "horizontal-level-count",
        description: "Classify the number of intersections for c<0, c=0, 0<c<9/4, c=9/4, and c>9/4.",
        skills: cantorSkills(["case-analysis", "primary"], ["proof-construction", "primary"]),
        concepts: ["roots-intersections", "qualitative-function-behavior"]
      },
      {
        id: "general-root-gap",
        description: "Generalize to |(x-a)(x-b)| with a<b and express the critical level in terms of b-a.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"]),
        concepts: ["parameter-dependent-algebra", "turning-points-extrema", "function-transformations"]
      }
    ],
    commonErrors: [
      {
        id: "reflect-entire-quadratic",
        description: "Reflects the whole quadratic rather than only the portion where it is negative."
      },
      {
        id: "count-tangency-twice",
        description: "Counts the single tangent point on the inner arch as two distinct solutions at c=9/4."
      }
    ],
    followUps: [
      "Could you reproduce the count algebraically without drawing?",
      "How does only the distance between the two original roots control the critical level?"
    ],
    extensions: [
      {
        id: "arbitrary-root-gap",
        prompt: "For a<b, classify the solution count of |(x-a)(x-b)|=c and derive the transition level."
      },
      {
        id: "signed-level-comparison",
        prompt: "Explain the same classification by comparing the discriminants of (x-a)(x-b)=c and (x-a)(x-b)=-c."
      }
    ],
    hints: [
      {
        text: "Start with the unfurled quadratic: its roots are -2 and 1, and its vertex is midway between them.",
        formulations: ["sketch the quadratic before applying absolute value", "find roots and midpoint first"]
      },
      {
        text: "Absolute value reflects exactly the part of the quadratic below the x-axis.",
        formulations: ["fold the negative arc upward", "the outer branches are unchanged"]
      },
      {
        text: "The original vertex is at x=-1/2 with value -9/4, so the reflected arch peaks at 9/4.",
        formulations: ["the inner arch has one maximum", "compute the folded vertex height"]
      },
      {
        text: "Now slide a horizontal line y=c through the picture, treating equality cases separately.",
        formulations: ["count crossings by height regime", "the two transition heights are 0 and 9/4"]
      },
      {
        text: "For roots a<b, the quadratic minimum is -(b-a)²/4.",
        formulations: ["center the roots around their midpoint", "the critical folded height depends on the squared root gap"]
      }
    ],
    canonicalSolution:
      "Let q(x)=(x-1)(x+2)=x²+x-2. Its roots are -2 and 1, and its vertex is at x=-1/2 with value -9/4. Thus |q| keeps the two outer upward branches and reflects the negative arc on (-2,1) upward, producing an inner arch with maximum 9/4. Hence c<0 gives 0 solutions; c=0 gives the two roots; 0<c<9/4 gives two outer intersections and two inner intersections, so 4; c=9/4 gives two outer intersections plus the single top of the arch, so 3; c>9/4 gives only the two outer intersections. For q(x)=(x-a)(x-b), a<b, its vertex is at (a+b)/2 and its minimum is -(b-a)²/4, so the identical classification holds with critical positive level (b-a)²/4.",
    verificationNotes:
      "At c=0 the two roots remain distinct. At the critical positive level the inner equation has a double root at the midpoint but that is one distinct solution. For general a<b, complete the square to verify the minimum exactly.",
    domains: ["algebra", "functions", "graph-sketching"],
    contentConcepts: [
      "roots-intersections",
      "turning-points-extrema",
      "function-transformations",
      "qualitative-function-behavior",
      "parameter-dependent-algebra"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "polynomial-factorization", "functions-graphs"],
    skills: cantorSkills(
      ["graph-sketching", "primary"],
      ["technique", "supporting"],
      ["visualization", "primary"],
      ["representation-switching", "supporting"],
      ["strategic-simplification", "supporting"],
      ["precision-checking", "supporting"],
      ["case-analysis", "primary"],
      ["proof-construction", "primary"],
      ["generalization", "primary"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "warm-up", core: "introductory-plus", ceiling: "standard" },
    timing: cantorTiming([1, 4], [15, 24], [12, 21], [4, 7], 23),
    stageTiming: [
      cantorTiming([1, 2], [4, 7], [3, 6], undefined, 7),
      cantorTiming([1, 4], [7, 12], [6, 10], undefined, 12),
      cantorTiming([2, 4], [5, 9], [4, 7], [3, 5], 9)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "low",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-radical-asymptote",
    title: "A Radical Curve with Unequal Ends",
    category: "functions and elementary analysis",
    topics: ["radical graphs", "asymptotics", "monotonicity", "parameter regimes"],
    prompt:
      "Let -2<a<2 and define R_a(x)=sqrt(x²+a x+1)-x. Sketch R_a as accurately as you can without graphing software: determine its domain, monotonicity, end behavior, and range. Then investigate what changes when a reaches or passes ±2.",
    givenInformation: [],
    approaches: [
      { id: "rationalize-at-infinity", label: "Use conjugates to expose the finite asymptote" },
      { id: "derivative-sign-square", label: "Differentiate and reduce the sign question to a parameter inequality" }
    ],
    milestones: [
      {
        id: "positive-radicand",
        description: "Show x²+a x+1 is positive for every real x when |a|<2.",
        skills: cantorSkills(["technique", "supporting"], ["precision-checking", "primary"]),
        concepts: ["equations-inequalities", "parameter-dependent-algebra"]
      },
      {
        id: "right-end-limit",
        description: "Rationalize R_a(x) to prove the horizontal asymptote a/2 as x→∞.",
        skills: cantorSkills(["strategic-simplification", "primary"], ["representation-switching", "supporting"]),
        concepts: ["asymptotic-behavior", "limiting-arguments"]
      },
      {
        id: "left-end-growth",
        description: "Analyze x→-∞ and show R_a(x) grows without bound, with leading behavior -2x-a/2.",
        skills: cantorSkills(["precision-checking", "supporting"], ["proof-construction", "supporting"]),
        concepts: ["asymptotic-behavior", "qualitative-function-behavior"]
      },
      {
        id: "strict-decrease",
        description: "Prove R_a is strictly decreasing for |a|<2 by controlling the derivative sign.",
        skills: cantorSkills(["technique", "primary"], ["proof-construction", "primary"]),
        concepts: ["derivative-structure", "qualitative-function-behavior"]
      },
      {
        id: "range-and-boundaries",
        description: "Deduce range (a/2,∞) and classify the structural changes at |a|=2 and |a|>2.",
        skills: cantorSkills(["case-analysis", "primary"], ["generalization", "primary"], ["graph-sketching", "supporting"]),
        concepts: ["parameter-dependent-curves", "roots-intersections", "qualitative-function-behavior"]
      }
    ],
    commonErrors: [
      {
        id: "wrong-left-asymptote",
        description: "Treats sqrt(x²+a x+1) as asymptotic to x rather than |x| when x→-∞."
      },
      {
        id: "square-without-sign-check",
        description: "Squares an inequality in the derivative argument without first handling the case 2x+a≤0."
      }
    ],
    followUps: [
      "Why does the right-hand asymptote never get attained when |a|<2?",
      "What do the perfect-square cases a=2 and a=-2 look like exactly?"
    ],
    extensions: [
      {
        id: "boundary-perfect-squares",
        prompt: "Analyze a=±2 exactly and sketch the resulting piecewise-linear radical expressions."
      },
      {
        id: "disconnected-domain",
        prompt: "For |a|>2, find the domain components and describe the behavior near their finite endpoints."
      }
    ],
    hints: [
      {
        text: "The quadratic under the root has discriminant a²-4.",
        formulations: ["start with the radicand before sketching", "the core range |a|<2 gives no real radicand zeros"]
      },
      {
        text: "For x→∞, multiply by the conjugate; the numerator becomes a x+1.",
        formulations: ["rationalization reveals the finite limit", "divide the conjugate expression by x"]
      },
      {
        text: "For x→-∞, remember sqrt(x²) behaves like |x|=-x.",
        formulations: ["the two ends are not symmetric", "factor -x rather than x on the left"]
      },
      {
        text: "R_a'(x)=(2x+a)/(2sqrt(x²+a x+1))-1. If 2x+a>0, compare its square with 4(x²+a x+1).",
        formulations: ["split the derivative sign according to the numerator", "the key comparison reduces to a²<4"]
      },
      {
        text: "At |a|=2 the radicand becomes a perfect square; beyond that it has two real zeros and the domain separates.",
        formulations: ["the parameter boundary is a domain-topology change", "treat equality before the disconnected case"]
      }
    ],
    canonicalSolution:
      "For |a|<2 the radicand q=x²+a x+1 has negative discriminant and positive leading coefficient, so q>0 on R. Rationalizing gives R_a(x)=(a x+1)/(sqrt(q)+x); after dividing numerator and denominator by x for x→∞, the limit is a/2. For x→-∞, sqrt(q)=-x-a/2+o(1), so R_a(x)=-2x-a/2+o(1)→∞. Differentiating gives R_a'=(2x+a)/(2sqrt(q))-1. If 2x+a≤0, this is plainly negative. If 2x+a>0, then (2x+a)²<4q is equivalent to a²<4, so again the first fraction is <1 and R_a'<0. Thus R_a is strictly decreasing from ∞ toward the unattained limit a/2, so its range is (a/2,∞). At a=2, q=(x+1)² and R_2=|x+1|-x; at a=-2, q=(x-1)² and R_{-2}=|x-1|-x. For |a|>2, q has two real roots and the domain is the union of two exterior intervals.",
    verificationNotes:
      "At a=2: R_2=1 for x≥-1 and -2x-1 for x<-1. At a=-2: R_{-2}=1-2x for x<1 and R_{-2}=-1 for x≥1. Keep this exact in review. For |a|>2, domain is x≤r_- or x≥r_+ where r_±=(-a±sqrt(a²-4))/2.",
    domains: ["functions", "graph-sketching", "elementary-analysis", "calculus", "algebra"],
    contentConcepts: [
      "asymptotic-behavior",
      "limiting-arguments",
      "qualitative-function-behavior",
      "derivative-structure",
      "parameter-dependent-curves",
      "roots-intersections",
      "equations-inequalities",
      "parameter-dependent-algebra"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "equations-inequalities", "functions-graphs", "differentiation", "limits-continuity"],
    skills: cantorSkills(
      ["technique", "primary"],
      ["precision-checking", "primary"],
      ["strategic-simplification", "primary"],
      ["representation-switching", "supporting"],
      ["proof-construction", "primary"],
      ["case-analysis", "primary"],
      ["generalization", "primary"],
      ["graph-sketching", "supporting"],
      ["guided-adaptation", "supporting"]
    ),
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "stretch" },
    timing: cantorTiming([3, 7], [23, 35], [18, 31], [6, 11], 31),
    stageTiming: [
      cantorTiming([2, 4], [6, 10], [5, 9], undefined, 10),
      cantorTiming([3, 6], [12, 20], [9, 17], undefined, 20),
      cantorTiming([3, 5], [8, 14], [6, 12], [4, 8], 14)
    ],
    openingRole: "technique-check",
    finalRole: "stretch",
    novelty: "high",
    abstraction: "moderate",
    originalityRisk: "low",
    correctnessRisk: "medium",
    calibrationRisk: "high"
  },
  {
    id: "oxford-cantor-shifted-cubic-intersections",
    title: "Intersecting a Cubic with Its Own Translate",
    category: "functions and algebra",
    topics: ["translated graphs", "cubic differences", "intersection counts", "critical spacing"],
    prompt:
      "Let f(x)=x³-x. For h>0, compare the graphs y=f(x) and y=f(x-h). Determine exactly how many intersection points they have as h varies, identify the transition value, and explain what the small-h intersections approach.",
    givenInformation: [],
    approaches: [
      { id: "difference-factorization", label: "Factor the difference f(x)-f(x-h)" },
      { id: "translation-geometry", label: "Think of sliding the cubic horizontally and then connect the threshold to tangency" }
    ],
    milestones: [
      {
        id: "translated-picture",
        description: "Sketch a cubic and its horizontal translate for a few small and large h values.",
        skills: cantorSkills(["graph-sketching", "primary"], ["conjecture-formation", "supporting"]),
        concepts: ["function-transformations", "roots-intersections"]
      },
      {
        id: "factor-difference",
        description: "Compute f(x)-f(x-h)=h(3x²-3h x+h²-1).",
        skills: cantorSkills(["technique", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["polynomial-structure", "parameter-dependent-algebra"]
      },
      {
        id: "spacing-threshold",
        description: "Use the discriminant to prove two intersections for 0<h<2, one for h=2, and none for h>2.",
        skills: cantorSkills(["case-analysis", "primary"], ["proof-construction", "primary"]),
        concepts: ["roots-intersections", "parameter-dependent-curves"]
      },
      {
        id: "transition-geometry",
        description: "Interpret the h=2 double solution as the moment the translated curves become tangent at their sole intersection.",
        skills: cantorSkills(["representation-switching", "primary"], ["visualization", "supporting"]),
        concepts: ["turning-points-extrema", "roots-intersections"]
      },
      {
        id: "small-shift-limit",
        description: "Show the two intersection x-coordinates approach ±1/sqrt(3) as h→0+ and relate these to f'(x)=0.",
        skills: cantorSkills(["precision-checking", "supporting"], ["generalization", "primary"]),
        concepts: ["limiting-arguments", "derivative-structure", "turning-points-extrema"]
      }
    ],
    commonErrors: [
      {
        id: "forget-positive-h-factor",
        description: "Cancels h without noting the problem assumes h>0."
      },
      {
        id: "wrong-small-h-centers",
        description: "Assumes intersections approach the zeros of f rather than the stationary points of f."
      }
    ],
    followUps: [
      "Why should stationary points emerge from comparing a function to a very small translate?",
      "What is the analogous threshold for f(x)=x³-cx?"
    ],
    extensions: [
      {
        id: "scaled-cubic-translate",
        prompt: "For c>0 and f_c(x)=x³-cx, classify intersections with f_c(x-h) and find the critical h."
      },
      {
        id: "difference-quotient-link",
        prompt: "Divide the intersection equation by h and explain how the h→0 limit becomes a derivative condition."
      }
    ],
    hints: [
      {
        text: "The second graph is the first shifted h units to the right.",
        formulations: ["sketch a few translations first", "look for a critical horizontal separation"]
      },
      {
        text: "Expand only the difference f(x)-f(x-h); the cubic terms cancel.",
        formulations: ["two cubics reduce to a quadratic intersection equation", "factor out h after cancellation"]
      },
      {
        text: "The remaining quadratic has discriminant 3(4-h²).",
        formulations: ["intersection count is controlled by one discriminant", "the transition occurs at h=2"]
      },
      {
        text: "At h=2 the quadratic has a double root; compare the slopes of the two cubic graphs there.",
        formulations: ["double intersection means tangency here", "verify equal derivatives at the merger point"]
      },
      {
        text: "For the small-shift limit, divide the difference by h before letting h shrink.",
        formulations: ["a finite difference becomes a derivative", "solve the quadratic roots or use difference-quotient intuition"]
      }
    ],
    canonicalSolution:
      "Intersections satisfy f(x)=f(x-h). Expanding gives f(x)-f(x-h)=h(3x²-3h x+h²-1). Since h>0, the intersection equation is 3x²-3h x+h²-1=0, whose discriminant is 9h²-12(h²-1)=3(4-h²). Therefore 0<h<2 gives two distinct intersections, h=2 gives one double intersection, and h>2 gives none. At h=2 the root is x=1, and f'(1)=2=f'(-1)=f'(1-2), so the two translated curves are tangent there. The roots are x=(3h±sqrt(12-3h²))/6, which approach ±1/sqrt(3) as h→0+, exactly the stationary points of f because f'(x)=3x²-1. For f_c=x³-cx, the same calculation gives h(3x²-3h x+h²-c), so the threshold is h=2sqrt(c).",
    verificationNotes:
      "At h=2 the common point uses arguments x=1 and x-h=-1; both derivatives are 2. Small-h root limits from the exact formula are ±sqrt(12)/6=±1/sqrt(3).",
    domains: ["functions", "graph-sketching", "algebra", "calculus", "elementary-analysis"],
    contentConcepts: [
      "function-transformations",
      "roots-intersections",
      "polynomial-structure",
      "parameter-dependent-algebra",
      "parameter-dependent-curves",
      "turning-points-extrema",
      "derivative-structure",
      "limiting-arguments"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "polynomial-factorization", "functions-graphs", "differentiation"],
    skills: cantorSkills(
      ["graph-sketching", "primary"],
      ["conjecture-formation", "supporting"],
      ["technique", "primary"],
      ["strategic-simplification", "supporting"],
      ["case-analysis", "primary"],
      ["proof-construction", "primary"],
      ["representation-switching", "primary"],
      ["visualization", "supporting"],
      ["generalization", "primary"],
      ["precision-checking", "supporting"]
    ),
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "stretch" },
    timing: cantorTiming([3, 6], [21, 33], [17, 29], [5, 10], 30),
    stageTiming: [
      cantorTiming([2, 4], [6, 9], [5, 8], undefined, 9),
      cantorTiming([2, 5], [10, 17], [8, 15], undefined, 17),
      cantorTiming([2, 5], [7, 13], [5, 11], [4, 8], 13)
    ],
    openingRole: "warm-up",
    finalRole: "stretch",
    novelty: "high",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "high"
  },
  {
    id: "oxford-cantor-moving-integral-window",
    title: "Area in a Window that Moves and Stretches",
    category: "calculus and functions",
    topics: ["variable-limit integrals", "symmetry", "optimization", "asymptotics"],
    prompt:
      "Define W(x)=∫_x^{2x} 1/(1+t²) dt for real x. Sketch W without evaluating an antiderivative: determine its symmetry, sign, turning points, and end behavior. Then replace 2 by a parameter k>1.",
    givenInformation: [
      "You may use the Fundamental Theorem of Calculus for differentiating variable-limit integrals."
    ],
    approaches: [
      { id: "moving-window-geometry", label: "Interpret W as signed area over a moving interval" },
      { id: "leibniz-derivative", label: "Differentiate the endpoints directly and analyze the rational derivative" }
    ],
    milestones: [
      {
        id: "odd-symmetry",
        description: "Use the even integrand and orientation of the integral to prove W is odd.",
        skills: cantorSkills(["pattern-recognition", "supporting"], ["proof-construction", "supporting"]),
        concepts: ["symmetry-periodicity", "integral-accumulation"]
      },
      {
        id: "sign-from-window",
        description: "Show W(x)>0 for x>0, W(0)=0, and W(x)<0 for x<0.",
        skills: cantorSkills(["visualization", "supporting"], ["precision-checking", "supporting"]),
        concepts: ["integral-accumulation", "qualitative-function-behavior"]
      },
      {
        id: "differentiate-window",
        description: "Derive W'(x)=2/(1+4x²)-1/(1+x²) and reduce its sign to 1-2x².",
        skills: cantorSkills(["technique", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["derivative-structure", "turning-points-extrema"]
      },
      {
        id: "end-limit-without-arctan",
        description: "Prove W(x)→0 as x→∞ using comparison rather than an antiderivative.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "supporting"]),
        concepts: ["limiting-arguments", "integral-accumulation"]
      },
      {
        id: "parameter-k",
        description: "For W_k(x)=∫_x^{kx}1/(1+t²)dt, find the positive maximum at x=1/sqrt(k) and explain its movement with k.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["graph-sketching", "supporting"]),
        concepts: ["parameter-dependent-curves", "optimization-extrema", "derivative-structure"]
      }
    ],
    commonErrors: [
      {
        id: "even-function-guess",
        description: "Sees an even integrand and incorrectly concludes W is even, ignoring the reversed interval for negative x."
      },
      {
        id: "chain-factor-missing",
        description: "Differentiates the upper endpoint contribution as 1/(1+4x²) rather than 2/(1+4x²)."
      }
    ],
    followUps: [
      "Can you prove the limit at infinity by a one-line comparison?",
      "How does the maximizing x depend on k, and is that direction intuitive from the moving interval?"
    ],
    extensions: [
      {
        id: "general-window-factor",
        prompt: "For k>1, fully classify the turning points of W_k and derive the positive maximizer."
      },
      {
        id: "maximum-value-behavior",
        prompt: "Without needing a closed form, investigate qualitatively how the maximum value changes as k→1+ and as k→∞."
      }
    ],
    hints: [
      {
        text: "Compare W(-x) with W(x) by substituting t=-u and using that the integrand is even.",
        formulations: ["the integration orientation matters", "the moving-window function is odd, not even"]
      },
      {
        text: "For x>0 the interval [x,2x] has positive orientation and the integrand is positive.",
        formulations: ["the sign is visible geometrically", "interpret it as area"]
      },
      {
        text: "Differentiate both moving endpoints: W'(x)=2f(2x)-f(x).",
        formulations: ["remember the chain factor from 2x", "apply FTC to both endpoints"]
      },
      {
        text: "For large x>0, 0<W(x)≤∫_x^{2x}1/t² dt=1/(2x).",
        formulations: ["compare with 1/t²", "avoid evaluating arctangent"]
      },
      {
        text: "For W_k, the derivative numerator factors as (k-1)(1-kx²).",
        formulations: ["put the derivative over a common denominator", "the positive critical point is 1/sqrt(k)"]
      }
    ],
    canonicalSolution:
      "Let f(t)=1/(1+t²), which is even and positive. A change of variables shows W(-x)=-W(x), so W is odd; in particular it is positive for x>0. By FTC, W'(x)=2/(1+4x²)-1/(1+x²)=(1-2x²)/((1+4x²)(1+x²)). Hence on x>0 it increases until x=1/sqrt(2) and then decreases. Also 0<W(x)≤∫_x^{2x}t^{-2}dt=1/(2x) for x>0, so W(x)→0 as x→∞; oddness gives the left end. For k>1, W_k'(x)=k/(1+k²x²)-1/(1+x²)=((k-1)(1-kx²))/((1+k²x²)(1+x²)), so the unique positive maximizer is x=1/sqrt(k), with a symmetric negative minimum.",
    verificationNotes:
      "The comparison 1/(1+t²)≤1/t² is valid for t>0, which is all that is needed for x→∞. For W_k, check the numerator expansion: k+kx²-1-k²x²=(k-1)(1-kx²).",
    domains: ["calculus", "functions", "graph-sketching", "elementary-analysis"],
    contentConcepts: [
      "integral-accumulation",
      "symmetry-periodicity",
      "qualitative-function-behavior",
      "derivative-structure",
      "turning-points-extrema",
      "limiting-arguments",
      "parameter-dependent-curves",
      "optimization-extrema"
    ],
    prerequisiteConcepts: ["integration", "differentiation", "functions-graphs", "limits-continuity"],
    skills: cantorSkills(
      ["pattern-recognition", "supporting"],
      ["proof-construction", "primary"],
      ["visualization", "supporting"],
      ["precision-checking", "supporting"],
      ["technique", "primary"],
      ["strategic-simplification", "supporting"],
      ["generalization", "primary"],
      ["transfer", "primary"],
      ["graph-sketching", "supporting"]
    ),
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 6], [20, 31], [15, 27], [5, 9], 29),
    stageTiming: [
      cantorTiming([1, 4], [6, 9], [5, 8], undefined, 9),
      cantorTiming([2, 5], [9, 16], [7, 14], undefined, 16),
      cantorTiming([2, 4], [7, 12], [5, 10], [4, 7], 12)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "high",
    abstraction: "moderate",
    originalityRisk: "low",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-reciprocal-implicit-curve",
    title: "A Circle Hidden in an Implicit Curve",
    category: "graph sketching and coordinate geometry",
    topics: ["implicit curves", "reciprocal substitution", "asymptotes", "optimization"],
    prompt:
      "Sketch the real curve x²y²=x²+y² as completely as possible. Your sketch should include where the curve can exist, its symmetries, asymptotes, and the points on it closest to the origin. Find a representation that makes the geometry simpler.",
    givenInformation: [],
    approaches: [
      { id: "reciprocal-coordinates", label: "Use u=1/x and v=1/y to reveal a unit circle" },
      { id: "solve-for-y-squared", label: "Solve for y² to discover domain and asymptotes directly" }
    ],
    milestones: [
      {
        id: "exclude-axes-and-symmetry",
        description: "Identify (0,0) as an isolated solution; then show every other point has x and y nonzero and record the sign-change and coordinate-swap symmetries.",
        skills: cantorSkills(["precision-checking", "primary"], ["visualization", "supporting"]),
        concepts: ["analytic-curve-geometry", "symmetry-periodicity"]
      },
      {
        id: "reciprocal-circle",
        description: "Divide by x²y² and transform the equation into 1/x²+1/y²=1.",
        skills: cantorSkills(["representation-switching", "primary"], ["strategic-simplification", "primary"]),
        concepts: ["analytic-curve-geometry", "loci-coordinate-constraints"]
      },
      {
        id: "branch-domain",
        description: "Derive y²=x²/(x²-1), hence |x|>1 and by symmetry |y|>1.",
        skills: cantorSkills(["proof-construction", "supporting"], ["case-analysis", "supporting"]),
        concepts: ["roots-intersections", "qualitative-function-behavior"]
      },
      {
        id: "asymptotes-and-branches",
        description: "Prove the four branches approach x=±1 and y=±1 appropriately and produce a justified sketch.",
        skills: cantorSkills(["graph-sketching", "primary"], ["proof-construction", "primary"]),
        concepts: ["asymptotic-behavior", "qualitative-function-behavior"]
      },
      {
        id: "closest-points",
        description: "Minimize x²+y² subject to 1/x²+1/y²=1 and find the four closest points (±sqrt(2),±sqrt(2)).",
        skills: cantorSkills(["strategic-simplification", "supporting"], ["proof-construction", "primary"], ["generalization", "supporting"]),
        concepts: ["inequalities-bounds", "analytic-curve-geometry"]
      }
    ],
    commonErrors: [
      {
        id: "include-axis-points",
        description: "Divides by x²y² without first checking that x=0 or y=0 cannot satisfy the original equation."
      },
      {
        id: "circle-in-original-plane",
        description: "Concludes the original curve itself is a circle rather than recognizing the circle lives in reciprocal coordinates."
      }
    ],
    followUps: [
      "How do points near the coordinate axes of the reciprocal circle correspond to asymptotic behavior of the original curve?",
      "What changes in x²y²=c(x²+y²) for c>0?"
    ],
    extensions: [
      {
        id: "scaled-implicit-family",
        prompt: "For c>0, analyze x²y²=c(x²+y²), including asymptotes and closest points."
      },
      {
        id: "reciprocal-circle-parametrization",
        prompt: "Use u=cos θ, v=sin θ to parametrize branches of the original curve and interpret excluded values."
      }
    ],
    hints: [
      {
        text: "First test whether x=0 or y=0 is possible; then record the sign and swap symmetries.",
        formulations: ["justify division before using reciprocals", "the equation is even in each coordinate"]
      },
      {
        text: "Divide the equation by x²y².",
        formulations: ["reciprocal squares simplify the product", "look for a familiar locus in new coordinates"]
      },
      {
        text: "Solving for y² gives y²=x²/(x²-1), so the denominator must be positive.",
        formulations: ["the branches live only outside |x|=1", "domain information gives vertical asymptotes"]
      },
      {
        text: "As |x|→∞, y²→1; as |x|→1+ the magnitude of y diverges.",
        formulations: ["find horizontal and vertical asymptotes from the solved form", "use symmetry for all four branches"]
      },
      {
        text: "Let A=x² and B=y². From 1/A+1/B=1, show A+B≥4.",
        formulations: ["reduce closest-distance to a positive-variable inequality", "equality occurs when A=B=2"]
      }
    ],
    canonicalSolution:
      "If x=0 then the equation forces y=0, but (0,0) satisfies both sides; however dividing by x²y² would lose it. Thus the original curve consists of the isolated origin together with nonzero branches. For nonzero points, divide to get 1/x²+1/y²=1. Solving gives y²=x²/(x²-1), so |x|>1 and similarly |y|>1. The equation is invariant under independent sign changes and swapping x,y, giving four symmetric branches. As |x|→1+ we have |y|→∞, so x=±1 are vertical asymptotes; as |x|→∞, |y|→1, so y=±1 are horizontal asymptotes. For nonzero points let A=x²,B=y²; then 1/A+1/B=1, so A+B=AB and by (A+B)²≥4AB=4(A+B), A+B≥4. Equality gives A=B=2, hence four closest nonzero branch points (±sqrt(2),±sqrt(2)) at distance 2 from the origin. But globally the isolated origin itself is of course the closest point. For c>0, the nonzero reciprocal equation becomes c/x²+c/y²=1, giving asymptotes ±sqrt(c) and branch closest points with x²=y²=2c.",
    verificationNotes:
      "Important correction to the tempting reciprocal-only analysis: (0,0) DOES satisfy the original equation and is an isolated component. The prompt asks points closest to the origin; therefore the absolute closest point is the origin itself. The four sqrt(2) points are the closest points on the nonzero branches. Preserve this distinction in review and candidate prompting.",
    domains: ["graph-sketching", "coordinate-geometry", "functions", "algebra", "elementary-analysis"],
    contentConcepts: [
      "analytic-curve-geometry",
      "symmetry-periodicity",
      "loci-coordinate-constraints",
      "roots-intersections",
      "qualitative-function-behavior",
      "asymptotic-behavior",
      "inequalities-bounds"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "equations-inequalities", "coordinate-geometry-basics", "functions-graphs"],
    skills: cantorSkills(
      ["precision-checking", "primary"],
      ["visualization", "supporting"],
      ["representation-switching", "primary"],
      ["strategic-simplification", "primary"],
      ["proof-construction", "primary"],
      ["case-analysis", "supporting"],
      ["graph-sketching", "primary"],
      ["generalization", "supporting"],
      ["error-recovery", "supporting"]
    ),
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "stretch" },
    timing: cantorTiming([3, 7], [22, 34], [17, 30], [5, 10], 30),
    stageTiming: [
      cantorTiming([2, 4], [6, 10], [5, 9], undefined, 10),
      cantorTiming([3, 6], [11, 19], [8, 16], undefined, 19),
      cantorTiming([2, 5], [7, 13], [5, 11], [4, 8], 13)
    ],
    openingRole: "warm-up",
    finalRole: "stretch",
    novelty: "high",
    abstraction: "high",
    originalityRisk: "low",
    correctnessRisk: "medium",
    calibrationRisk: "high"
  }
];

export const cantorGraphEntriesB = Object.freeze(cantorGraphFamiliesB.map(buildCantorEntry));
