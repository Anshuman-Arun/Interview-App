import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordCatalanPathsSpec: CuratedProblemSpec = {
  "id": "oxford-catalan-paths",
  "title": "Lattice Paths Below the Diagonal",
  "mode": "OXFORD_MATHEMATICS",
  "category": "combinatorics",
  "topics": [
    "lattice paths",
    "Catalan numbers",
    "reflection principle",
    "recurrences"
  ],
  "difficulty": "stretch-oxford",
  "prompt": "A path from (0,0) to (n,n) uses unit steps Right and Up. How many such paths never go strictly above the diagonal y=x? Derive the answer rather than quoting the Catalan-number formula.",
  "givenInformation": [
    "A path is above the diagonal at a point when y>x."
  ],
  "approaches": [
    {
      "id": "reflection-principle",
      "label": "Reflect bad paths at first crossing"
    },
    {
      "id": "catalan-recurrence",
      "label": "First-return Catalan recurrence"
    }
  ],
  "milestones": [
    {
      "id": "count-all",
      "description": "Count all unrestricted monotone paths from (0,0) to (n,n).",
      "approachIds": [
        "reflection-principle",
        "catalan-recurrence"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "characterize-bad",
      "description": "For the reflection route, identify a canonical first step at which a path becomes strictly above y=x.",
      "approachIds": [
        "reflection-principle"
      ],
      "prerequisiteIds": [
        "count-all"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "reflect-prefix",
      "description": "Reflect the prefix through that first crossing and identify the endpoint of the transformed path.",
      "approachIds": [
        "reflection-principle"
      ],
      "prerequisiteIds": [
        "characterize-bad"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "recurrence-route",
      "description": "Alternatively decompose a good path at its first return to the diagonal to obtain the Catalan recurrence.",
      "approachIds": [
        "catalan-recurrence"
      ],
      "prerequisiteIds": [
        "count-all"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "subtract-and-simplify",
      "description": "Count bad paths and subtract from all paths, obtaining (1/(n+1))·C(2n,n).",
      "approachIds": [
        "reflection-principle",
        "catalan-recurrence"
      ],
      "prerequisiteIds": [
        "reflect-prefix",
        "recurrence-route"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "count-all",
      "to": "characterize-bad"
    },
    {
      "from": "characterize-bad",
      "to": "reflect-prefix"
    },
    {
      "from": "count-all",
      "to": "recurrence-route"
    },
    {
      "from": "reflect-prefix",
      "to": "subtract-and-simplify"
    },
    {
      "from": "recurrence-route",
      "to": "subtract-and-simplify"
    }
  ],
  "commonErrors": [
    {
      "id": "wrong-bad-endpoint",
      "description": "Reflects a bad path but maps it to the wrong endpoint, causing an off-by-one binomial coefficient."
    },
    {
      "id": "count-touching-as-bad",
      "description": "Treats paths that merely touch the diagonal as forbidden even though only y>x is forbidden."
    }
  ],
  "followUps": [
    "How does the answer change for paths from (0,0) to (n,n+k) with a barrier?",
    "Can you derive the Catalan recurrence from first returns?"
  ],
  "extensions": [
    {
      "id": "dyck-parentheses",
      "prompt": "Translate the same count into balanced-parentheses strings."
    },
    {
      "id": "first-return",
      "prompt": "Derive C_{n+1}=∑_{i=0}^n C_i C_{n-i} from a first-return decomposition."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Ignore the diagonal restriction first: every path is an ordering of n Right and n Up steps.",
      "formulations": [
        "count all paths with a binomial coefficient",
        "there are choose 2n n unrestricted paths"
      ]
    },
    {
      "level": 2,
      "text": "For a bad path, focus on the first step that takes it from y=x to y=x+1.",
      "formulations": [
        "first crossing above the diagonal",
        "first up step from the diagonal"
      ]
    },
    {
      "level": 3,
      "text": "Reflect the path prefix up to that first crossing by swapping Right and Up steps.",
      "formulations": [
        "reflect the prefix",
        "swap right and up before first crossing"
      ]
    },
    {
      "level": 4,
      "text": "This gives a bijection from bad paths to unrestricted paths with n+1 Right steps and n-1 Up steps, counted by C(2n,n-1).",
      "formulations": [
        "bad paths correspond to endpoint n+1,n-1",
        "bad paths count choose 2n n-1"
      ]
    },
    {
      "level": 5,
      "text": "Subtract: C(2n,n)-C(2n,n-1)=C(2n,n)/(n+1).",
      "formulations": [
        "subtract choose 2n n-1",
        "Catalan formula one over n plus one times choose 2n n"
      ]
    }
  ],
  "canonicalSolution": "There are C(2n,n) unrestricted paths. Call a path bad if it ever has y>x, and consider its first step from the diagonal to y=x+1. Reflect the prefix through that step across the diagonal, equivalently swap Right and Up in that prefix. This produces a monotone path with n+1 Right steps and n-1 Up steps, from (0,0) to (n+1,n-1). The operation is reversible by locating the first crossing of the corresponding shifted imbalance, so bad paths are counted by C(2n,n-1). Therefore the number of good paths is C(2n,n)-C(2n,n-1)=C(2n,n)/(n+1). A first-return decomposition yields the same Catalan numbers recursively.",
  "verificationNotes": "The reflection bijection and endpoint (n+1,n-1) are the delicate points. This is standard but flagged for later expert review of exposition if the bank undergoes a mathematical-content audit.",
  "reviewStatus": "expert-review",
  "reviewNotes": "Formula is standard; later audit should scrutinize the stated inverse of the reflection bijection for pedagogical precision."
};

export const oxfordCatalanPathsEntry = authorCuratedProblem(oxfordCatalanPathsSpec);
