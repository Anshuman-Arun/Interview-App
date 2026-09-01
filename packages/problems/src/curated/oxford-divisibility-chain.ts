import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordDivisibilityChainSpec: CuratedProblemSpec = {
  "id": "oxford-divisibility-chain",
  "title": "A Divisibility Pair in {1,…,2n}",
  "mode": "OXFORD_MATHEMATICS",
  "category": "number theory",
  "topics": [
    "pigeonhole principle",
    "2-adic decomposition",
    "divisibility"
  ],
  "difficulty": "standard-oxford",
  "prompt": "Choose any n+1 distinct integers from {1,2,…,2n}. Prove that among the chosen integers there are two distinct numbers a and b such that a divides b.",
  "givenInformation": [
    "n is a positive integer."
  ],
  "approaches": [
    {
      "id": "odd-part-pigeonhole",
      "label": "Group numbers by odd part"
    }
  ],
  "milestones": [
    {
      "id": "factor-two-powers",
      "description": "Write each positive integer uniquely as 2^k times an odd number.",
      "approachIds": [
        "odd-part-pigeonhole"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "count-odd-parts",
      "description": "Determine how many possible odd parts occur among numbers 1 through 2n.",
      "approachIds": [
        "odd-part-pigeonhole"
      ],
      "prerequisiteIds": [
        "factor-two-powers"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "pigeonhole",
      "description": "Use n+1 chosen numbers and only n odd-part classes to force two chosen numbers into the same class.",
      "approachIds": [
        "odd-part-pigeonhole"
      ],
      "prerequisiteIds": [
        "count-odd-parts"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "compare-two-powers",
      "description": "Order the two numbers with the same odd part by their powers of 2.",
      "approachIds": [
        "odd-part-pigeonhole"
      ],
      "prerequisiteIds": [
        "pigeonhole"
      ],
      "hintLevels": [
        4
      ]
    },
    {
      "id": "divisibility-finish",
      "description": "Show the smaller power-of-two multiple divides the larger.",
      "approachIds": [
        "odd-part-pigeonhole"
      ],
      "prerequisiteIds": [
        "compare-two-powers"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "factor-two-powers",
      "to": "count-odd-parts"
    },
    {
      "from": "count-odd-parts",
      "to": "pigeonhole"
    },
    {
      "from": "pigeonhole",
      "to": "compare-two-powers"
    },
    {
      "from": "compare-two-powers",
      "to": "divisibility-finish"
    }
  ],
  "commonErrors": [
    {
      "id": "pair-consecutive",
      "description": "Tries to pair consecutive integers; this does not force divisibility."
    },
    {
      "id": "nonunique-factorization",
      "description": "Does not use the unique maximal power of 2, so the pigeonhole classes are ill-defined."
    }
  ],
  "followUps": [
    "Is n+1 best possible? Construct n numbers with no divisibility relation among them.",
    "What changes for the set {1,…,kn}?"
  ],
  "extensions": [
    {
      "id": "sharpness",
      "prompt": "Show the bound is sharp by giving n numbers in {1,…,2n} no one of which divides another."
    },
    {
      "id": "poset-view",
      "prompt": "Interpret the problem as finding a comparable pair in a divisibility poset."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Strip powers of 2 from each chosen integer until what remains is odd.",
      "formulations": [
        "write each number as power of two times odd",
        "consider the odd part"
      ]
    },
    {
      "level": 2,
      "text": "Among 1,…,2n there are exactly n possible odd parts: the odd numbers at most 2n.",
      "formulations": [
        "there are n odd parts",
        "odd numbers up to 2n"
      ]
    },
    {
      "level": 3,
      "text": "With n+1 chosen numbers, two have the same odd part by pigeonhole.",
      "formulations": [
        "two numbers share an odd part",
        "pigeonhole on odd parts"
      ]
    },
    {
      "level": 4,
      "text": "Those two numbers have the form 2^r m and 2^s m for the same odd m; assume r<s.",
      "formulations": [
        "same odd part different powers of two",
        "2^r m and 2^s m"
      ]
    },
    {
      "level": 5,
      "text": "Then 2^s m=(2^{s-r})(2^r m), so the smaller divides the larger.",
      "formulations": [
        "one divides the other by a power of two",
        "2^r m divides 2^s m"
      ]
    }
  ],
  "canonicalSolution": "Write every positive integer uniquely as 2^k m with m odd. The possible odd parts m for integers in {1,…,2n} are exactly the n odd integers at most 2n. Among n+1 chosen integers, two therefore have the same odd part m. They are 2^r m and 2^s m with r≠s; assume r<s. Then 2^s m=2^{s-r}(2^r m), so 2^r m divides 2^s m. Thus a divisibility pair always exists.",
  "verificationNotes": "The proof depends on unique decomposition into a maximal power of 2 times an odd number and the exact count n of possible odd parts."
};

export const oxfordDivisibilityChainEntry = authorCuratedProblem(oxfordDivisibilityChainSpec);
