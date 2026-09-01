import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordPrefixSumsModNSpec: CuratedProblemSpec = {
  "id": "oxford-prefix-sums-mod-n",
  "title": "A Consecutive Sum Divisible by n",
  "mode": "OXFORD_MATHEMATICS",
  "category": "number theory",
  "topics": [
    "modular arithmetic",
    "pigeonhole principle",
    "prefix sums"
  ],
  "difficulty": "standard-oxford",
  "prompt": "Given any n integers a_1,a_2,…,a_n, prove that there is a nonempty consecutive block a_i+a_{i+1}+⋯+a_j whose sum is divisible by n.",
  "givenInformation": [
    "The integers may be positive, negative, or zero."
  ],
  "approaches": [
    {
      "id": "prefix-residues",
      "label": "Prefix sums modulo n"
    }
  ],
  "milestones": [
    {
      "id": "define-prefix",
      "description": "Introduce prefix sums S_k=a_1+⋯+a_k.",
      "approachIds": [
        "prefix-residues"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "easy-zero-residue",
      "description": "Notice that if some prefix sum is 0 modulo n, the claim is already proved.",
      "approachIds": [
        "prefix-residues"
      ],
      "prerequisiteIds": [
        "define-prefix"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "pigeonhole-residues",
      "description": "Otherwise place n prefix sums into the n-1 nonzero residue classes.",
      "approachIds": [
        "prefix-residues"
      ],
      "prerequisiteIds": [
        "easy-zero-residue"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "subtract-equal",
      "description": "Choose two equal prefix residues and subtract them.",
      "approachIds": [
        "prefix-residues"
      ],
      "prerequisiteIds": [
        "pigeonhole-residues"
      ],
      "hintLevels": [
        4
      ]
    },
    {
      "id": "identify-block",
      "description": "Recognize the difference S_j-S_i as a nonempty consecutive block sum divisible by n.",
      "approachIds": [
        "prefix-residues"
      ],
      "prerequisiteIds": [
        "subtract-equal"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "define-prefix",
      "to": "easy-zero-residue"
    },
    {
      "from": "easy-zero-residue",
      "to": "pigeonhole-residues"
    },
    {
      "from": "pigeonhole-residues",
      "to": "subtract-equal"
    },
    {
      "from": "subtract-equal",
      "to": "identify-block"
    }
  ],
  "commonErrors": [
    {
      "id": "all-subsets",
      "description": "Uses arbitrary subset sums, losing the requirement that the selected terms be consecutive."
    },
    {
      "id": "n-vs-nminus1",
      "description": "Forgets to split off the zero-residue case before applying pigeonhole to n prefix sums and n-1 nonzero residues."
    }
  ],
  "followUps": [
    "Can the same argument be phrased using S_0=0 and n+1 prefix sums?",
    "What if the block is required to have a specified length?"
  ],
  "extensions": [
    {
      "id": "include-zero-prefix",
      "prompt": "Give the shorter proof using S_0=0,S_1,…,S_n and n residue classes."
    },
    {
      "id": "cyclic-blocks",
      "prompt": "Explore the analogous statement for cyclic consecutive blocks."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Partial sums preserve consecutiveness when you subtract two of them.",
      "formulations": [
        "consider prefix sums",
        "define partial sums"
      ]
    },
    {
      "level": 2,
      "text": "If S_k≡0 mod n for some k, then a_1+⋯+a_k is already a valid block.",
      "formulations": [
        "zero prefix residue solves it",
        "if a prefix is divisible by n"
      ]
    },
    {
      "level": 3,
      "text": "If no prefix is 0 modulo n, n prefix sums occupy only n-1 possible nonzero residues.",
      "formulations": [
        "pigeonhole prefix residues",
        "n sums in n-1 nonzero residue classes"
      ]
    },
    {
      "level": 4,
      "text": "So S_i≡S_j mod n for some i<j, hence S_j-S_i≡0 mod n.",
      "formulations": [
        "two prefix sums have same residue",
        "subtract equal residues"
      ]
    },
    {
      "level": 5,
      "text": "S_j-S_i=a_{i+1}+⋯+a_j is the required nonempty consecutive block.",
      "formulations": [
        "difference of prefixes is consecutive block",
        "a_{i+1} through a_j"
      ]
    }
  ],
  "canonicalSolution": "Let S_k=a_1+⋯+a_k for 1≤k≤n. If some S_k≡0 (mod n), then the prefix a_1+⋯+a_k works. Otherwise every S_k has one of the n-1 nonzero residues modulo n. By the pigeonhole principle, two of the n prefix sums, say S_i and S_j with i<j, have the same residue. Then S_j-S_i≡0 (mod n), and S_j-S_i=a_{i+1}+⋯+a_j is a nonempty consecutive block. Equivalently, include S_0=0 and apply pigeonhole directly to the n+1 values S_0,…,S_n modulo n.",
  "verificationNotes": "The proof must preserve the consecutive-block requirement; prefix differences do exactly that. Both the split-case and S_0 formulations are valid."
};

export const oxfordPrefixSumsModNEntry = authorCuratedProblem(oxfordPrefixSumsModNSpec);
