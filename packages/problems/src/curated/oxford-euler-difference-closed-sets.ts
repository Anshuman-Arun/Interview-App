import { authorCuratedProblem } from "../curated-authoring.js";
import { makeEulerCandidateSpec } from "./oxford-euler-authoring.js";

export const oxfordEulerDifferenceClosedSetsSpec = makeEulerCandidateSpec({
  "id":"oxford-euler-difference-closed-sets","title":"Difference-Closed Finite Sets","category":"definitions","topics":["unfamiliar definition","finite sets","differences","classification"],
  "prompt":"Call a finite set S of nonnegative real numbers difference-closed if |x-y| is in S whenever x and y are in S. Explore examples and nonexamples. Classify every difference-closed set with at least two elements, prove your classification, and then ask what changes if ordinary differences x-y must belong to a finite set of real numbers.",
  "givenInformation":["The definition is complete; no standard terminology is assumed.","Because x may equal y, every nonempty difference-closed set contains 0."],
  "domains":["set-theory","logic-proof"],"contentConcepts":["relations-operations","set-relations","logical-structure"],"prerequisiteConcepts":["arithmetic","set-notation","logical-quantifiers"],
  "skills":["definition-exploration","small-case-exploration","pattern-recognition","strategic-simplification","proof-construction","precision-checking","abstraction","generalization","transfer"],"difficulty":{"entry":"warm-up","core":"standard","ceiling":"strong"},"novelty":"high","abstraction":"high","introducesNewDefinition":true,
  "stages":[
    {"id":"examples","description":"Generate small examples and notice equally spaced initial segments such as {0,d,2d,...,nd}.","contentConcepts":["relations-operations"],"skills":["definition-exploration","small-case-exploration","pattern-recognition"],"difficulty":"warm-up","novelty":"high","abstraction":"moderate"},
    {"id":"minimum","description":"Choose the least positive element d and show every element must be an integer multiple of d by repeated subtraction.","contentConcepts":["logical-structure","set-relations"],"skills":["strategic-simplification","proof-construction"],"difficulty":"standard","novelty":"high","abstraction":"high"},
    {"id":"fill-gaps","description":"Use the maximum nd and closure under subtraction by d to force every multiple 0,d,...,nd to appear.","contentConcepts":["relations-operations","set-relations"],"skills":["proof-construction","precision-checking"],"difficulty":"standard","novelty":"high","abstraction":"high"},
    {"id":"converse","description":"Check that every finite equally spaced initial segment is difference-closed, including boundary sizes.","contentConcepts":["logical-structure"],"skills":["precision-checking","proof-construction"],"difficulty":"standard","novelty":"high","abstraction":"high"},
    {"id":"transfer","description":"If a finite real set is closed under the signed operation x-y, prove that only {0} is possible.","contentConcepts":["relations-operations","logical-structure"],"skills":["generalization","transfer","abstraction"],"difficulty":"strong","novelty":"high","abstraction":"high"}
  ],
  "commonErrors":[{"id":"assume-integers","description":"Uses divisibility language without proving that arbitrary real elements are multiples of the minimum positive gap."},{"id":"multiples-not-filled","description":"Shows every element is a multiple of d but forgets to prove no multiples between 0 and the maximum can be missing."}],
  "followUps":["Why does finiteness matter in the minimum-positive-element argument?","Can an infinite difference-closed subset of nonnegative reals fail to be an arithmetic grid?"],
  "extensions":[{"id":"signed-closure","prompt":"Classify finite S subset R satisfying x-y in S for all x,y in S."},{"id":"infinite-counterexamples","prompt":"Find two structurally different infinite difference-closed subsets of the nonnegative reals."}],
  "hints":[
    {"text":"Look at the smallest positive element d.","formulations":["use finiteness to choose a least positive gap","focus on the minimum nonzero member"]},
    {"text":"If x>=d is in S, then x-d is also in S.","formulations":["subtract the smallest positive element repeatedly","closure lets you run a Euclidean-style descent"]},
    {"text":"Repeated subtraction leaves a remainder r with 0<=r<d; minimality forces r=0.","formulations":["every element is a whole-number multiple of d","a positive remainder would contradict minimality"]},
    {"text":"Apply the same subtraction to the maximum element to force all intermediate multiples.","formulations":["walk down from the maximum by d","no multiple below the maximum can be skipped"]},
    {"text":"For signed closure, a nonzero x would force -x, then 2x, then 3x, contradicting finiteness.","formulations":["ordinary subtraction creates unbounded multiples","finite signed-difference closure cannot contain a nonzero element"]}
  ],
  "canonicalSolution":"Let S be finite, difference-closed, and have at least two elements. Since |x-x|=0, 0 is in S. Let d be the least positive member. For any x in S, repeatedly replace x by |x-d|=x-d while x>=d. This stays in S and eventually gives a remainder r with 0<=r<d. By minimality of d, r=0, so x=kd for some nonnegative integer k. Let M=nd be the maximum element. Closure applied repeatedly to M and d gives (n-1)d,(n-2)d,...,0, so S contains every multiple from 0 to nd. Hence S={0,d,2d,...,nd}. Conversely any such set is difference-closed because |id-jd|=|i-j|d is still in the set. For the signed variant, if a finite S subset R is closed under x-y and contains nonzero x, then 0 and -x belong to S, and x-(-x)=2x; inductively nx lies in S for all positive n, impossible. Thus the only finite signed-difference-closed set is {0}.",
  "verificationNotes":"The classification works over nonnegative reals, not only integers. Finiteness supplies both a least positive element and a maximum. The repeated-subtraction step must stop and must remain nonnegative. The singleton {0} is a boundary case excluded only from the first classification prompt for richer examples."
} as const);

export const oxfordEulerDifferenceClosedSetsEntry = authorCuratedProblem(oxfordEulerDifferenceClosedSetsSpec);
