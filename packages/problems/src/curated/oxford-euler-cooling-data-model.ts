import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerCandidateSpec } from "./oxford-euler-authoring.js";

export const oxfordEulerCoolingDataModelSpec = makeEulerCandidateSpec({
  "id": "oxford-euler-cooling-data-model",
  "title": "Which Cooling Model Fits?",
  "category": "modelling",
  "topics": [
    "discrete models",
    "temperature difference",
    "geometric recurrence",
    "model revision"
  ],
  "prompt": "A cup of tea is in a 20 C room. Its temperature is 80 C initially, 65 C after one minute, and 53.75 C after two minutes. Build a simple discrete model from these data. Compare 'lose a fixed number of degrees per minute' with 'lose a fixed fraction of the temperature gap to the room,' decide which is better supported, predict the next reading, and explain how the model should change if the room temperature changes.",
  "givenInformation": [
    "Treat the measurements as exact for the mathematical model.",
    "You are comparing discrete one-minute update rules, not deriving a differential equation."
  ],
  "domains": [
    "sequences-recurrences",
    "functions",
    "algebra"
  ],
  "contentConcepts": [
    "recurrence-structure",
    "qualitative-function-behavior",
    "parameter-dependent-algebra",
    "sequence-convergence"
  ],
  "prerequisiteConcepts": [
    "arithmetic",
    "algebraic-manipulation",
    "sequences-series",
    "functions-graphs"
  ],
  "skills": [
    "modelling",
    "representation-switching",
    "pattern-recognition",
    "proof-construction",
    "precision-checking",
    "generalization",
    "transfer"
  ],
  "difficulty": {
    "entry": "warm-up",
    "core": "introductory-plus",
    "ceiling": "standard"
  },
  "novelty": "moderate",
  "abstraction": "moderate",
  "introducesNewDefinition": false,
  "stages": [
    {
      "id": "opening",
      "description": "Compute raw temperature drops and temperature gaps above room temperature.",
      "contentConcepts": [
        "qualitative-function-behavior"
      ],
      "skills": [
        "modelling",
        "pattern-recognition"
      ],
      "difficulty": "warm-up",
      "novelty": "low",
      "abstraction": "low"
    },
    {
      "id": "structure",
      "description": "Notice the gaps 60,45,33.75 have common ratio 3/4 and write the recurrence.",
      "contentConcepts": [
        "recurrence-structure",
        "parameter-dependent-algebra"
      ],
      "skills": [
        "representation-switching",
        "proof-construction"
      ],
      "difficulty": "introductory-plus",
      "novelty": "moderate",
      "abstraction": "moderate"
    },
    {
      "id": "prediction",
      "description": "Predict the third-minute temperature and derive a closed form for minute n.",
      "contentConcepts": [
        "recurrence-structure"
      ],
      "skills": [
        "proof-construction",
        "generalization"
      ],
      "difficulty": "standard",
      "novelty": "moderate",
      "abstraction": "moderate"
    },
    {
      "id": "sanity",
      "description": "Compare long-run behavior of fixed-degree loss and fixed-fraction-gap loss against the room-temperature floor.",
      "contentConcepts": [
        "sequence-convergence",
        "qualitative-function-behavior"
      ],
      "skills": [
        "precision-checking",
        "modelling"
      ],
      "difficulty": "standard",
      "novelty": "moderate",
      "abstraction": "moderate"
    },
    {
      "id": "transfer",
      "description": "Change the room temperature after some minute and update the state variable and recurrence correctly.",
      "contentConcepts": [
        "parameter-dependent-algebra",
        "recurrence-structure"
      ],
      "skills": [
        "transfer",
        "modelling",
        "generalization"
      ],
      "difficulty": "standard",
      "novelty": "high",
      "abstraction": "moderate"
    }
  ],
  "commonErrors": [
    {
      "id": "fits-two-drops",
      "description": "Uses the first 15-degree drop as a permanent rule even though the second drop is only 11.25 degrees."
    },
    {
      "id": "fraction-of-temperature",
      "description": "Multiplies absolute temperature by 3/4 rather than the temperature gap above room temperature."
    }
  ],
  "followUps": [
    "What temperature does the model approach as n grows?",
    "If the room becomes 25 C after minute two, what is the next update under the same 25% gap-loss rule?"
  ],
  "extensions": [
    {
      "id": "infer-room",
      "prompt": "Suppose the ambient temperature were unknown but four exact readings were given. How might you solve for an ambient level and a constant gap ratio?"
    },
    {
      "id": "noisy-data",
      "prompt": "If readings are rounded, what would count as evidence for one model rather than exact proof?"
    }
  ],
  "hints": [
    {
      "text": "Subtract the room temperature before comparing ratios.",
      "formulations": [
        "work with excess temperature above twenty",
        "the relevant state is T minus ambient"
      ]
    },
    {
      "text": "The gaps are 60,45,33.75, each 3/4 of the previous gap.",
      "formulations": [
        "gap ratio is three quarters",
        "one quarter of the remaining gap is lost each minute"
      ]
    },
    {
      "text": "So T_{n+1}-20=(3/4)(T_n-20).",
      "formulations": [
        "write the recurrence around the ambient fixed point",
        "multiply the gap not the absolute temperature"
      ]
    },
    {
      "text": "The next gap is 25.3125, so the next temperature is 45.3125 C.",
      "formulations": [
        "take three quarters of 33.75",
        "add the room temperature back"
      ]
    },
    {
      "text": "If ambient changes to A, replace the state by T-A from that time onward.",
      "formulations": [
        "the fixed point moves with room temperature",
        "recenter the recurrence at the new ambient"
      ]
    }
  ],
  "canonicalSolution": "Raw drops are 15 and 11.25, so a fixed-degree-loss rule already fails the exact data. Relative to the 20 C room, the gaps are 60,45,33.75, each multiplied by 3/4. Thus a simple discrete model is T_{n+1}-20=(3/4)(T_n-20), so T_n=20+60(3/4)^n. The next temperature is 20+33.75(3/4)=45.3125 C. This model approaches 20 C and does not cross below it, unlike an indefinite fixed-degree rule. If the room temperature changes to A, the same style of model becomes T_{n+1}-A=r(T_n-A) from the change onward, with r re-estimated or assumed unchanged depending on the physical modelling choice.",
  "verificationNotes": "The data are exact by stipulation; with noise one should not claim exact ratio equality. The model is discrete and intentionally avoids asserting Newton's law of cooling as prior knowledge. If ambient switches to 25 C after minute two and r=3/4 is retained, next T=25+(53.75-25)*3/4=46.5625 C."
} as const);

export const oxfordEulerCoolingDataModelEntry = authorCuratedProblem(oxfordEulerCoolingDataModelSpec);
