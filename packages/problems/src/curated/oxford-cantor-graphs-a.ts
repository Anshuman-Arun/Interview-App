import {
  buildCantorEntry,
  cantorSkills,
  cantorTiming,
  type CantorFamilyAuthoring
} from "./oxford-cantor-authoring.js";

export const cantorGraphFamiliesA: readonly CantorFamilyAuthoring[] = [
  {
    id: "oxford-cantor-moving-v-envelope",
    title: "A Family of Moving V-Shapes",
    category: "functions and graph sketching",
    topics: ["functions","graphs","absolute value","parameters"],
    prompt:
      "For each real number t, let g_t(x)=|x-t|+t². First sketch several members of this family. Then, for each fixed x, define m(x) to be the smallest value of g_t(x) as t varies over all real numbers. Determine and sketch m(x), and explain why its formula changes where it does.",
    givenInformation: [
      "You may minimize a quadratic by completing the square; differentiation is not required."
    ],
    approaches: [
      { id: "split-by-absolute-value", label: "Split according to whether t is to the left or right of x" },
      { id: "moving-vertex-picture", label: "Use the geometry of a moving V-shape and then justify it algebraically" }
    ],
    milestones: [
      {
        id: "sample-v-shapes",
        description: "Sketch representative g_t and identify how the vertex location and height depend on t.",
        skills: cantorSkills(["graph-sketching", "primary"], ["visualization", "supporting"]),
        concepts: ["parameter-dependent-curves", "function-transformations"]
      },
      {
        id: "fix-x-switch-variable",
        description: "For fixed x, treat t rather than x as the variable being optimized.",
        skills: cantorSkills(["representation-switching", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["optimization-extrema", "parameter-dependent-curves"]
      },
      {
        id: "left-right-quadratics",
        description: "Split t≤x and t≥x and complete the square in each region.",
        skills: cantorSkills(["case-analysis", "primary"], ["technique", "supporting"]),
        concepts: ["equations-inequalities", "optimization-extrema"]
      },
      {
        id: "validity-and-envelope",
        description: "Check branch feasibility for the unconstrained minimizers, assemble the three-piece lower envelope, and justify that no other t can do better.",
        skills: cantorSkills(["precision-checking", "primary"], ["proof-construction", "primary"], ["graph-sketching", "supporting"]),
        concepts: ["optimization-extrema", "qualitative-function-behavior", "function-transformations"]
      },
      {
        id: "scaled-penalty-transfer",
        description: "Transfer the same optimizer-feasibility argument to |x-t|+λt² for λ>0 and analyze how the switch points and joins move.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["graph-sketching", "supporting"]),
        concepts: ["parameter-dependent-curves", "function-transformations", "optimization-extrema"]
      }
    ],
    commonErrors: [
      {
        id: "ignore-region-constraint",
        description: "Uses t=±1/2 as a minimizer for every x without checking whether that t lies in the branch being minimized."
      },
      {
        id: "minimize-in-wrong-variable",
        description: "Differentiates or sketches in x while forgetting that m(x) fixes x and varies t."
      }
    ],
    followUps: [
      "Is m differentiable where its formula changes?",
      "What changes if t² is replaced by λt² with λ>0?"
    ],
    extensions: [
      {
        id: "scaled-penalty",
        prompt: "Replace t² by λt² for λ>0. Determine the new switch points and lower envelope."
      },
      {
        id: "smooth-join-check",
        prompt: "Determine whether the resulting lower envelope is continuous and differentiable at every switch point, and explain geometrically why."
      }
    ],
    hints: [
      {
        text: "Start by marking the vertex of g_t: it is at x=t and has height t².",
        formulations: ["track each V-shape vertex", "the parameter controls both horizontal position and vertex height"]
      },
      {
        text: "For a fixed x, the question is now an optimization problem in t.",
        formulations: ["freeze x and vary t", "switch which symbol you regard as the variable"]
      },
      {
        text: "When t≤x, write x-t+t²; when t≥x, write t-x+t².",
        formulations: ["split the absolute value according to t versus x", "there are two quadratic expressions in t"]
      },
      {
        text: "The two completed squares prefer t=1/2 and t=-1/2, but each preference is only valid on the correct side of x; use the boundary t=x when it is not.",
        formulations: ["check branch feasibility of ±1/2 and then assemble the envelope", "an unconstrained minimum may fall outside its branch"]
      },
      {
        text: "For λt², the branch minimizers scale to ±1/(2λ); repeat the same feasibility check before joining the pieces.",
        formulations: ["the switch points move like 1/λ", "reuse the parameter-optimization mechanism rather than starting over"]
      }
    ],
    canonicalSolution:
      "Fix x. If t≤x, then g_t(x)=x-t+t²=(t-1/2)²+x-1/4. Its unconstrained minimum occurs at t=1/2, which is allowed exactly when x≥1/2; otherwise the minimum on t≤x occurs at the boundary t=x and equals x². If t≥x, then g_t(x)=t-x+t²=(t+1/2)²-x-1/4. Its unconstrained minimum occurs at t=-1/2, allowed exactly when x≤-1/2; otherwise the boundary t=x again gives x². Hence m(x)=-x-1/4 for x≤-1/2, m(x)=x² for |x|≤1/2, and m(x)=x-1/4 for x≥1/2. The values and first derivatives match at ±1/2. For λt² the same argument gives switch points ±1/(2λ), central piece λx², and outer pieces |x|-1/(4λ).",
    verificationNotes:
      "Check branch feasibility before choosing t=±1/2. At x=±1/2 the adjacent formulas agree and have matching slopes. For λ>0, verify the completed-square constants and switch points scale by 1/λ.",
    domains: ["functions", "graph-sketching", "calculus", "algebra"],
    contentConcepts: [
      "parameter-dependent-curves",
      "function-transformations",
      "qualitative-function-behavior",
      "optimization-extrema",
      "equations-inequalities"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "equations-inequalities", "functions-graphs"],
    skills: cantorSkills(
      ["graph-sketching", "primary"],
      ["visualization", "supporting"],
      ["representation-switching", "primary"],
      ["strategic-simplification", "supporting"],
      ["case-analysis", "primary"],
      ["technique", "supporting"],
      ["precision-checking", "primary"],
      ["proof-construction", "primary"],
      ["generalization", "supporting"],
      ["guided-adaptation", "supporting"],
      ["transfer", "supporting"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [15, 24], [12, 20], [4, 8], 24),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 5], [8, 14], [6, 12], undefined, 14),
      cantorTiming([1, 3], [4, 8], [3, 7], [3, 6], 8)
    ],
    openingRole: "warm-up",
    finalRole: "transfer",
    novelty: "moderate",
    abstraction: "moderate",
    similarityClusterId: "parameter-envelope",
    provenance: { originType: "classic-problem", sourceCategory: "classic-mathematics" },
    originalityRisk: "high",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-reciprocal-root-parabolas",
    title: "Parabolas with Reciprocal Roots",
    category: "algebra and graph sketching",
    topics: ["quadratics","graphs","parameters","roots"],
    prompt:
      "For a>0, consider p_a(x)=(x-a)(x-1/a). Sketch a few examples. As a varies, what can you say about which different parabolas occur, where their axes lie, and the locus of their vertices?",
    givenInformation: [],
    approaches: [
      { id: "expand-and-compress-parameter", label: "Expand and replace a+1/a by one effective parameter" },
      { id: "root-geometry", label: "Reason from reciprocal roots, symmetry, and the midpoint of the roots" }
    ],
    milestones: [
      {
        id: "sample-reciprocal-roots",
        description: "Sketch examples such as a=1, 2, and 1/2 and notice parameter duplication.",
        skills: cantorSkills(["graph-sketching", "primary"], ["pattern-recognition", "supporting"]),
        concepts: ["parameter-dependent-curves", "roots-intersections"]
      },
      {
        id: "effective-parameter",
        description: "Expand p_a and identify a+1/a as the only parameter combination controlling the graph.",
        skills: cantorSkills(["strategic-simplification", "primary"], ["representation-switching", "supporting"]),
        concepts: ["polynomial-structure", "parameter-dependent-algebra"]
      },
      {
        id: "range-of-sum",
        description: "Prove a+1/a≥2 for a>0 and show every value at least 2 can occur.",
        skills: cantorSkills(["proof-construction", "primary"], ["precision-checking", "supporting"]),
        concepts: ["inequalities-bounds", "parameter-dependent-algebra"]
      },
      {
        id: "vertex-locus",
        description: "Express the vertex in terms of s=a+1/a, eliminate s, and prove the full half-parabola locus is attained.",
        skills: cantorSkills(["representation-switching", "primary"], ["proof-construction", "primary"], ["graph-sketching", "supporting"]),
        concepts: ["turning-points-extrema", "parameter-dependent-curves", "polynomial-structure"]
      },
      {
        id: "fixed-product-transfer",
        description: "Transfer the reciprocal-root argument to roots a and c/a with c>0, including the new vertex locus and parameter double-cover.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["precision-checking", "supporting"]),
        concepts: ["parameter-dependent-curves", "turning-points-extrema", "parameter-dependent-algebra"]
      }
    ],
    commonErrors: [
      {
        id: "treat-a-and-reciprocal-distinct",
        description: "Counts a and 1/a as producing different graphs even though the expanded polynomial is identical."
      },
      {
        id: "prove-bound-not-surjectivity",
        description: "Shows a+1/a≥2 but never checks that every s≥2 is achieved by some positive a."
      }
    ],
    followUps: [
      "What happens to the vertex as a tends to 0+?",
      "How does the picture change if the product of the two roots is a fixed positive number c instead of 1?"
    ],
    extensions: [
      {
        id: "fixed-root-product",
        prompt: "Let the roots be a and c/a with c>0. Determine the corresponding vertex locus."
      },
      {
        id: "parameter-double-cover",
        prompt: "Describe exactly when two positive parameter values generate the same polynomial and interpret this on the parameter line."
      }
    ],
    hints: [
      {
        text: "Compare a=2 with a=1/2 before doing any general algebra.",
        formulations: ["try reciprocal parameter values", "look for duplicated graphs"]
      },
      {
        text: "Expand p_a(x); only a+1/a survives as a variable coefficient.",
        formulations: ["compress the parameter into its reciprocal sum", "the constant term is always 1"]
      },
      {
        text: "The identity (a-1)²≥0 gives the lower bound for a+1/a.",
        formulations: ["derive the reciprocal-sum inequality from a square", "the effective parameter starts at 2"]
      },
      {
        text: "If s=a+1/a, the vertex is at (s/2, 1-s²/4); eliminate s and remember that every s≥2 is attained.",
        formulations: ["write the quadratic using s and eliminate it", "prove both inclusion in and coverage of the vertex locus"]
      },
      {
        text: "With roots a and c/a, the effective sum starts at 2sqrt(c), while the product term becomes c.",
        formulations: ["repeat the same compression with fixed product c", "the new locus follows from the shifted constant term"]
      }
    ],
    canonicalSolution:
      "Expanding gives p_a(x)=x²-(a+1/a)x+1. Thus a and 1/a generate the same polynomial. Put s=a+1/a. Since (a-1)²≥0, s≥2. Conversely a²-sa+1=0 has a positive solution for every s≥2, so the possible graphs are exactly x²-sx+1 with s≥2. The axis is x=s/2, hence lies at x≥1. The vertex is (s/2,1-s²/4). Writing X=s/2 gives Y=1-X² with X≥1. Every such X occurs because every s=2X≥2 occurs. With root product c, the same calculation gives x²-sx+c and the vertex locus Y=c-X² with X≥√c.",
    verificationNotes:
      "For surjectivity of s=a+1/a onto [2,∞), verify the quadratic a²-sa+1=0 has positive roots when s≥2. For fixed product c, use AM-GM or discriminant to get s≥2√c.",
    domains: ["algebra", "functions", "graph-sketching"],
    contentConcepts: [
      "polynomial-structure",
      "parameter-dependent-algebra",
      "parameter-dependent-curves",
      "roots-intersections",
      "turning-points-extrema",
      "inequalities-bounds"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "polynomial-factorization", "functions-graphs"],
    skills: cantorSkills(
      ["graph-sketching", "primary"],
      ["pattern-recognition", "supporting"],
      ["strategic-simplification", "primary"],
      ["representation-switching", "primary"],
      ["proof-construction", "primary"],
      ["precision-checking", "supporting"],
      ["technique", "supporting"],
      ["generalization", "primary"],
      ["guided-adaptation", "supporting"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "introductory", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [15, 23], [12, 20], [4, 7], 23),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 4], [8, 14], [6, 12], undefined, 14),
      cantorTiming([1, 3], [4, 8], [3, 7], [3, 6], 8)
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
    id: "oxford-cantor-cubic-two-thresholds",
    title: "A Cubic with Two Different Thresholds",
    category: "functions and calculus",
    topics: ["cubics","graphs","parameters","calculus"],
    prompt:
      "For real a, let f_a(x)=x(x²+a x+1). Investigate how the graph changes as a varies. In particular, identify the parameter values where turning points first appear and where additional real roots first appear, and explain why these are different thresholds.",
    givenInformation: [],
    approaches: [
      { id: "factor-roots-then-derivative", label: "Use factorization for roots and differentiation for turning points" },
      { id: "symmetry-reduce-sign", label: "Use the relation between a and -a to halve the parameter analysis" }
    ],
    milestones: [
      {
        id: "parameter-reflection",
        description: "Observe f_{-a}(-x)=-f_a(x) and reduce the qualitative analysis to one sign of a.",
        skills: cantorSkills(["pattern-recognition", "supporting"], ["strategic-simplification", "primary"]),
        concepts: ["qualitative-function-behavior", "parameter-dependent-algebra"]
      },
      {
        id: "root-threshold",
        description: "Use x(x²+a x+1) to classify when nonzero real roots exist.",
        skills: cantorSkills(["technique", "primary"], ["case-analysis", "supporting"]),
        concepts: ["roots-intersections", "polynomial-structure", "parameter-dependent-algebra"]
      },
      {
        id: "turning-threshold",
        description: "Analyze f_a'(x)=3x²+2a x+1 and find when two distinct critical points exist.",
        skills: cantorSkills(["technique", "primary"], ["precision-checking", "supporting"]),
        concepts: ["derivative-structure", "turning-points-extrema"]
      },
      {
        id: "full-regime-classification",
        description: "Explain the intermediate regime sqrt(3)<|a|<2 and produce justified sketches for every threshold regime, including both equality cases.",
        skills: cantorSkills(["graph-sketching", "primary"], ["case-analysis", "primary"], ["proof-construction", "supporting"], ["precision-checking", "supporting"]),
        concepts: ["qualitative-function-behavior", "roots-intersections", "turning-points-extrema", "parameter-dependent-curves"]
      },
      {
        id: "positive-constant-transfer",
        description: "Transfer both threshold calculations to x(x²+a x+c) for c>0 and explain how the two scales change.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"]),
        concepts: ["parameter-dependent-algebra", "roots-intersections", "turning-points-extrema"]
      }
    ],
    commonErrors: [
      {
        id: "confuse-root-turn-threshold",
        description: "Assumes turning points appear exactly when three real roots appear."
      },
      {
        id: "drop-equality-cases",
        description: "Fails to distinguish the repeated-root case |a|=2 or the repeated-critical-point case |a|=sqrt(3)."
      }
    ],
    followUps: [
      "Why does the graph for -a follow immediately from the graph for a?",
      "What changes if the final factor is x²+a x+c with c>0?"
    ],
    extensions: [
      {
        id: "positive-constant",
        prompt: "Replace 1 by c>0 in x(x²+a x+c). Determine the two corresponding parameter thresholds."
      },
      {
        id: "extrema-signs",
        prompt: "In the regime sqrt(3)<|a|<2, prove from the graph or algebra that both nonzero extrema lie on the same side of the x-axis."
      }
    ],
    hints: [
      {
        text: "Compare f_a(x) with f_{-a}(-x) before splitting into many parameter cases.",
        formulations: ["look for parameter reflection symmetry", "changing a to -a mirrors the graph through the origin"]
      },
      {
        text: "The nonzero roots come from a quadratic whose discriminant is a²-4.",
        formulations: ["separate the permanent root x=0", "use the discriminant of x²+a x+1"]
      },
      {
        text: "Turning points depend instead on the discriminant of 3x²+2a x+1.",
        formulations: ["differentiate and inspect a second discriminant", "critical points have threshold a²=3"]
      },
      {
        text: "Compare sqrt(3) with 2, then treat both equality values separately: one merges critical points and the other merges roots.",
        formulations: ["classify and sketch every parameter regime", "the intermediate regime has two critical points but only one real zero"]
      },
      {
        text: "For x(x²+a x+c), repeat the two discriminant calculations rather than rescaling by guesswork.",
        formulations: ["the root threshold and critical-point threshold scale differently with c", "derive both thresholds from their own quadratics"]
      }
    ],
    canonicalSolution:
      "We have f_a(x)=x³+a x²+x and f_{-a}(-x)=-f_a(x), so it is enough to understand one sign of a and reflect. Roots are x=0 together with roots of x²+a x+1, which are real exactly when a²≥4. Thus additional real roots appear at |a|=2. Meanwhile f_a'(x)=3x²+2a x+1. This quadratic has two distinct real roots exactly when 4a²-12>0, i.e. |a|>sqrt(3), and one repeated critical point at equality. Hence for sqrt(3)<|a|<2 the cubic has a local maximum and minimum but crosses the x-axis only at 0; the two extrema must lie on the same side of the axis. At |a|=2 a nonzero double root appears, and for |a|>2 there are three distinct real roots. Replacing 1 by c>0 changes the root threshold to |a|=2sqrt(c) and the turning-point threshold to |a|=sqrt(3c).",
    verificationNotes:
      "Check symmetry exactly: f_{-a}(-x)=-f_a(x). Distinguish discriminants a²-4 and 4(a²-3). At |a|=2, the quadratic factor has a repeated nonzero root; at |a|=sqrt(3), f' has a repeated zero but f remains strictly increasing with a stationary inflection.",
    domains: ["algebra", "functions", "graph-sketching", "calculus"],
    contentConcepts: [
      "polynomial-structure",
      "parameter-dependent-algebra",
      "roots-intersections",
      "turning-points-extrema",
      "derivative-structure",
      "qualitative-function-behavior",
      "parameter-dependent-curves"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "polynomial-factorization", "functions-graphs", "differentiation"],
    skills: cantorSkills(
      ["pattern-recognition", "supporting"],
      ["strategic-simplification", "primary"],
      ["technique", "primary"],
      ["case-analysis", "primary"],
      ["precision-checking", "supporting"],
      ["graph-sketching", "primary"],
      ["representation-switching", "supporting"],
      ["proof-construction", "supporting"],
      ["generalization", "primary"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [16, 24], [13, 21], [4, 8], 24),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 4], [8, 14], [6, 12], undefined, 14),
      cantorTiming([1, 3], [4, 9], [3, 7], [3, 6], 9)
    ],
    openingRole: "technique-check",
    finalRole: "stretch",
    novelty: "moderate",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  },
  {
    id: "oxford-cantor-cubic-divided-difference",
    title: "Equal Heights on a Cubic",
    category: "algebra and calculus",
    topics: ["functions","cubics","algebra","calculus"],
    prompt:
      "Let f(x)=x³-x. Fix a real number a and, for x≠a, define q_a(x)=(f(x)-f(a))/(x-a). Simplify q_a, decide how it should be filled in at x=a, and use it to classify how many other real inputs x can satisfy f(x)=f(a) as a varies.",
    givenInformation: [],
    approaches: [
      { id: "factor-difference", label: "Factor f(x)-f(a) and study the remaining quadratic" },
      { id: "horizontal-line-geometry", label: "Relate roots of the quotient to repeated heights on the cubic graph" }
    ],
    milestones: [
      {
        id: "factor-cubic-difference",
        description: "Factor f(x)-f(a) by x-a and obtain an explicit quadratic q_a.",
        skills: cantorSkills(["technique", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["polynomial-structure", "parameter-dependent-algebra"]
      },
      {
        id: "fill-removable-hole",
        description: "Evaluate the simplified quadratic at x=a and identify the value with f'(a).",
        skills: cantorSkills(["representation-switching", "primary"], ["precision-checking", "supporting"]),
        concepts: ["derivative-structure", "qualitative-function-behavior"]
      },
      {
        id: "quotient-discriminant",
        description: "Use the discriminant of q_a to find when other equal-height inputs can exist.",
        skills: cantorSkills(["case-analysis", "primary"], ["technique", "supporting"]),
        concepts: ["roots-intersections", "parameter-dependent-algebra"]
      },
      {
        id: "stationary-duplication",
        description: "Handle a=±1/sqrt(3), when x=a itself is also a root of the filled-in quotient, separately from generic two-root cases.",
        skills: cantorSkills(["precision-checking", "primary"], ["proof-construction", "supporting"]),
        concepts: ["turning-points-extrema", "roots-intersections"]
      },
      {
        id: "translate-to-cubic-geometry",
        description: "Interpret all regimes using horizontal lines on y=f(x), including the tangency threshold |a|=2/sqrt(3).",
        skills: cantorSkills(["graph-sketching", "primary"], ["representation-switching", "primary"], ["generalization", "supporting"]),
        concepts: ["qualitative-function-behavior", "roots-intersections", "turning-points-extrema"]
      }
    ],
    commonErrors: [
      {
        id: "count-a-as-other-input",
        description: "Counts x=a among the 'other' solutions without checking whether the quotient root is simply the cancelled factor returning at a stationary point."
      },
      {
        id: "confuse-two-special-thresholds",
        description: "Confuses |a|=1/sqrt(3), where f'(a)=0, with |a|=2/sqrt(3), where the two other quotient roots merge."
      }
    ],
    followUps: [
      "What is the graphical meaning of q_a(a)=f'(a)?",
      "How would the classification change for f(x)=x³-cx with c>0?"
    ],
    extensions: [
      {
        id: "scaled-cubic",
        prompt: "Repeat the analysis for f_c(x)=x³-cx with c>0 and identify the two corresponding special |a| values."
      },
      {
        id: "secant-slope-sign",
        prompt: "Use q_a to determine where the secant slope from (a,f(a)) to (x,f(x)) is positive, zero, or negative."
      }
    ],
    hints: [
      {
        text: "Use x³-a³=(x-a)(x²+ax+a²) before dealing with the linear terms.",
        formulations: ["factor the cubic difference first", "x-a cancels cleanly"]
      },
      {
        text: "After cancellation, q_a(x)=x²+ax+a²-1; substitute x=a into this polynomial.",
        formulations: ["the hole has a natural polynomial value", "compare the filled value with 3a²-1"]
      },
      {
        text: "Other equal-height points correspond to real roots of q_a, so inspect its discriminant 4-3a².",
        formulations: ["turn equal heights into a quadratic root problem", "classify by the quotient discriminant"]
      },
      {
        text: "If q_a(a)=0, one quotient root is not an additional input at all; this occurs at 3a²=1.",
        formulations: ["check when the cancelled point reappears as a quotient root", "stationary a needs separate counting"]
      },
      {
        text: "At |a|=2/sqrt(3), q_a has a double root at -a/2, corresponding to a tangent horizontal line at the other turning point.",
        formulations: ["interpret the discriminant-zero case geometrically", "the other two intersections merge"]
      }
    ],
    canonicalSolution:
      "We have f(x)-f(a)=x³-x-a³+a=(x-a)(x²+ax+a²-1), so q_a(x)=x²+ax+a²-1 for x≠a. The natural filled value is q_a(a)=3a²-1=f'(a). Other inputs with f(x)=f(a) are roots of q_a different from a. Its discriminant is 4-3a². If |a|>2/sqrt(3), there are no other real inputs. If |a|=2/sqrt(3), there is one other input x=-a/2, a double root of q_a. If |a|<2/sqrt(3), q_a has two real roots, except when a=±1/sqrt(3): then one quotient root equals a because f'(a)=0, leaving only one distinct other input. For all other a in the open range there are two distinct other inputs. This matches the horizontal-line geometry of the cubic. For x³-cx, q becomes x²+ax+a²-c, with thresholds |a|=2sqrt(c/3) and |a|=sqrt(c/3).",
    verificationNotes:
      "Count distinct x values, not multiplicities. Check q_a(a)=0 exactly at |a|=1/sqrt(3). The quotient discriminant vanishes at |a|=2/sqrt(3), giving root -a/2, distinct from a.",
    domains: ["algebra", "functions", "calculus", "graph-sketching"],
    contentConcepts: [
      "polynomial-structure",
      "parameter-dependent-algebra",
      "roots-intersections",
      "derivative-structure",
      "turning-points-extrema",
      "qualitative-function-behavior"
    ],
    prerequisiteConcepts: ["algebraic-manipulation", "polynomial-factorization", "functions-graphs", "differentiation"],
    skills: cantorSkills(
      ["technique", "primary"],
      ["strategic-simplification", "supporting"],
      ["representation-switching", "primary"],
      ["precision-checking", "primary"],
      ["case-analysis", "primary"],
      ["proof-construction", "supporting"],
      ["graph-sketching", "primary"],
      ["generalization", "supporting"],
      ["guided-adaptation", "supporting"]
    ),
    difficulty: { entry: "introductory-plus", core: "strong", ceiling: "strong" },
    timing: cantorTiming([2, 5], [14, 24], [10, 20], [4, 8], 24),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 5], [8, 14], [6, 12], undefined, 14),
      cantorTiming([1, 3], [4, 8], [3, 7], [3, 6], 8)
    ],
    openingRole: "technique-check",
    finalRole: "stretch",
    novelty: "moderate",
    abstraction: "moderate",
    provenance: { originType: "classic-problem", sourceCategory: "secondary-reference" },
    originalityRisk: "high",
    correctnessRisk: "medium",
    calibrationRisk: "high"
  },
  {
    id: "oxford-cantor-integral-sign-landscape",
    title: "Sketching an Integral from Its Derivative",
    category: "calculus and graph sketching",
    topics: ["calculus","graphs","integrals","polynomials"],
    prompt:
      "Define F(x)=∫_0^x (t²-1)(t²-9) dt. Without first expanding and integrating, build as detailed a sketch of F as you can. Then determine exactly how many real zeros F has and locate them.",
    givenInformation: [],
    approaches: [
      { id: "derivative-sign-chart", label: "Use F' directly to obtain monotonicity and turning points" },
      { id: "oddness-then-polynomial", label: "Exploit symmetry before evaluating the integral only when exact roots are needed" }
    ],
    milestones: [
      {
        id: "oddness",
        description: "Use the even integrand to prove F is odd.",
        skills: cantorSkills(["pattern-recognition", "supporting"], ["proof-construction", "supporting"]),
        concepts: ["symmetry-periodicity", "integral-accumulation"]
      },
      {
        id: "derivative-sign-chart",
        description: "Use F'(x)=(x²-1)(x²-9) to determine monotonicity intervals and turning points.",
        skills: cantorSkills(["technique", "primary"], ["graph-sketching", "primary"]),
        concepts: ["derivative-structure", "turning-points-extrema", "qualitative-function-behavior"]
      },
      {
        id: "turning-point-heights",
        description: "Evaluate enough information at x=1 and x=3 to see that the positive-side local maximum is above zero and the local minimum below zero.",
        skills: cantorSkills(["strategic-simplification", "supporting"], ["precision-checking", "primary"]),
        concepts: ["integral-accumulation", "roots-intersections"]
      },
      {
        id: "zero-count-and-locations",
        description: "Combine monotonicity, signs, and oddness to prove there are exactly five real zeros, then evaluate the antiderivative only to locate them exactly.",
        skills: cantorSkills(["proof-construction", "primary"], ["case-analysis", "supporting"], ["representation-switching", "primary"]),
        concepts: ["roots-intersections", "qualitative-function-behavior", "polynomial-structure", "integral-accumulation"]
      },
      {
        id: "two-parameter-transfer",
        description: "Transfer the sign-landscape method to ∫_0^x(t²-a²)(t²-b²)dt with 0<a<b and identify what controls the positive-side root count.",
        skills: cantorSkills(["generalization", "primary"], ["transfer", "primary"], ["strategic-simplification", "supporting"]),
        concepts: ["integral-accumulation", "turning-points-extrema", "roots-intersections"]
      }
    ],
    commonErrors: [
      {
        id: "assume-local-min-positive",
        description: "Sketches from the derivative sign pattern but never checks whether the local minimum at x=3 lies above or below the axis."
      },
      {
        id: "integrate-before-structure",
        description: "Expands immediately and misses the intended qualitative reasoning from F' and oddness."
      }
    ],
    followUps: [
      "Which parts of the sketch were possible without finding an antiderivative?",
      "For ∫_0^x(t²-a²)(t²-b²)dt with 0<a<b, what determines whether the positive local minimum is below zero?"
    ],
    extensions: [
      {
        id: "two-parameter-turning-sign",
        prompt: "For 0<a<b, analyze G(x)=∫_0^x(t²-a²)(t²-b²)dt and derive a condition for G(b)<0."
      },
      {
        id: "root-count-without-formula",
        prompt: "Give a proof of the zero count that uses no exact quartic-root calculation."
      }
    ],
    hints: [
      {
        text: "The integrand is even. Compare F(-x) with F(x) by changing variables.",
        formulations: ["an even derivative gives an odd accumulation function from 0", "use symmetry before calculus"]
      },
      {
        text: "You already know F': its sign changes only at ±1 and ±3.",
        formulations: ["make a sign chart for the integrand", "monotonicity comes for free from the derivative"]
      },
      {
        text: "The sign chart alone does not tell you whether the local minimum crosses the axis; check F(1) and F(3).",
        formulations: ["turning-point heights matter", "evaluate only the strategic points"]
      },
      {
        text: "Use monotone intervals to prove the zero count first; only then integrate, factor out x, and set u=x² for exact locations.",
        formulations: ["separate qualitative counting from exact algebra", "oddness supplies the negative roots after the positive crossings are unique"]
      },
      {
        text: "For the 0<a<b family, evaluate only the strategically relevant turning-point height at x=b before doing any full expansion.",
        formulations: ["the sign of the outer positive local minimum controls the crossing pattern", "reuse the derivative-sign landscape with scaled turning points"]
      }
    ],
    canonicalSolution:
      "Because the integrand is even, F is odd. Also F'(x)=(x²-1)(x²-9), so F increases for |x|<1 and |x|>3 and decreases for 1<|x|<3. On the positive side F(1)=88/15>0 and F(3)=-72/5<0, so there is exactly one zero in (1,3); after x=3 the function increases to infinity, so there is exactly one further positive zero. Oddness gives two corresponding negative zeros, together with x=0: five total. Evaluating gives F(x)=x^5/5-(10/3)x^3+9x. Thus nonzero roots satisfy 3u²-50u+135=0 with u=x², so u=(25±2sqrt(55))/3. The zeros are 0 and ±sqrt((25±2sqrt(55))/3).",
    verificationNotes:
      "Correct F(3) is -72/5. Verify both u-roots are positive: 25>2sqrt(55). The smaller positive zero lies in (1,3), the larger exceeds 3, matching the qualitative sketch.",
    domains: ["calculus", "functions", "graph-sketching", "algebra", "elementary-analysis"],
    contentConcepts: [
      "integral-accumulation",
      "derivative-structure",
      "turning-points-extrema",
      "roots-intersections",
      "qualitative-function-behavior",
      "symmetry-periodicity",
      "polynomial-structure"
    ],
    prerequisiteConcepts: ["functions-graphs", "differentiation", "integration", "algebraic-manipulation"],
    skills: cantorSkills(
      ["pattern-recognition", "supporting"],
      ["proof-construction", "primary"],
      ["technique", "primary"],
      ["graph-sketching", "primary"],
      ["strategic-simplification", "supporting"],
      ["precision-checking", "primary"],
      ["case-analysis", "supporting"],
      ["representation-switching", "primary"],
      ["generalization", "primary"],
      ["transfer", "primary"]
    ),
    difficulty: { entry: "introductory-plus", core: "standard", ceiling: "strong" },
    timing: cantorTiming([2, 5], [16, 24], [13, 21], [4, 8], 24),
    stageTiming: [
      cantorTiming([1, 3], [4, 7], [3, 6], undefined, 7),
      cantorTiming([2, 4], [8, 14], [6, 12], undefined, 14),
      cantorTiming([1, 3], [4, 9], [3, 7], [3, 6], 9)
    ],
    openingRole: "technique-check",
    finalRole: "stretch",
    novelty: "moderate",
    abstraction: "moderate",
    originalityRisk: "medium",
    correctnessRisk: "low",
    calibrationRisk: "medium"
  }
];

export const cantorGraphEntriesA = Object.freeze(cantorGraphFamiliesA.map(buildCantorEntry));
