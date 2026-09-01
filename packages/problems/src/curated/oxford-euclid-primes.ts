import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordEuclidPrimesSpec: CuratedProblemSpec = {
  "id": "oxford-euclid-primes",
  "title": "Infinitely Many Primes",
  "mode": "OXFORD_MATHEMATICS",
  "category": "number theory",
  "topics": [
    "prime numbers",
    "contradiction",
    "divisibility"
  ],
  "difficulty": "introductory-plus-oxford",
  "prompt": "Prove that there are infinitely many prime numbers. Then explain exactly why the proof does not require the number formed by multiplying the listed primes and adding 1 to be prime itself.",
  "givenInformation": [
    "Every integer greater than 1 has at least one prime divisor."
  ],
  "approaches": [
    {
      "id": "euclid-product",
      "label": "Euclid product-plus-one contradiction"
    }
  ],
  "milestones": [
    {
      "id": "assume-finite",
      "description": "Assume for contradiction that all primes form a finite list.",
      "approachIds": [
        "euclid-product"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "construct-number",
      "description": "Construct an integer related to the product of every listed prime.",
      "approachIds": [
        "euclid-product"
      ],
      "prerequisiteIds": [
        "assume-finite"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "mod-listed-primes",
      "description": "Check the remainder of the constructed integer modulo each listed prime.",
      "approachIds": [
        "euclid-product"
      ],
      "prerequisiteIds": [
        "construct-number"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "prime-divisor",
      "description": "Use a prime divisor of the constructed integer, without assuming the integer itself is prime.",
      "approachIds": [
        "euclid-product"
      ],
      "prerequisiteIds": [
        "mod-listed-primes"
      ],
      "hintLevels": [
        4
      ]
    },
    {
      "id": "contradiction",
      "description": "Show that this prime divisor is missing from the supposedly complete list.",
      "approachIds": [
        "euclid-product"
      ],
      "prerequisiteIds": [
        "prime-divisor"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "assume-finite",
      "to": "construct-number"
    },
    {
      "from": "construct-number",
      "to": "mod-listed-primes"
    },
    {
      "from": "mod-listed-primes",
      "to": "prime-divisor"
    },
    {
      "from": "prime-divisor",
      "to": "contradiction"
    }
  ],
  "commonErrors": [
    {
      "id": "claim-product-plus-one-prime",
      "description": "Incorrectly claims that p_1p_2⋯p_k+1 must itself be prime."
    },
    {
      "id": "omit-prime-divisor",
      "description": "Does not invoke existence of a prime divisor when the constructed number is composite."
    }
  ],
  "followUps": [
    "Can Euclid's construction produce a composite number? Give an example.",
    "Can you adapt the idea to prove infinitely many primes in a particular congruence class in an elementary special case?"
  ],
  "extensions": [
    {
      "id": "composite-euclid-number",
      "prompt": "Find a finite prime list for which the product-plus-one number is composite and explain why Euclid's argument still works."
    },
    {
      "id": "factorial-variant",
      "prompt": "Give an equivalent proof using n!+1."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Start by assuming the opposite: that only finitely many primes exist.",
      "formulations": [
        "assume finitely many primes",
        "suppose the primes are p1 through pk"
      ]
    },
    {
      "level": 2,
      "text": "Multiply all primes in the supposed complete list and change the product by 1.",
      "formulations": [
        "take the product plus one",
        "form p1 p2 ... pk plus 1"
      ]
    },
    {
      "level": 3,
      "text": "No prime on the list divides that new number, because division by any listed prime leaves remainder 1.",
      "formulations": [
        "remainder 1 modulo every listed prime",
        "none of the listed primes divides the new number"
      ]
    },
    {
      "level": 4,
      "text": "The new number may be composite, but it has some prime divisor.",
      "formulations": [
        "it need not be prime",
        "take a prime divisor of the product plus one"
      ]
    },
    {
      "level": 5,
      "text": "That prime divisor cannot be any prime on the list, contradicting the claim that the list contained all primes.",
      "formulations": [
        "the prime divisor is not on the list",
        "contradiction to complete finite list of primes"
      ]
    }
  ],
  "canonicalSolution": "Assume there are only finitely many primes p_1,…,p_k. Let N=p_1p_2⋯p_k+1. Then N>1, so N has a prime divisor q. For each i, N≡1 (mod p_i), hence no p_i divides N. Therefore q is not any of p_1,…,p_k, contradicting the assumption that those were all primes. The proof never needs N itself to be prime; it only needs at least one prime divisor of N.",
  "verificationNotes": "Reject the common but unnecessary claim that the Euclid number is always prime. The contradiction must come from a prime factor not in the finite list."
};

export const oxfordEuclidPrimesEntry = authorCuratedProblem(oxfordEuclidPrimesSpec);
