import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerCandidateSpec } from "./oxford-euler-authoring.js";

export const oxfordEulerBoxDiagonalBisectorSpec = makeEulerCandidateSpec({
  "id": "oxford-euler-box-diagonal-bisector",
  "title": "The Diagonal-Bisector Section of a Box",
  "category": "geometry",
  "topics": [
    "3D visualization",
    "plane sections",
    "rectangular boxes",
    "case classification"
  ],
  "prompt": "A rectangular box is centered at the origin with vertices (±a,±b,±c), where 0<a<=b<=c. Consider the plane consisting of points equidistant from the opposite vertices (a,b,c) and (-a,-b,-c). Sketch what this plane cuts out of the box. Prove when the cross-section has four vertices and when it has six, and explain the transition case.",
  "givenInformation": [
    "A cross-section vertex occurs where the cutting plane meets an edge of the box.",
    "You may scale x=a u, y=b v, z=c w so that -1<=u,v,w<=1."
  ],
  "domains": [
    "coordinate-geometry",
    "euclidean-geometry",
    "algebra"
  ],
  "contentConcepts": [
    "spatial-configuration",
    "loci-coordinate-constraints",
    "angle-distance-structure",
    "equations-inequalities"
  ],
  "prerequisiteConcepts": [
    "coordinate-geometry-basics",
    "euclidean-geometry-basics",
    "algebraic-manipulation",
    "equations-inequalities"
  ],
  "skills": [
    "visualization",
    "representation-switching",
    "case-analysis",
    "proof-construction",
    "precision-checking",
    "abstraction",
    "generalization",
    "transfer",
    "conjecture-formation"
  ],
  "difficulty": {
    "entry": "introductory-plus",
    "core": "strong",
    "ceiling": "stretch"
  },
  "novelty": "high",
  "abstraction": "moderate",
  "introducesNewDefinition": false,
  "stages": [
    {
      "id": "opening",
      "description": "Use symmetry to predict that the section is centrally symmetric and can change combinatorial type.",
      "contentConcepts": [
        "spatial-configuration"
      ],
      "skills": [
        "visualization",
        "conjecture-formation"
      ],
      "difficulty": "introductory-plus",
      "novelty": "moderate",
      "abstraction": "low"
    },
    {
      "id": "plane",
      "description": "Derive the equidistance plane ax+by+cz=0 and scale the box to a cube with weighted coefficients a^2,b^2,c^2.",
      "contentConcepts": [
        "loci-coordinate-constraints",
        "angle-distance-structure"
      ],
      "skills": [
        "representation-switching",
        "proof-construction"
      ],
      "difficulty": "standard",
      "novelty": "moderate",
      "abstraction": "moderate"
    },
    {
      "id": "edge-test",
      "description": "Solve for the free coordinate on each edge family and reduce validity to coefficient inequalities.",
      "contentConcepts": [
        "equations-inequalities",
        "spatial-configuration"
      ],
      "skills": [
        "case-analysis",
        "proof-construction",
        "precision-checking"
      ],
      "difficulty": "strong",
      "novelty": "high",
      "abstraction": "moderate"
    },
    {
      "id": "classification",
      "description": "Show the section has four vertices when c^2>=a^2+b^2 and six when c^2<a^2+b^2, treating equality without double-counting cube vertices.",
      "contentConcepts": [
        "spatial-configuration",
        "equations-inequalities"
      ],
      "skills": [
        "proof-construction",
        "precision-checking",
        "case-analysis"
      ],
      "difficulty": "strong",
      "novelty": "high",
      "abstraction": "moderate"
    },
    {
      "id": "transfer",
      "description": "Specialize to a cube and prove the six-sided section is regular; then interpret the threshold geometrically.",
      "contentConcepts": [
        "spatial-configuration",
        "angle-distance-structure"
      ],
      "skills": [
        "generalization",
        "transfer",
        "abstraction"
      ],
      "difficulty": "stretch",
      "novelty": "high",
      "abstraction": "high"
    }
  ],
  "commonErrors": [
    {
      "id": "always-hexagon",
      "description": "Assumes every central plane section of a box has six sides."
    },
    {
      "id": "count-boundary-twice",
      "description": "At c^2=a^2+b^2 counts edge intersections meeting at a box vertex as distinct section vertices."
    }
  ],
  "followUps": [
    "Why is central symmetry guaranteed before any coordinate calculation?",
    "What does the condition c^2=a^2+b^2 say about the three half-side lengths?"
  ],
  "extensions": [
    {
      "id": "cube-regularity",
      "prompt": "For a=b=c, prove directly that the six section edges have equal length and equal angles."
    },
    {
      "id": "other-diagonal",
      "prompt": "Replace the chosen opposite vertices by another opposite pair. Which parts of the classification change?"
    }
  ],
  "hints": [
    {
      "text": "Expand equality of squared distances to the two opposite vertices; the quadratic terms cancel.",
      "formulations": [
        "find the perpendicular-bisector plane algebraically",
        "equidistance gives a plane through the center"
      ]
    },
    {
      "text": "After x=au,y=bv,z=cw, the plane is a^2 u+b^2 v+c^2 w=0 inside the cube [-1,1]^3.",
      "formulations": [
        "scale the box to a cube",
        "the side lengths move into the plane coefficients"
      ]
    },
    {
      "text": "On a w-parallel edge, u and v are ±1 and w=-(a^2u+b^2v)/c^2.",
      "formulations": [
        "test one edge family explicitly",
        "an edge intersection is valid only when the solved coordinate lies in [-1,1]"
      ]
    },
    {
      "text": "The same-sign w-edges exist exactly when a^2+b^2<=c^2; the other edge families appear exactly on the opposite side of that threshold.",
      "formulations": [
        "compare the largest coefficient with the sum of the other two",
        "count valid edge intersections by sign"
      ]
    },
    {
      "text": "At equality, some candidate intersections coincide at cube vertices, so the polygon still has four distinct vertices.",
      "formulations": [
        "deduplicate transition vertices",
        "do not count edge labels instead of polygon vertices"
      ]
    }
  ],
  "canonicalSolution": "Equidistance from V=(a,b,c) and -V gives |(x,y,z)-V|^2=|(x,y,z)+V|^2, hence ax+by+cz=0. Set x=au,y=bv,z=cw; the box becomes [-1,1]^3 and the plane is alpha u+beta v+gamma w=0 with alpha=a^2<=beta=b^2<=gamma=c^2. On an edge parallel to w, u,v are signs and w=-(alpha u+beta v)/gamma. The two opposite-sign choices are always valid because beta-alpha<=gamma. The two same-sign choices are valid exactly when alpha+beta<=gamma. An edge parallel to v can intersect only when gamma-alpha<=beta, and an edge parallel to u only when gamma-beta<=alpha; both are equivalent here to gamma<=alpha+beta. Thus if gamma>alpha+beta only four w-parallel edges are met, giving a centrally symmetric quadrilateral. If gamma<alpha+beta, exactly two edges from each of the three parallel families are met, giving six vertices. At gamma=alpha+beta the extra intersections coalesce with box vertices, leaving four distinct vertices. Therefore the threshold is c^2=a^2+b^2. For a=b=c the section is the familiar symmetry plane u+v+w=0; its six vertices are permutations of (1,-1,0), and consecutive distances are all sqrt(2) in scaled coordinates, so the cube section is regular.",
  "verificationNotes": "The four-sided section is generally a parallelogram, not necessarily a rectangle. The edge-family count uses 0<a<=b<=c critically when reducing conditions. At equality, verify distinct vertices rather than edge incidences. In a non-cube box the scaled regularity argument does not imply physical edge equality."
} as const);

export const oxfordEulerBoxDiagonalBisectorEntry = authorCuratedProblem(oxfordEulerBoxDiagonalBisectorSpec);
