import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerCandidateSpec } from "./oxford-euler-authoring.js";

export const oxfordEulerLocallyBalancedLabelsSpec = makeEulerCandidateSpec({
  "id":"oxford-euler-locally-balanced-labels","title":"Locally Balanced Labels","category":"definitions","topics":["paths and cycles","local averaging","recurrences","maximum principle"],
  "prompt":"Draw a chain of vertices and label each vertex by a real number. Call the labeling locally balanced if every non-end vertex equals the average of its two neighbors. On a closed cycle, require the same rule at every vertex. Explore examples and nonexamples. What do all locally balanced labelings of a path look like? What about a cycle?",
  "givenInformation":["For a path, the two endpoint labels are not constrained by the averaging rule.","For a cycle, every vertex has exactly two cyclic neighbors."],
  "domains":["graph-theory","sequences-recurrences","algebra"],"contentConcepts":["paths-cycles-connectivity","recurrence-structure","equations-inequalities"],"prerequisiteConcepts":["arithmetic","algebraic-manipulation","sequences-series","graph-basics"],
  "skills":["definition-exploration","small-case-exploration","pattern-recognition","proof-construction","representation-switching","generalization","precision-checking","strategic-simplification","abstraction","transfer"],"difficulty":{"entry":"warm-up","core":"introductory-plus","ceiling":"strong"},"novelty":"moderate","abstraction":"moderate","introducesNewDefinition":true,
  "stages":[
    {"id":"opening","description":"Build small path and cycle examples and identify what the local averaging rule forces.","contentConcepts":["paths-cycles-connectivity","recurrence-structure"],"skills":["definition-exploration","small-case-exploration"],"difficulty":"warm-up","novelty":"low","abstraction":"low"},
    {"id":"structure","description":"Rewrite the averaging rule as equality of consecutive differences along a path.","contentConcepts":["recurrence-structure","equations-inequalities"],"skills":["representation-switching","pattern-recognition"],"difficulty":"introductory-plus","novelty":"moderate","abstraction":"moderate"},
    {"id":"path-proof","description":"Prove that fixed endpoint values determine one arithmetic progression and no other path labeling.","contentConcepts":["recurrence-structure"],"skills":["proof-construction","precision-checking"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
    {"id":"cycle-proof","description":"Use a maximum (or minimum) label to show every label on a cycle must be equal.","contentConcepts":["paths-cycles-connectivity","equations-inequalities"],"skills":["proof-construction","strategic-simplification"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
    {"id":"transfer","description":"Extend the local-average viewpoint to a graph with designated boundary vertices and formulate a uniqueness conjecture.","contentConcepts":["paths-cycles-connectivity"],"skills":["abstraction","generalization","transfer"],"difficulty":"strong","novelty":"high","abstraction":"high"}
  ],
  "commonErrors":[{"id":"cycle-arithmetic","description":"Claims a nonconstant arithmetic progression can wrap around a cycle without checking the closing edge."},{"id":"averaging-intuition","description":"States that values 'smooth out' but does not convert the local condition into an exact recurrence or extremal proof."}],
  "followUps":["If a path has endpoint labels 2 and 11 with four equal edges, what are the interior labels?","Why does choosing a maximum label on a cycle force both neighboring labels to equal it?"],
  "extensions":[{"id":"graph-boundary","prompt":"On a finite connected graph, some vertices are declared boundary and the rest must equal the average of all neighbors. Investigate whether boundary values determine the interior uniquely."},{"id":"weighted-neighbors","prompt":"Replace the average of two neighbors by a fixed weighted average and classify path solutions."}],
  "hints":[
    {"text":"The equation 2x_i=x_{i-1}+x_{i+1} can be rearranged using differences.","formulations":["subtract neighboring labels","look at x next minus x current"]},
    {"text":"It gives x_{i+1}-x_i=x_i-x_{i-1}.","formulations":["consecutive differences are equal","the second difference is zero"]},
    {"text":"So every path solution is an arithmetic progression; endpoints determine its common difference.","formulations":["interpolate linearly between the endpoints","the path labels have constant increment"]},
    {"text":"On a cycle, choose a vertex with maximum label M. Its two neighbors average to M but cannot exceed M.","formulations":["use a maximum principle","both neighbors of a maximum must also be maximal"]},
    {"text":"Propagate that equality around the connected cycle.","formulations":["the maximum spreads to neighboring vertices","connectivity forces all labels equal"]}
  ],
  "canonicalSolution":"For path labels x_0,...,x_n, local balance is 2x_i=x_{i-1}+x_{i+1}, hence x_{i+1}-x_i=x_i-x_{i-1}. All consecutive differences are equal, so x_i=x_0+i(x_n-x_0)/n; this arithmetic progression is the unique labeling with those endpoints. On a cycle, let M be the maximum label and choose a vertex with label M. Its two neighbors are each <=M and have average M, so both equal M. Repeating around the connected cycle shows every vertex equals M. Thus cycle labelings are exactly the constant ones. The same maximum-principle idea motivates uniqueness questions on more general graphs with fixed boundary values.",
  "verificationNotes":"A one-edge path has no interior constraint and is consistent with the arithmetic-progression formula. A cycle must have at least three vertices in the intended simple-cycle interpretation. The maximum exists because the graph is finite. No positivity assumption on labels is needed."
} as const);

export const oxfordEulerLocallyBalancedLabelsEntry = authorCuratedProblem(oxfordEulerLocallyBalancedLabelsSpec);
