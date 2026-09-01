import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordTriangleMediansSpec: CuratedProblemSpec = {
  "id": "oxford-triangle-medians",
  "title": "Concurrency of Triangle Medians",
  "mode": "OXFORD_MATHEMATICS",
  "category": "geometry",
  "topics": [
    "vectors",
    "coordinates",
    "affine geometry",
    "centroid"
  ],
  "difficulty": "standard-oxford",
  "prompt": "In a triangle ABC, let M_A,M_B,M_C be the midpoints of BC, CA, and AB respectively. Prove that the three medians AM_A, BM_B, and CM_C meet at one point, and determine the ratio in which that point divides each median.",
  "givenInformation": [
    "A median joins a vertex to the midpoint of the opposite side."
  ],
  "approaches": [
    {
      "id": "vector-centroid",
      "label": "Vector/coordinate centroid"
    },
    {
      "id": "mass-points",
      "label": "Equal-mass barycentric argument"
    }
  ],
  "milestones": [
    {
      "id": "choose-representation",
      "description": "Choose coordinates or position vectors so midpoint and line calculations are affine.",
      "approachIds": [
        "vector-centroid",
        "mass-points"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "candidate-centroid",
      "description": "Identify G=(A+B+C)/3 as a natural symmetric candidate point.",
      "approachIds": [
        "vector-centroid",
        "mass-points"
      ],
      "prerequisiteIds": [
        "choose-representation"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "place-on-median",
      "description": "Express G as A+(2/3)(M_A-A) and similarly for the other vertices.",
      "approachIds": [
        "vector-centroid"
      ],
      "prerequisiteIds": [
        "candidate-centroid"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "mass-route",
      "description": "Alternatively assign equal masses at A,B,C and use balance at side midpoints and the common center of mass.",
      "approachIds": [
        "mass-points"
      ],
      "prerequisiteIds": [
        "candidate-centroid"
      ],
      "hintLevels": [
        3,
        4
      ]
    },
    {
      "id": "ratio-and-concurrency",
      "description": "Conclude all three medians pass through G and AG:GM_A=2:1, with the analogous ratios on the other medians.",
      "approachIds": [
        "vector-centroid",
        "mass-points"
      ],
      "prerequisiteIds": [
        "place-on-median",
        "mass-route"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "choose-representation",
      "to": "candidate-centroid"
    },
    {
      "from": "candidate-centroid",
      "to": "place-on-median"
    },
    {
      "from": "candidate-centroid",
      "to": "mass-route"
    },
    {
      "from": "place-on-median",
      "to": "ratio-and-concurrency"
    },
    {
      "from": "mass-route",
      "to": "ratio-and-concurrency"
    }
  ],
  "commonErrors": [
    {
      "id": "ratio-reversed",
      "description": "States the centroid divides a median 1:2 from the vertex rather than 2:1."
    },
    {
      "id": "two-medians-only",
      "description": "Shows two medians meet but does not verify the same point lies on the third."
    }
  ],
  "followUps": [
    "What are the coordinates of the centroid in an arbitrary coordinate system?",
    "Why is the centroid invariant under affine transformations?"
  ],
  "extensions": [
    {
      "id": "area-sixths",
      "prompt": "Show the three medians divide the triangle into six smaller triangles of equal area."
    },
    {
      "id": "tetrahedron",
      "prompt": "Generalize the centroid construction to a tetrahedron using position vectors."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Coordinates or position vectors make midpoints especially simple.",
      "formulations": [
        "use vectors or coordinates",
        "represent vertices by position vectors"
      ]
    },
    {
      "level": 2,
      "text": "The symmetric average G=(A+B+C)/3 is a promising point to test.",
      "formulations": [
        "try the average of the three vertices",
        "centroid is (A+B+C)/3"
      ]
    },
    {
      "level": 3,
      "text": "The midpoint of BC is M_A=(B+C)/2.",
      "formulations": [
        "M_A equals (B+C)/2",
        "write the opposite midpoint as an average"
      ]
    },
    {
      "level": 4,
      "text": "Compute A+(2/3)(M_A-A); it simplifies to (A+B+C)/3.",
      "formulations": [
        "A plus two thirds toward the midpoint",
        "G lies two thirds along the median"
      ]
    },
    {
      "level": 5,
      "text": "The same calculation holds cyclically, so all three medians pass through G, with vertex-to-centroid : centroid-to-midpoint = 2:1.",
      "formulations": [
        "all medians pass through the centroid",
        "centroid divides each median in ratio 2 to 1"
      ]
    }
  ],
  "canonicalSolution": "Treat A,B,C as position vectors. The midpoint of BC is M_A=(B+C)/2. Let G=(A+B+C)/3. Then A+(2/3)(M_A-A)=A+(2/3)((B+C)/2-A)=(A+B+C)/3=G. Thus G lies on median AM_A and AG=(2/3)AM_A, so AG:GM_A=2:1. By cyclic symmetry the same point G lies on BM_B and CM_C with the same 2:1 division. Therefore all three medians are concurrent at the centroid G.",
  "verificationNotes": "The vector proof is fully affine and does not require a diagram beyond the definitions. Verify the ratio orientation: the longer segment is from the vertex to the centroid."
};

export const oxfordTriangleMediansEntry = authorCuratedProblem(oxfordTriangleMediansSpec);
