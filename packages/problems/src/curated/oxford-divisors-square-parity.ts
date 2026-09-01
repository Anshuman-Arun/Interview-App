import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordDivisorsSquareParitySpec: CuratedProblemSpec = {
  "id": "oxford-divisors-square-parity",
  "title": "Odd Number of Divisors",
  "mode": "OXFORD_MATHEMATICS",
  "category": "number theory",
  "topics": [
    "divisors",
    "perfect squares",
    "prime factorization",
    "parity"
  ],
  "difficulty": "standard-oxford",
  "prompt": "Prove that a positive integer has an odd number of positive divisors if and only if it is a perfect square.",
  "givenInformation": [
    "Divisors are positive divisors."
  ],
  "approaches": [
    {
      "id": "divisor-pairing",
      "label": "Pair d with n/d"
    },
    {
      "id": "prime-exponents",
      "label": "Prime factorization divisor count"
    }
  ],
  "milestones": [
    {
      "id": "test-pairing",
      "description": "Examine how divisors naturally pair under d ↔ n/d.",
      "approachIds": [
        "divisor-pairing",
        "prime-exponents"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "identify-fixed-point",
      "description": "Determine when a divisor can be paired with itself.",
      "approachIds": [
        "divisor-pairing"
      ],
      "prerequisiteIds": [
        "test-pairing"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "pairing-conclusion",
      "description": "Use the presence or absence of a self-paired divisor to determine divisor-count parity.",
      "approachIds": [
        "divisor-pairing"
      ],
      "prerequisiteIds": [
        "identify-fixed-point"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "factorization-route",
      "description": "Alternatively, write n as a product of prime powers and use τ(n)=∏(a_i+1).",
      "approachIds": [
        "prime-exponents"
      ],
      "prerequisiteIds": [
        "test-pairing"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "iff-finish",
      "description": "Establish both directions of the if-and-only-if statement.",
      "approachIds": [
        "divisor-pairing",
        "prime-exponents"
      ],
      "prerequisiteIds": [
        "pairing-conclusion",
        "factorization-route"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "test-pairing",
      "to": "identify-fixed-point"
    },
    {
      "from": "identify-fixed-point",
      "to": "pairing-conclusion"
    },
    {
      "from": "test-pairing",
      "to": "factorization-route"
    },
    {
      "from": "pairing-conclusion",
      "to": "iff-finish"
    },
    {
      "from": "factorization-route",
      "to": "iff-finish"
    }
  ],
  "commonErrors": [
    {
      "id": "one-direction",
      "description": "Shows that squares have an odd number of divisors but does not prove the converse."
    },
    {
      "id": "double-count-sqrt",
      "description": "Counts √n twice when pairing divisors of a square."
    }
  ],
  "followUps": [
    "How many divisors does n have in terms of its prime exponents?",
    "Characterize integers with exactly three positive divisors."
  ],
  "extensions": [
    {
      "id": "exactly-three",
      "prompt": "Characterize all positive integers having exactly three positive divisors."
    },
    {
      "id": "divisor-count-formula",
      "prompt": "Derive the general divisor-count formula from prime factorization."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Pair divisors in a way that usually produces pairs of distinct numbers.",
      "formulations": [
        "pair the divisors",
        "look for divisor pairs"
      ]
    },
    {
      "level": 2,
      "text": "For a divisor d of n, pair d with n/d and ask when these are equal.",
      "formulations": [
        "pair d with n/d",
        "when is d equal to n/d"
      ]
    },
    {
      "level": 3,
      "text": "A self-pair occurs exactly when d²=n.",
      "formulations": [
        "self pair means d squared equals n",
        "d=n/d implies d^2=n"
      ]
    },
    {
      "level": 4,
      "text": "If n is not a square every divisor belongs to a two-element pair; if n is a square, √n is the unique unpaired divisor.",
      "formulations": [
        "nonsquares have divisor pairs",
        "square root is the unique unpaired divisor"
      ]
    },
    {
      "level": 5,
      "text": "Therefore nonsquares have an even divisor count, while squares have one extra unpaired divisor and hence an odd divisor count.",
      "formulations": [
        "nonsquares have even divisor count",
        "squares have odd divisor count because of sqrt n"
      ]
    }
  ],
  "canonicalSolution": "For each positive divisor d of n, n/d is also a positive divisor. The map d↦n/d is an involution. Its orbits have size two except at fixed points, and a fixed point satisfies d=n/d, equivalently d²=n. If n is not a perfect square there are no fixed points, so all divisors come in distinct pairs and the number of divisors is even. If n is a perfect square, √n is the unique fixed point; every other divisor is paired with a distinct partner, so the total number is odd. This proves both directions. Alternatively, if n=∏p_i^{a_i}, then τ(n)=∏(a_i+1), which is odd exactly when every a_i is even, exactly when n is a square.",
  "verificationNotes": "The pairing proof must establish uniqueness of the fixed point and both directions. The prime-factorization alternative is also valid if the divisor-count formula is justified."
};

export const oxfordDivisorsSquareParityEntry = authorCuratedProblem(oxfordDivisorsSquareParitySpec);
