import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantWaitingTimeHhSpec: CuratedProblemSpec = {
  "id":"quant-waiting-time-hh",
  "title":"Expected Waiting Time for Two Heads",
  "mode":"QUANT",
  "category":"stochastic processes",
  "topics":["expected value","Markov states","recurrences","pattern waiting times"],
  "difficulty":"quant-standard",
  "prompt":"A fair coin is flipped repeatedly until two consecutive Heads (HH) first appear. What is the expected number of flips? Derive the answer from states or conditional expectation.",
  "givenInformation":["Coin flips are independent and fair."],
  "approaches":[{"id":"state-recursion","label":"Two-state first-step recursion"}],
  "milestones":[
    {"id":"choose-states","description":"Distinguish the state with no useful trailing Head from the state with exactly one trailing Head.","approachIds":["state-recursion"],"hintLevels":[1]},
    {"id":"equation-empty","description":"Write a first-step equation for the expected remaining time E_0 from the no-trailing-Head state.","approachIds":["state-recursion"],"prerequisiteIds":["choose-states"],"hintLevels":[2]},
    {"id":"equation-head","description":"Write the equation for E_1 after one trailing Head.","approachIds":["state-recursion"],"prerequisiteIds":["equation-empty"],"hintLevels":[3]},
    {"id":"solve-system","description":"Solve the two linear equations.","approachIds":["state-recursion"],"prerequisiteIds":["equation-head"],"hintLevels":[4]},
    {"id":"interpret","description":"State E_0 as the expected number of flips from the start.","approachIds":["state-recursion"],"prerequisiteIds":["solve-system"],"hintLevels":[5]}
  ],
  "edges":[{"from":"choose-states","to":"equation-empty"},{"from":"equation-empty","to":"equation-head"},{"from":"equation-head","to":"solve-system"},{"from":"solve-system","to":"interpret"}],
  "commonErrors":[{"id":"geometric-quarter","description":"Treats disjoint pairs as independent trials with success probability 1/4, ignoring overlaps such as HHH."},{"id":"reset-after-head","description":"After state H and another H, adds a new state instead of recognizing absorption."}],
  "followUps":["What is the expected waiting time for HT?","Why do HH and HT have different overlap structures despite both having probability 1/4 on any fixed pair?"],
  "extensions":[{"id":"compare-ht","prompt":"Compute the expected waiting time for HT and compare it with HH."},{"id":"hht","prompt":"Set up states for the pattern HHT."}],
  "hints":[
    {"level":1,"text":"Track whether the current flip history ends in a single Head that could be the first H of HH.","formulations":["use states no head and one trailing head","track the useful suffix"]},
    {"level":2,"text":"From state 0, one flip is spent; T returns to state 0 and H moves to state 1, so E_0=1+(E_0+E_1)/2.","formulations":["E0 equation","E0 = 1 + half E0 plus half E1"]},
    {"level":3,"text":"From state 1, H finishes and T resets, so E_1=1+E_0/2.","formulations":["E1 equation","E1 = 1 + half E0"]},
    {"level":4,"text":"Solving gives E_0-E_1=2 and E_1=1+E_0/2.","formulations":["solve the two equations","E0 equals 6"]},
    {"level":5,"text":"The solution is E_0=6 flips from the start.","formulations":["expected waiting time six","answer is 6"]}
  ],
  "canonicalSolution":"Let E_0 be the expected remaining flips when the current history does not end in H, and E_1 when it ends in exactly one useful H. First-step conditioning gives E_0=1+(1/2)E_0+(1/2)E_1. From state 1, a Head completes HH while a Tail returns to state 0, so E_1=1+(1/2)·0+(1/2)E_0=1+E_0/2. The first equation gives E_0=2+E_1. Substituting yields E_0=2+1+E_0/2, hence E_0=6. Therefore the expected waiting time is 6 flips.",
  "verificationNotes":"The state must preserve overlap information. A geometric model on nonoverlapping pairs gives the wrong process."
};

export const quantWaitingTimeHhEntry = authorCuratedProblem(quantWaitingTimeHhSpec);
