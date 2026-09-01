import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordMonotoneCauchySpec: CuratedProblemSpec = {
  "id": "oxford-monotone-cauchy",
  "title": "A Monotone Cauchy Functional Equation",
  "mode": "OXFORD_MATHEMATICS",
  "category": "algebra / functional reasoning",
  "topics": [
    "functional equations",
    "monotonicity",
    "rational approximation",
    "elementary analysis"
  ],
  "difficulty": "stretch-oxford",
  "prompt": "Let f:ℝ→ℝ satisfy f(x+y)=f(x)+f(y) for all real x,y, and suppose f is increasing. Prove that there is a constant c such that f(x)=cx for every real x.",
  "givenInformation": [
    "Increasing means x≤y implies f(x)≤f(y)."
  ],
  "approaches": [
    {
      "id": "rational-squeeze",
      "label": "Determine rational values then squeeze reals"
    },
    {
      "id": "continuity-at-zero",
      "label": "Derive continuity from monotonicity"
    }
  ],
  "milestones": [
    {
      "id": "integer-structure",
      "description": "Derive f(0)=0, f(-x)=-f(x), and f(nx)=nf(x) for integers n.",
      "approachIds": [
        "rational-squeeze",
        "continuity-at-zero"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "rational-values",
      "description": "Let c=f(1) and prove f(q)=cq for rational q.",
      "approachIds": [
        "rational-squeeze",
        "continuity-at-zero"
      ],
      "prerequisiteIds": [
        "integer-structure"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "use-monotonicity",
      "description": "Use monotonicity to control f(x) between values at nearby rational numbers.",
      "approachIds": [
        "rational-squeeze"
      ],
      "prerequisiteIds": [
        "rational-values"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "continuity-route",
      "description": "Alternatively derive continuity at 0 from bounds on f(1/n), then continuity everywhere by additivity.",
      "approachIds": [
        "continuity-at-zero"
      ],
      "prerequisiteIds": [
        "rational-values"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "squeeze-real",
      "description": "Approximate an arbitrary real x from below and above by rationals and conclude f(x)=cx.",
      "approachIds": [
        "rational-squeeze",
        "continuity-at-zero"
      ],
      "prerequisiteIds": [
        "use-monotonicity",
        "continuity-route"
      ],
      "hintLevels": [
        4,
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "integer-structure",
      "to": "rational-values"
    },
    {
      "from": "rational-values",
      "to": "use-monotonicity"
    },
    {
      "from": "rational-values",
      "to": "continuity-route"
    },
    {
      "from": "use-monotonicity",
      "to": "squeeze-real"
    },
    {
      "from": "continuity-route",
      "to": "squeeze-real"
    }
  ],
  "commonErrors": [
    {
      "id": "assume-continuity",
      "description": "Assumes additivity alone implies continuity; pathological additive functions exist without regularity assumptions."
    },
    {
      "id": "only-rationals",
      "description": "Proves the formula only for rational inputs and does not extend it to all reals."
    }
  ],
  "followUps": [
    "Which weaker regularity assumptions also force an additive function to be linear?",
    "What fails if the monotonicity assumption is removed?"
  ],
  "extensions": [
    {
      "id": "bounded-interval",
      "prompt": "Show that an additive function bounded on any nontrivial interval must also be linear."
    },
    {
      "id": "pathological-note",
      "prompt": "Explain why the existence of non-linear additive functions depends on choosing a basis of ℝ over ℚ."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "First extract all algebraic consequences of additivity at 0, negatives, and integer multiples.",
      "formulations": [
        "derive f(0) and integer multiples",
        "use additivity repeatedly"
      ]
    },
    {
      "level": 2,
      "text": "Set c=f(1); additivity forces f(m/n)=c m/n for every rational m/n.",
      "formulations": [
        "determine f on rationals",
        "f(q)=q f(1) for rational q"
      ]
    },
    {
      "level": 3,
      "text": "Monotonicity becomes useful once you trap a real x between rational numbers.",
      "formulations": [
        "squeeze x between rationals",
        "use rational approximations and monotonicity"
      ]
    },
    {
      "level": 4,
      "text": "Choose rationals r<x<s as close to x as desired; then cr=f(r)≤f(x)≤f(s)=cs.",
      "formulations": [
        "cr <= f(x) <= cs",
        "bound f(x) using nearby rational values"
      ]
    },
    {
      "level": 5,
      "text": "Let r and s converge to x; the squeeze forces f(x)=cx for every real x.",
      "formulations": [
        "take rational bounds to x",
        "conclude f(x)=cx"
      ]
    }
  ],
  "canonicalSolution": "Let c=f(1). Additivity gives f(0)=0, f(-x)=-f(x), and f(nx)=nf(x) for integers n. For n>0, f(1)=f(n·(1/n))=n f(1/n), so f(1/n)=c/n; hence f(m/n)=cm/n for every rational m/n. Now fix x∈ℝ. Choose rational sequences r_k↑x and s_k↓x. Since f is increasing, c r_k=f(r_k)≤f(x)≤f(s_k)=c s_k. Monotonicity also implies c=f(1)≥f(0)=0; for negative x the same inequalities remain valid because the rational sequences preserve order. Taking k→∞ yields f(x)=cx. An equivalent route is to use monotonicity plus f(1/n)=c/n to prove continuity at 0, then extend rational linearity by density.",
  "verificationNotes": "The key regularity input is monotonicity. Check that the proof does not silently assume continuity before deriving it or use rational density without an order squeeze."
};

export const oxfordMonotoneCauchyEntry = authorCuratedProblem(oxfordMonotoneCauchySpec);
