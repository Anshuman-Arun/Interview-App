import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerSpec, type EulerFamilyDefinition } from "./oxford-euler-authoring.js";
const DEFINITION: EulerFamilyDefinition = {
"id":"oxford-euler-cube-slice-transition","title":"How a Plane Slices a Cube","category":"geometry",
"topics":["cube cross-sections","coordinate geometry","spatial visualization","parameter regimes"],
"prompt":"Consider the unit cube 0<=x,y,z<=1. For a parameter s with 0<s<3, a plane x+y+z=s cuts the cube. Without plotting software, describe the cross-section as s changes: how many sides it has, where its vertices lie, and what happens at the transition values. For which s is the six-sided cross-section regular?",
"givenInformation":["A cross-section vertex occurs where the plane meets an edge of the cube.","The map (x,y,z) -> (1-x,1-y,1-z) may be useful for comparing s with 3-s."],
"domains":["coordinate-geometry","euclidean-geometry"],"contentConcepts":["spatial-configuration","loci-coordinate-constraints","analytic-curve-geometry"],
"prerequisiteConcepts":["coordinate-geometry-basics","euclidean-geometry-basics","algebraic-manipulation"],
"skills":["visualization","case-analysis","representation-switching","proof-construction","precision-checking","generalization","small-case-exploration","transfer","abstraction"],
"difficulty":{"entry":"introductory","core":"standard","ceiling":"strong"},"novelty":"high","abstraction":"moderate","introducesNewDefinition":false,
"stages":[
{"id":"opening","description":"Sketch or build mentally the sections for s=1/2, 1, and 3/2.","contentConcepts":["spatial-configuration"],"skills":["visualization","small-case-exploration"],"difficulty":"introductory","novelty":"moderate","abstraction":"low"},
{"id":"structure","description":"Find section vertices systematically by intersecting x+y+z=s with cube edges.","contentConcepts":["loci-coordinate-constraints","analytic-curve-geometry"],"skills":["representation-switching","case-analysis"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
{"id":"classification","description":"Show the section is a triangle for 0<s<=1, a hexagon for 1<s<2, and a triangle again for 2<=s<3, treating s=1,2 carefully.","contentConcepts":["spatial-configuration","analytic-curve-geometry"],"skills":["proof-construction","precision-checking"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
{"id":"regularity","description":"For 1<s<2, compute the alternating edge lengths and determine when the hexagon is regular.","contentConcepts":["spatial-configuration","analytic-curve-geometry"],"skills":["proof-construction","precision-checking"],"difficulty":"strong","novelty":"high","abstraction":"moderate"},
{"id":"transfer","description":"Use central reflection to relate s and 3-s and predict analogous sections in a rectangular box.","contentConcepts":["spatial-configuration","loci-coordinate-constraints"],"skills":["generalization","transfer","abstraction"],"difficulty":"strong","novelty":"high","abstraction":"high"}],
"commonErrors":[{"id":"always-hexagon","description":"Assumes every plane through the interior of a cube produces a hexagon."},{"id":"regular-by-symmetry","description":"Calls every middle hexagon regular because its vertices are coordinate permutations, missing alternating side lengths."}],
"followUps":["Why are the sections for s and 3-s congruent?","At s=3/2, can you locate the six vertices without solving six separate systems?"],
"extensions":[{"id":"rectangular-box","prompt":"Replace the unit cube by 0<=x<=a, 0<=y<=b, 0<=z<=c and discuss how the transition parameters depend on a,b,c."},{"id":"section-area","prompt":"Compute the area of the cross-section as a function of s in at least the range 0<s<=1."}],
"hints":[
{"text":"For s<1, the plane meets only the three edges leaving the origin.","formulations":["start with the three coordinate axes edges","small s gives three intercepts"]},
{"text":"For 1<s<2, a vertex has one coordinate 0, one coordinate 1, and the third coordinate s-1.","formulations":["middle vertices are permutations of zero one s minus one","intersect edges with two fixed coordinates"]},
{"text":"At s=1 or s=2, pairs of the six middle-regime vertices coalesce, leaving a triangle.","formulations":["check transition values separately","the hexagon degenerates at one and two"]},
{"text":"In cyclic order, the middle hexagon has alternating side lengths sqrt(2)(s-1) and sqrt(2)(2-s).","formulations":["compute two neighboring edge types","there are two alternating edge lengths"]},
{"text":"Equal alternating lengths require s-1=2-s, so s=3/2.","formulations":["regularity means the two edge types match","solve the midpoint equation for s"]}],
"canonicalSolution":"For 0<s<1, x+y+z=s can meet only the three edges from (0,0,0), giving vertices (s,0,0),(0,s,0),(0,0,s): an equilateral triangle. At s=1 those are the three cube vertices (1,0,0),(0,1,0),(0,0,1), still a triangle. For 1<s<2, every section vertex lies on an edge with one coordinate 0 and another 1; the six vertices are the permutations of (1,s-1,0), giving a hexagon. In cyclic order its side lengths alternate between sqrt(2)(s-1) and sqrt(2)(2-s), so it is regular exactly when s=3/2. At s=2 the six descriptions coalesce pairwise into (1,1,0),(1,0,1),(0,1,1), again a triangle. For 2<s<3, central reflection of the cube maps the section at s to the section at 3-s, so the section remains a triangle shrinking toward (1,1,1).",
"verificationNotes":"At s=1 and s=2 the correct polygon is a triangle, not a six-gon with repeated vertices. For 1<s<2 all six candidate edge intersections have coordinates in [0,1]. The middle hexagon is equiangular by cube/plane symmetry but has alternating edge lengths unless s=3/2. The reflection (x,y,z)->(1-x,1-y,1-z) sends x+y+z=s to x+y+z=3-s."
};
export const oxfordEulerCubeSliceTransitionSpec=makeEulerSpec(DEFINITION);
export const oxfordEulerCubeSliceTransitionEntry=authorCuratedProblem(oxfordEulerCubeSliceTransitionSpec);
