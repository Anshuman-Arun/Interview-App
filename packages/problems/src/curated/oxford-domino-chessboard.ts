import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const oxfordDominoChessboardSpec: CuratedProblemSpec = {
  "id": "oxford-domino-chessboard",
  "title": "Mutilated Chessboard Domino Tiling",
  "mode": "OXFORD_MATHEMATICS",
  "category": "combinatorics",
  "topics": [
    "invariants",
    "coloring arguments",
    "tilings"
  ],
  "difficulty": "standard-oxford",
  "prompt": "An 8×8 chessboard has the top-left and bottom-right corner squares removed. Can the remaining 62 squares be tiled exactly by 31 dominoes, each covering two edge-adjacent squares? Prove your answer.",
  "givenInformation": [
    "A standard chessboard coloring alternates black and white squares.",
    "Each domino must cover two squares sharing an edge."
  ],
  "approaches": [
    {
      "id": "color-invariant",
      "label": "Checkerboard coloring invariant"
    }
  ],
  "milestones": [
    {
      "id": "identify-invariant",
      "description": "Look for a property preserved by every legal domino placement rather than trying placements individually.",
      "approachIds": [
        "color-invariant"
      ],
      "hintLevels": [
        1
      ]
    },
    {
      "id": "color-board",
      "description": "Color the board in the usual alternating black-white pattern and determine what one domino covers.",
      "approachIds": [
        "color-invariant"
      ],
      "prerequisiteIds": [
        "identify-invariant"
      ],
      "hintLevels": [
        2
      ]
    },
    {
      "id": "inspect-removed-corners",
      "description": "Determine the colors of the two removed opposite corners.",
      "approachIds": [
        "color-invariant"
      ],
      "prerequisiteIds": [
        "color-board"
      ],
      "hintLevels": [
        3
      ]
    },
    {
      "id": "compare-color-counts",
      "description": "Compare the remaining numbers of black and white squares with the balance forced by 31 dominoes.",
      "approachIds": [
        "color-invariant"
      ],
      "prerequisiteIds": [
        "inspect-removed-corners"
      ],
      "hintLevels": [
        4
      ]
    },
    {
      "id": "conclude-impossibility",
      "description": "Turn the color-count mismatch into a formal impossibility proof.",
      "approachIds": [
        "color-invariant"
      ],
      "prerequisiteIds": [
        "compare-color-counts"
      ],
      "hintLevels": [
        5
      ]
    }
  ],
  "edges": [
    {
      "from": "identify-invariant",
      "to": "color-board"
    },
    {
      "from": "color-board",
      "to": "inspect-removed-corners"
    },
    {
      "from": "inspect-removed-corners",
      "to": "compare-color-counts"
    },
    {
      "from": "compare-color-counts",
      "to": "conclude-impossibility"
    }
  ],
  "commonErrors": [
    {
      "id": "assume-opposite-colors",
      "description": "Assumes opposite corners have opposite colors; on an even-by-even board these two corners have the same color."
    },
    {
      "id": "empirical-tiling",
      "description": "Attempts a long case search over domino placements without identifying an invariant."
    }
  ],
  "followUps": [
    "What changes if two adjacent corners are removed instead?",
    "Can you state a necessary coloring condition for domino-tileability of any finite region?"
  ],
  "extensions": [
    {
      "id": "adjacent-corners",
      "prompt": "If two adjacent corner squares are removed instead, does the coloring obstruction disappear? Does that prove a tiling exists?"
    },
    {
      "id": "general-regions",
      "prompt": "Generalize the black-white counting obstruction to arbitrary board regions."
    }
  ],
  "hints": [
    {
      "level": 1,
      "text": "Try to find a quantity that every domino placement preserves.",
      "formulations": [
        "look for an invariant",
        "what does every domino preserve"
      ]
    },
    {
      "level": 2,
      "text": "Use the ordinary black-white checkerboard coloring and ask how many of each color a domino always covers.",
      "formulations": [
        "color the board black and white",
        "each domino covers one black and one white"
      ]
    },
    {
      "level": 3,
      "text": "The two removed opposite corners have the same checkerboard color.",
      "formulations": [
        "opposite corners have the same color",
        "both removed corners are the same color"
      ]
    },
    {
      "level": 4,
      "text": "After removing those two same-colored squares, the board has 30 squares of one color and 32 of the other.",
      "formulations": [
        "30 of one color and 32 of the other",
        "color counts are 30 and 32"
      ]
    },
    {
      "level": 5,
      "text": "Thirty-one dominoes would cover exactly 31 black and 31 white squares, contradicting the 30-32 split.",
      "formulations": [
        "31 dominoes require 31 black and 31 white",
        "the color imbalance makes tiling impossible"
      ]
    }
  ],
  "canonicalSolution": "Color the chessboard black and white in the usual alternating way. An 8×8 board contains 32 squares of each color. Opposite corners have the same color, so deleting the top-left and bottom-right corners removes two squares of that same color, leaving 30 squares of one color and 32 of the other. Every legal domino covers exactly one black and one white square, so any tiling by 31 dominoes would cover 31 squares of each color. That is impossible because the remaining board has a 30-32 color split. Therefore no such tiling exists.",
  "verificationNotes": "Verify that the two specified corners are indeed the same color and that the argument establishes impossibility only; coloring balance is necessary but not sufficient for arbitrary tiling problems."
};

export const oxfordDominoChessboardEntry = authorCuratedProblem(oxfordDominoChessboardSpec);
