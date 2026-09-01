import { authorCuratedProblem, type CuratedProblemSpec } from "../curated-authoring.js";

export const quantRandomWalkDrawdownSpec: CuratedProblemSpec = {
  "id":"quant-random-walk-drawdown",
  "title":"Maximum of a Short Symmetric Random Walk",
  "mode":"QUANT",
  "category":"stochastic processes",
  "topics":["random walks","reflection principle","path counting","probability"],
  "difficulty":"quant-stretch",
  "prompt":"A simple symmetric random walk starts at 0 and takes 2n steps, each +1 or -1 with probability 1/2. Conditional on ending at 0, what is the probability that the walk never goes below 0? Express the answer in closed form and justify it by path counting.",
  "givenInformation":["Condition on the walk having exactly n up-steps and n down-steps.","A path that never goes below 0 is a Dyck path."],
  "approaches":[{"id":"catalan-conditioning","label":"Catalan count divided by bridge count"},{"id":"reflection-bad-paths","label":"Reflect bridges that cross below zero"}],
  "milestones":[
    {"id":"condition-bridge","description":"Under S_{2n}=0, recognize that all sequences with n up and n down steps are equally likely.","approachIds":["catalan-conditioning","reflection-bad-paths"],"hintLevels":[1]},
    {"id":"count-bridges","description":"Count all such bridges by C(2n,n).","approachIds":["catalan-conditioning","reflection-bad-paths"],"prerequisiteIds":["condition-bridge"],"hintLevels":[2]},
    {"id":"count-nonnegative","description":"Count nonnegative bridges using the Catalan/reflection argument.","approachIds":["catalan-conditioning","reflection-bad-paths"],"prerequisiteIds":["count-bridges"],"hintLevels":[3,4]},
    {"id":"ratio","description":"Divide the nonnegative count by the total bridge count.","approachIds":["catalan-conditioning","reflection-bad-paths"],"prerequisiteIds":["count-nonnegative"],"hintLevels":[5]},
    {"id":"interpret","description":"Simplify to 1/(n+1) and interpret the conditioning.","approachIds":["catalan-conditioning","reflection-bad-paths"],"prerequisiteIds":["ratio"]}
  ],
  "edges":[{"from":"condition-bridge","to":"count-bridges"},{"from":"count-bridges","to":"count-nonnegative"},{"from":"count-nonnegative","to":"ratio"},{"from":"ratio","to":"interpret"}],
  "commonErrors":[{"id":"unconditional-probability","description":"Computes the probability of a nonnegative path without conditioning on ending at zero."},{"id":"divide-wrong-catalan","description":"Uses the Catalan number itself as a probability instead of dividing by the number of bridges."}],
  "followUps":["How is this related to the Catalan path problem in the Oxford bank?","What is the corresponding probability of staying strictly positive between times 0 and 2n?"],
  "extensions":[{"id":"first-return","prompt":"Condition additionally on first returning to zero at time 2n and compare counts."},{"id":"ballot","prompt":"Generalize to bridges ending at a positive height and connect with the ballot theorem."}],
  "hints":[
    {"level":1,"text":"Given S_{2n}=0, every path has exactly n up-steps and n down-steps.","formulations":["conditioned paths have n ups and n downs","all bridges are equally likely"]},
    {"level":2,"text":"There are C(2n,n) total bridges.","formulations":["total bridge count choose 2n n","count n up positions"]},
    {"level":3,"text":"Nonnegative bridges are counted by the nth Catalan number.","formulations":["count Dyck paths","Catalan nonnegative bridges"]},
    {"level":4,"text":"That count is C(2n,n)/(n+1), derivable by reflecting paths at their first step below 0.","formulations":["Catalan count choose 2n n over n plus one","reflect paths that go below zero"]},
    {"level":5,"text":"Divide by C(2n,n): the conditional probability is 1/(n+1).","formulations":["probability one over n plus one","Catalan count divided by bridge count"]}
  ],
  "canonicalSolution":"Conditioning on S_{2n}=0 means the path has exactly n up-steps and n down-steps, and all C(2n,n) such step sequences are equally likely. The nonnegative bridges are Dyck paths, counted by the Catalan number C_n=C(2n,n)/(n+1), obtained for example by reflecting a bad path at its first step below zero. Therefore P(min_{0≤k≤2n}S_k≥0 | S_{2n}=0)=C_n/C(2n,n)=1/(n+1).",
  "verificationNotes":"This is mathematically the same Catalan/reflection structure as the Oxford lattice-path problem but placed in a stochastic-process conditioning context. Keep both only if breadth-by-context is desired in later curation.",
  "reviewStatus":"expert-review",
  "reviewNotes":"Correct standard result; later bank audit may consider whether this overlaps too strongly with oxford-catalan-paths despite a distinct probabilistic framing."
};

export const quantRandomWalkDrawdownEntry = authorCuratedProblem(quantRandomWalkDrawdownSpec);
