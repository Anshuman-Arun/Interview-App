import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordContinuousFixedPointSpec: CuratedProblemSpec = {
  "id": "oxford-continuous-fixed-point",
  "title": "Fixed Point on an Interval",
  "mode": "OXFORD_MATHEMATICS",
  "category": "elementary analysis",
  "topics": [
    "continuity",
    "intermediate value theorem",
    "fixed points"
  ],
  "difficulty": "standard-oxford",
  "prompt": "Let f:[0,1]→[0,1] be continuous. Prove that there exists c∈[0,1] such that f(c)=c.",
  "givenInformation": [
    "You may use the Intermediate Value Theorem."
  ],
  "approaches": [
    {
      "id": "difference-function",
      "label": "Apply IVT to f(x)-x"
    }
  ],
  "milestones": [
    {
      "id": "rephrase-zero",
      "description": "Convert the fixed-point equation into a zero-finding problem for a continuous auxiliary function.",
      "approachIds": [
        "difference-function"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "endpoint-signs",
      "description": "Use the fact that f maps into [0,1] to determine signs at the endpoints.",
      "approachIds": [
        "difference-function"
      ],
      "prerequisiteIds": [
        "rephrase-zero"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "define-g",
      "description": "Set g(x)=f(x)-x and note continuity.",
      "approachIds": [
        "difference-function"
      ],
      "prerequisiteIds": [
        "endpoint-signs"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "apply-ivt",
      "description": "Apply the Intermediate Value Theorem between g(0) and g(1).",
      "approachIds": [
        "difference-function"
      ],
      "prerequisiteIds": [
        "define-g"
      ],
      "hintLevels": [
        4
      ]
    },
    {
      "id": "translate-back",
      "description": "Translate a zero of g back into a fixed point of f.",
      "approachIds": [
        "difference-function"
      ],
      "prerequisiteIds": [
        "apply-ivt"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "rephrase-zero",
      "to": "endpoint-signs"
    },
    {
      "from": "endpoint-signs",
      "to": "define-g"
    },
    {
      "from": "define-g",
      "to": "apply-ivt"
    },
    {
      "from": "apply-ivt",
      "to": "translate-back"
    }
  ],
  "commonErrors": [
    {
      "id": "strict-signs",
      "description": "Assumes g(0)>0 and g(1)<0; equality at either endpoint already gives a fixed point."
    },
    {
      "id": "omit-range-use",
      "description": "Uses continuity but forgets that f([0,1])⊆[0,1] is what supplies the endpoint inequalities."
    }
  ],
  "followUps": [
    "Does the result remain true on [a,b]?",
    "Which hypothesis fails for a discontinuous counterexample?"
  ],
  "extensions": [
    {
      "id": "general-interval",
      "prompt": "Generalize the proof to any continuous f:[a,b]→[a,b]."
    },
    {
      "id": "higher-dimension",
      "prompt": "Discuss why the analogous higher-dimensional statement is Brouwer's fixed-point theorem and needs more machinery."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "A fixed point is the same as a zero of a suitable function.",
      "formulations": [
        "turn f(x)=x into a zero problem",
        "consider a difference function"
      ]
    },
    {
      "level": 2,
      "text": "Because f(0)∈[0,1], f(0)-0≥0; because f(1)∈[0,1], f(1)-1≤0.",
      "formulations": [
        "endpoint signs",
        "f(0) nonnegative and f(1)-1 nonpositive"
      ]
    },
    {
      "level": 3,
      "text": "Define g(x)=f(x)-x; g is continuous.",
      "formulations": [
        "let g=f minus x",
        "g(x)=f(x)-x"
      ]
    },
    {
      "level": 4,
      "text": "The Intermediate Value Theorem gives c with g(c)=0, unless an endpoint already has value 0.",
      "formulations": [
        "apply IVT to g",
        "g crosses zero"
      ]
    },
    {
      "level": 5,
      "text": "g(c)=0 means exactly f(c)=c.",
      "formulations": [
        "zero of g is a fixed point",
        "translate g(c)=0 back to f(c)=c"
      ]
    }
  ],
  "canonicalSolution": "Define g(x)=f(x)-x. Since f is continuous, so is g. Because f maps [0,1] into itself, g(0)=f(0)≥0 and g(1)=f(1)-1≤0. If either is zero we already have a fixed point. Otherwise g(0)>0>g(1), so by the Intermediate Value Theorem there exists c∈(0,1) with g(c)=0. Hence f(c)=c.",
  "verificationNotes": "Check that endpoint equality cases are handled and that the codomain restriction f([0,1])⊆[0,1] is explicitly used."
};

export const oxfordContinuousFixedPointEntry = authorCuratedProblem(oxfordContinuousFixedPointSpec);
