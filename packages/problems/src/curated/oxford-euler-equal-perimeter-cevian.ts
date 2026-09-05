import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerSpec, type EulerFamilyDefinition } from "./oxford-euler-authoring.js";
const DEFINITION: EulerFamilyDefinition = {
"id":"oxford-euler-equal-perimeter-cevian","title":"The Perimeter-Bisecting Cevian","category":"geometry",
"topics":["triangle geometry","perimeters","triangle inequality","existence and uniqueness"],
"prompt":"In a nondegenerate triangle ABC, choose a point D on the side BC so that triangle ABD and triangle ACD have equal perimeters. Does such a point always exist? Is it unique? Locate it using only the side lengths of ABC, and explain all boundary inequalities needed.",
"givenInformation":["D is required to lie on the closed segment BC at first; decide whether it is actually interior.","The shared segment AD appears in both small-triangle perimeters."],
"domains":["euclidean-geometry","algebra"],"contentConcepts":["angle-distance-structure","equations-inequalities"],
"prerequisiteConcepts":["arithmetic","algebraic-manipulation","euclidean-geometry-basics","equations-inequalities"],
"skills":["strategic-simplification","proof-construction","precision-checking","case-analysis","generalization","transfer"],
"difficulty":{"entry":"warm-up","core":"introductory-plus","ceiling":"standard"},"novelty":"moderate","abstraction":"low","introducesNewDefinition":false,
"stages":[
{"id":"opening","description":"Write the two perimeters and identify the common quantity that can be cancelled without finding AD.","contentConcepts":["angle-distance-structure"],"skills":["strategic-simplification"],"difficulty":"warm-up","novelty":"low","abstraction":"low"},
{"id":"structure","description":"Solve the resulting one-variable equation for BD and DC.","contentConcepts":["equations-inequalities"],"skills":["proof-construction"],"difficulty":"introductory-plus","novelty":"moderate","abstraction":"low"},
{"id":"existence","description":"Use both strict triangle inequalities to prove the computed point lies strictly between B and C.","contentConcepts":["equations-inequalities","angle-distance-structure"],"skills":["precision-checking","proof-construction"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
{"id":"uniqueness","description":"Explain why no second point on BC can satisfy the perimeter equality.","contentConcepts":["equations-inequalities"],"skills":["proof-construction","precision-checking"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"},
{"id":"transfer","description":"Reverse the reasoning: characterize when the perimeter-bisecting point is the midpoint and how it shifts as AB-AC changes.","contentConcepts":["angle-distance-structure"],"skills":["generalization","transfer"],"difficulty":"standard","novelty":"moderate","abstraction":"moderate"}],
"commonErrors":[{"id":"tries-ad","description":"Attempts to compute AD with the cosine rule even though AD cancels."},{"id":"misses-interior","description":"Finds an algebraic value for BD but does not prove 0<BD<BC."}],
"followUps":["When is D the midpoint of BC?","If AB is increased while AC and BC stay fixed within the triangle inequalities, which way does D move?"],
"extensions":[{"id":"inverse-side-difference","prompt":"Given BC and the location of D, determine the value of AB-AC required for equal perimeters."},{"id":"degenerate-limit","prompt":"Let the triangle approach degeneracy. Describe where D tends and which strict inequality becomes equality."}],
"hints":[
{"text":"Write Per(ABD)=AB+BD+AD and Per(ACD)=AC+DC+AD.","formulations":["expand both perimeters","the common cevian length appears on both sides"]},
{"text":"Use DC=BC-BD after cancelling AD.","formulations":["replace DC by the remaining part of BC","reduce to one unknown length"]},
{"text":"You should obtain 2BD=AC+BC-AB.","formulations":["isolate BD","the location depends only on the three side lengths"]},
{"text":"To prove BD>0 and DC>0, use AB<AC+BC and AC<AB+BC separately.","formulations":["each endpoint inequality is a triangle inequality","check both strict triangle inequalities"]},
{"text":"D is the midpoint exactly when AB=AC; the sign of AB-AC tells which side gets the longer base segment.","formulations":["compare BD with BC over 2","isosceles symmetry is the midpoint case"]}],
"canonicalSolution":"Equal perimeters give AB+BD+AD=AC+DC+AD, so AB+BD=AC+DC. Since DC=BC-BD, 2BD=AC+BC-AB and BD=(AC+BC-AB)/2. Then DC=(AB+BC-AC)/2. The strict triangle inequalities AB<AC+BC and AC<AB+BC make both expressions positive, hence D is interior. The equation is linear in BD, so the point is unique. Moreover BD-DC=AC-AB, so D is the midpoint exactly when AB=AC; if AB>AC then DC>BD, so D shifts toward B, and vice versa.",
"verificationNotes":"Nondegenerate triangle means all three strict triangle inequalities hold and side lengths are positive. The proof does not use any assumption about acute/obtuse angles. Uniqueness follows from a single solved coordinate along BC. In the degenerate limit AB=AC+BC, BD tends to 0; in the opposite degeneracy AC=AB+BC, DC tends to 0."
};
export const oxfordEulerEqualPerimeterCevianSpec=makeEulerSpec(DEFINITION);
export const oxfordEulerEqualPerimeterCevianEntry=authorCuratedProblem(oxfordEulerEqualPerimeterCevianSpec);
