import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordEvenOddDegreesSpec: CuratedProblemSpec = {
  "id": "oxford-even-odd-degrees",
  "title": "Even Number of Odd-Degree Vertices",
  "mode": "OXFORD_MATHEMATICS",
  "category": "graph theory",
  "topics": [
    "degree sum",
    "parity",
    "handshaking lemma"
  ],
  "difficulty": "introductory-plus-oxford",
  "prompt": "At a party, some pairs of people shake hands, with no pair shaking hands more than once and nobody shaking their own hand. Prove that the number of people who shake hands an odd number of times is even.",
  "givenInformation": [
    "Model each person as a vertex and each handshake as an undirected edge."
  ],
  "approaches": [
    {
      "id": "degree-sum",
      "label": "Handshaking lemma"
    },
    {
      "id": "edge-toggle",
      "label": "Parity changes under adding edges"
    }
  ],
  "milestones": [
    {
      "id": "model-graph",
      "description": "Translate the party into a finite undirected graph and identify handshake counts with degrees.",
      "approachIds": [
        "degree-sum",
        "edge-toggle"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "sum-degrees",
      "description": "Relate the sum of all degrees to the number of edges.",
      "approachIds": [
        "degree-sum"
      ],
      "prerequisiteIds": [
        "model-graph"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "parity-sum",
      "description": "Use the fact that the total degree sum is even to constrain the number of odd summands.",
      "approachIds": [
        "degree-sum"
      ],
      "prerequisiteIds": [
        "sum-degrees"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "toggle-route",
      "description": "Alternatively observe that adding one edge flips parity at exactly two vertices, so the number of odd-degree vertices changes by an even amount.",
      "approachIds": [
        "edge-toggle"
      ],
      "prerequisiteIds": [
        "model-graph"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "finish-parity",
      "description": "Conclude the number of odd-degree vertices must be even.",
      "approachIds": [
        "degree-sum",
        "edge-toggle"
      ],
      "prerequisiteIds": [
        "parity-sum",
        "toggle-route"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "model-graph",
      "to": "sum-degrees"
    },
    {
      "from": "sum-degrees",
      "to": "parity-sum"
    },
    {
      "from": "model-graph",
      "to": "toggle-route"
    },
    {
      "from": "parity-sum",
      "to": "finish-parity"
    },
    {
      "from": "toggle-route",
      "to": "finish-parity"
    }
  ],
  "commonErrors": [
    {
      "id": "pair-odd-vertices",
      "description": "Assumes odd-degree vertices can be paired directly without justification."
    },
    {
      "id": "directed-count",
      "description": "Counts each handshake only once in the degree sum instead of once at each endpoint."
    }
  ],
  "followUps": [
    "Can exactly one person have an odd number of handshakes?",
    "What degree sequences are possible for a simple graph?"
  ],
  "extensions": [
    {
      "id": "components",
      "prompt": "Apply the result to each connected component and discuss Euler trails."
    },
    {
      "id": "toggle-invariant",
      "prompt": "Use the edge-toggle proof as an invariant argument starting from the empty graph."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Think of handshake counts as vertex degrees in a graph.",
      "formulations": [
        "model the party as a graph",
        "handshake count is degree"
      ]
    },
    {
      "level": 2,
      "text": "Each edge contributes 1 to the degree of each of its two endpoints.",
      "formulations": [
        "sum of degrees equals twice the number of edges",
        "each handshake contributes two to total degree"
      ]
    },
    {
      "level": 3,
      "text": "Therefore the sum of all degrees is even.",
      "formulations": [
        "total degree is even",
        "degree sum has even parity"
      ]
    },
    {
      "level": 4,
      "text": "A sum of integers is even exactly when it contains an even number of odd summands.",
      "formulations": [
        "even sum has even number of odd terms",
        "odd degrees must occur an even number of times"
      ]
    },
    {
      "level": 5,
      "text": "The odd summands are precisely the people with an odd number of handshakes, so their count is even.",
      "formulations": [
        "odd degree vertices are even in number",
        "conclude even number of odd handshake counts"
      ]
    }
  ],
  "canonicalSolution": "Represent the party by a finite undirected graph. If d(v) is the number of handshakes of person v, then ∑_v d(v)=2|E| because every handshake contributes 1 to the degree of each endpoint. Thus the degree sum is even. Modulo 2, every even degree contributes 0 and every odd degree contributes 1, so the parity of the sum equals the parity of the number of odd-degree vertices. Since the sum is even, the number of odd-degree vertices is even. Alternatively, start from the empty graph, where there are zero odd-degree vertices; adding an edge flips parity at exactly two endpoints, preserving evenness of the odd-degree count.",
  "verificationNotes": "Either proof is valid. Ensure the handshaking identity counts each edge twice and the parity conclusion is explicitly justified."
};

export const oxfordEvenOddDegreesEntry = authorCuratedProblem(oxfordEvenOddDegreesSpec);
