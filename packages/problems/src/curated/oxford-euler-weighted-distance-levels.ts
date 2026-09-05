import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerSpec, type EulerFamilyDefinition } from "./oxford-euler-authoring.js";
const DEFINITION: EulerFamilyDefinition = {
"id":"oxford-euler-weighted-distance-levels","title":"Weighted Squared-Distance Level Sets","category":"coordinate geometry",
"topics":["distance loci","level sets","coordinate expansion","parameter change"],
"prompt":"Fix three noncollinear points A,B,C. For a variable point P define F(P)=PA^2+PB^2-2PC^2. Without graphing software, describe the sets of points satisfying F(P)=k as k varies. Then change the coefficient 2 to a parameter lambda and determine what qualitative change occurs when lambda passes through 2.",
"givenInformation":["A,B,C are fixed and noncollinear.","You may place the origin wherever it makes the geometry simplest."],
"domains":["coordinate-geometry","euclidean-geometry","algebra"],
"contentConcepts":["loci-coordinate-constraints","angle-distance-structure","parameter-dependent-algebra","analytic-curve-geometry"],
"prerequisiteConcepts":["coordinate-geometry-basics","algebraic-manipulation","equations-inequalities"],
"skills":["visualization","representation-switching","proof-construction","case-analysis","generalization","precision-checking","conjecture-formation","abstraction","transfer"],
"difficulty":{"entry":"introductory","core":"standard","ceiling":"strong"},"novelty":"high","abstraction":"moderate","introducesNewDefinition":false,
"stages":[
{"id":"opening","description":"Use a convenient coordinate origin and test a few values of P to conjecture the shape of F(P)=k.","contentConcepts":["angle-distance-structure","loci-coordinate-constraints"],"skills":["visualization","conjecture-formation"],"difficulty":"introductory","novelty":"moderate","abstraction":"low"},
{"id":"structure","description":"Expand the squared distances and exploit the cancellation caused by coefficients 1+1-2=0.","contentConcepts":["parameter-dependent-algebra","loci-coordinate-constraints"],"skills":["representation-switching","proof-construction"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
{"id":"geometry","description":"Identify the direction of the resulting parallel family of lines relative to C and the midpoint of AB.","contentConcepts":["analytic-curve-geometry","angle-distance-structure"],"skills":["visualization","proof-construction"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
{"id":"boundary","description":"Replace 2 by lambda and separate lambda=2 from lambda != 2, checking when completion of the square gives circles, a point, or no real points.","contentConcepts":["parameter-dependent-algebra","analytic-curve-geometry"],"skills":["case-analysis","precision-checking"],"difficulty":"strong","novelty":"high","abstraction":"moderate"},
{"id":"transfer","description":"Explain the general principle for a weighted sum of squared distances and why the sum of the weights controls whether the quadratic term survives.","contentConcepts":["loci-coordinate-constraints","parameter-dependent-algebra"],"skills":["abstraction","generalization","transfer"],"difficulty":"strong","novelty":"high","abstraction":"high"}],
"commonErrors":[{"id":"assumes-circle","description":"Assumes every fixed-distance expression must give a circle and misses the cancellation at lambda=2."},{"id":"ignores-empty","description":"Completes the square for lambda != 2 but does not check whether the resulting squared radius is nonnegative."}],
"followUps":["What is the normal direction of the lines F(P)=k?","For general weights alpha,beta,gamma, what role does alpha+beta+gamma play?"],
"extensions":[{"id":"three-weight-classification","prompt":"Classify level sets of alpha PA^2+beta PB^2+gamma PC^2 when the three weights are fixed real numbers."},{"id":"zero-level-position","prompt":"Locate the line F(P)=0 explicitly along the median from C to the midpoint of AB."}],
"hints":[
{"text":"Put the midpoint M of AB at the origin, with A=-u, B=u and C=v.","formulations":["center coordinates at the midpoint of AB","use symmetric coordinates for A and B"]},
{"text":"Then PA^2+PB^2=2|p|^2+2|u|^2.","formulations":["the cross terms from A and B cancel","combine the first two squared distances"]},
{"text":"Subtracting 2PC^2 cancels |p|^2 completely, leaving an affine equation in p.","formulations":["the coefficient sum zero removes the quadratic term","F is linear in the coordinates of P"]},
{"text":"With coefficient lambda, the |p|^2 coefficient is 2-lambda; only lambda=2 gives lines.","formulations":["track the coefficient of p squared","lambda equal to two is the phase change"]},
{"text":"When the quadratic coefficient is nonzero, complete the square before deciding whether the level set is a circle, point, or empty.","formulations":["complete the square and inspect the radius squared","do not assume the circle has positive radius"]}],
"canonicalSolution":"Let M, the midpoint of AB, be the origin and write A=-u, B=u, C=v, P=p. Then PA^2+PB^2=|p+u|^2+|p-u|^2=2|p|^2+2|u|^2. Also PC^2=|p-v|^2=|p|^2-2p·v+|v|^2. Hence F(p)=4p·v+2|u|^2-2|v|^2. Because A,B,C are noncollinear, v is nonzero, so F(p)=k is always a line perpendicular to v; all such lines are parallel to AB only when the median CM is perpendicular to AB, otherwise they are perpendicular to CM. For F_lambda=PA^2+PB^2-lambda PC^2, expansion gives (2-lambda)|p|^2+2lambda p·v+2|u|^2-lambda|v|^2. At lambda=2 this is affine. For lambda != 2, completing the square gives a circle equation with a radius-squared depending on k; according to its sign the level set is a circle, one point, or empty. More generally, a weighted sum sum w_i |p-a_i|^2 has quadratic coefficient sum w_i, so zero total weight produces an affine level-set equation while nonzero total weight produces a completed-square circle-type equation.",
"verificationNotes":"Noncollinearity ensures C is not the midpoint of AB, so v != 0 and the lambda=2 level sets are genuine nonempty lines for every k. For lambda != 2 the completed-square equation may have negative radius squared; the family is not guaranteed nonempty for every k. The line normal is CM, not generally AB."
};
export const oxfordEulerWeightedDistanceLevelsSpec=makeEulerSpec(DEFINITION);
export const oxfordEulerWeightedDistanceLevelsEntry=authorCuratedProblem(oxfordEulerWeightedDistanceLevelsSpec);
