import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordNestedRadicalSequenceSpec: CuratedProblemSpec = {
  "id": "oxford-nested-radical-sequence",
  "title": "A Nested-Radical Recurrence",
  "mode": "OXFORD_MATHEMATICS",
  "category": "sequences",
  "topics": [
    "recurrence relations",
    "monotone convergence",
    "bounds",
    "fixed points",
    "elementary analysis"
  ],
  "difficulty": "standard-oxford",
  "prompt": "Define x_1=0 and x_{n+1}=√(2+x_n) for n≥1. Prove that the sequence converges and determine its limit.",
  "givenInformation": [
    "Use the nonnegative square root."
  ],
  "approaches": [
    {
      "id": "monotone-bounded",
      "label": "Monotone and bounded convergence"
    }
  ],
  "milestones": [
    {
      "id": "guess-limit",
      "description": "Use fixed-point reasoning to identify plausible limits while respecting the nonnegative range.",
      "approachIds": [
        "monotone-bounded"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "establish-bound",
      "description": "Prove an invariant upper bound for all terms.",
      "approachIds": [
        "monotone-bounded"
      ],
      "prerequisiteIds": [
        "guess-limit"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "prove-monotone",
      "description": "Show x_{n+1}≥x_n using the established range.",
      "approachIds": [
        "monotone-bounded"
      ],
      "prerequisiteIds": [
        "establish-bound"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "convergence-or-error",
      "description": "Invoke monotone bounded convergence, or derive a shrinking error formula for 2-x_n.",
      "approachIds": [
        "monotone-bounded"
      ],
      "prerequisiteIds": [
        "prove-monotone"
      ],
      "hintLevels": [
        4
      ]
    },
    {
      "id": "identify-limit",
      "description": "Pass to the limit in L=√(2+L) and choose the admissible root.",
      "approachIds": [
        "monotone-bounded"
      ],
      "prerequisiteIds": [
        "convergence-or-error"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "guess-limit",
      "to": "establish-bound"
    },
    {
      "from": "establish-bound",
      "to": "prove-monotone"
    },
    {
      "from": "prove-monotone",
      "to": "convergence-or-error"
    },
    {
      "from": "convergence-or-error",
      "to": "identify-limit"
    }
  ],
  "commonErrors": [
    {
      "id": "solve-before-convergence",
      "description": "Solves the fixed-point equation and declares convergence without proving that a limit exists."
    },
    {
      "id": "keep-negative-root",
      "description": "Keeps the algebraic root -1 even though all sequence terms are nonnegative."
    }
  ],
  "followUps": [
    "What happens for x_{n+1}=√(a+x_n) with a>0?",
    "Can you obtain a quantitative bound on 2-x_n?"
  ],
  "extensions": [
    {
      "id": "general-a",
      "prompt": "Analyze x_{n+1}=√(a+x_n) for a>0 and suitable starting values."
    },
    {
      "id": "rate",
      "prompt": "Bound the convergence rate using 2-x_{n+1}=(2-x_n)/(2+√(2+x_n))."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "A candidate limit should be a fixed point of the update map x↦√(2+x), but first you need convergence.",
      "formulations": [
        "look for a fixed point",
        "candidate limit satisfies L=sqrt(2+L)"
      ]
    },
    {
      "level": 2,
      "text": "Show by induction that 0≤x_n≤2.",
      "formulations": [
        "prove x_n is at most 2",
        "0 <= x_n <= 2"
      ]
    },
    {
      "level": 3,
      "text": "On [0,2], the inequality √(2+x)≥x is equivalent to 2+x≥x², which factors conveniently.",
      "formulations": [
        "show sqrt(2+x) >= x",
        "2+x >= x^2 on the interval"
      ]
    },
    {
      "level": 4,
      "text": "The sequence is increasing and bounded above by 2, so it converges.",
      "formulations": [
        "increasing and bounded",
        "monotone bounded convergence"
      ]
    },
    {
      "level": 5,
      "text": "If x_n→L, then L²-L-2=0; nonnegativity forces L=2 rather than -1.",
      "formulations": [
        "L squared minus L minus 2 equals zero",
        "the limit is 2"
      ]
    }
  ],
  "canonicalSolution": "First prove 0≤x_n≤2 by induction: x_1=0, and if x_n≤2 then x_{n+1}=√(2+x_n)≤2. For monotonicity, when 0≤x_n≤2, x_{n+1}≥x_n is equivalent (both sides nonnegative) to 2+x_n≥x_n², i.e. (2-x_n)(x_n+1)≥0. Hence (x_n) is increasing and bounded above, so it converges to some L∈[0,2]. Continuity of the square root gives L=√(2+L), so L²-L-2=0 and L∈{2,-1}. Since L≥0, L=2.",
  "verificationNotes": "A correct solution must prove existence of the limit before using the fixed-point equation. Squaring inequalities is justified only after noting nonnegativity."
};

export const oxfordNestedRadicalSequenceEntry = authorCuratedProblem(oxfordNestedRadicalSequenceSpec);
